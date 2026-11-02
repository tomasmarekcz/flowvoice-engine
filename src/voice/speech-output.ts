// LEA-164: everything between "the engine has text" and "the caller hears it": cuts the text into sentences, hands them to the
// voice provider one by one, passes the audio on, and knows how much of it the caller has actually heard (for interruptions).
import type { PlaybackClock } from "../playback-clock";
import { audioDurationMs } from "../quality-tracker";
import { SentenceChunker } from "./sentence-chunker";
import type { VoiceProvider, VoiceUsage } from "./types";

export interface SpeechOutputDeps {
  /** Send audio to the phone line (format as the provider produces it). */
  sendAudio(audio: string, format: "mulaw8" | "pcm24"): void;
  clock: PlaybackClock;
  /** Report a chunk of speech (milliseconds) to the quality measurement. */
  onSpeech?(durationMs: number): void;
  onUsage?(usage: VoiceUsage): void;
  onError?(error: Error): void;
  /** The voice has produced nothing for `stallMs` although it has work: it is stuck. */
  onStall?(): void;
  /** How long a busy voice may stay silent before it counts as stuck (default 3 s). */
  stallMs?: number;
}

interface Sentence {
  id: number;
  text: string;
  done: boolean;
}

const DRAIN_TIMEOUT_MS = 20_000;

export class SpeechOutput {
  private readonly chunker = new SentenceChunker();
  private sentences: Sentence[] = [];
  private nextId = 1;
  private cancelledBelow = 0; // audio of sentences with an id below this was cancelled and is dropped
  private waiters: Array<() => void> = [];
  private firstAudioAt: number | null = null;
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(private readonly voice: VoiceProvider, private readonly deps: SpeechOutputDeps) {}

  start(): Promise<void> {
    return this.voice.start({
      onAudio: (audio, id) => this.handleAudio(audio, id),
      onSentenceDone: (id) => this.handleSentenceDone(id),
      onUsage: (u) => this.deps.onUsage?.(u),
      onError: (e) => this.deps.onError?.(e),
    });
  }

  /** The next piece of an answer that is still being written. */
  pushText(delta: string): void {
    for (const piece of this.chunker.push(delta)) this.enqueue(piece);
  }

  /** The answer is complete. */
  endText(): void {
    for (const piece of this.chunker.flush()) this.enqueue(piece);
    this.chunker.reset();
    this.notifyIfDrained();
  }

  /** Speak a complete text (a greeting). */
  say(text: string): void {
    this.pushText(text);
    this.endText();
  }

  /** Time the first audio of the current answer reached the phone line (ms since epoch), for latency measurement. */
  get firstAudioTime(): number | null { return this.firstAudioAt; }

  /** True while any sentence is still being produced. */
  get busy(): boolean { return this.sentences.some((s) => !s.done); }

  /**
   * Stop speaking now (the caller interrupted). Returns what the caller actually heard: the sentences that had played,
   * and the sentence in progress cut where the playback was.
   */
  cancel(): string {
    const heard = this.heardText();
    this.cancelledBelow = this.nextId;
    this.sentences = [];
    this.chunker.reset();
    this.voice.cancel();
    this.firstAudioAt = null;
    this.clearStall();
    this.release();
    return heard;
  }

  /** Resolves when everything given so far has been produced (not necessarily played). */
  drained(timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(); }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(done);
    });
  }

  close(): void {
    this.clearStall();
    this.voice.close();
    this.release();
  }

  // What has been heard so far, judged by the playback clock.
  heardText(): string {
    const parts: string[] = [];
    for (const s of this.sentences) {
      const state = this.deps.clock.itemState(String(s.id));
      if (!state) break; // not started yet: nothing of it (or of what follows) was heard
      const fraction = Math.min(1, Math.max(0, (this.deps.clock.nowMs() - state.startsAt) / Math.max(1, state.totalMs)));
      if (fraction <= 0) break;
      if (fraction >= 0.98 && s.done) { parts.push(s.text); continue; }
      const cut = s.text.slice(0, Math.floor(s.text.length * fraction));
      const word = cut.replace(/\s+\S*$/, "").trim();
      if (word) parts.push(`${word}…`);
      break;
    }
    return parts.join(" ");
  }

  private enqueue(text: string): void {
    const sentence: Sentence = { id: this.nextId++, text, done: false };
    this.sentences.push(sentence);
    this.voice.speak(sentence.id, text);
    this.watchStall();
  }

  // A voice that has work but gives no sound for a while is stuck (a dropped connection, a stalled provider).
  private watchStall(): void {
    this.clearStall();
    if (!this.deps.onStall || !this.busy) return;
    this.stallTimer = setTimeout(() => { this.stallTimer = null; if (this.busy) this.deps.onStall?.(); }, this.deps.stallMs ?? 3000);
    this.stallTimer.unref?.();
  }

  private clearStall(): void {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
  }

  private handleAudio(audio: string, id: number): void {
    if (id < this.cancelledBelow) return;
    const ms = audioDurationMs(audio, this.voice.format);
    this.deps.clock.audio(String(id), ms);
    this.deps.onSpeech?.(ms);
    if (this.firstAudioAt === null) this.firstAudioAt = Date.now();
    this.deps.sendAudio(audio, this.voice.format);
    this.watchStall();
  }

  private handleSentenceDone(id: number): void {
    const sentence = this.sentences.find((s) => s.id === id);
    if (sentence) sentence.done = true;
    this.watchStall();
    this.notifyIfDrained();
  }

  private notifyIfDrained(): void {
    if (!this.busy) this.release();
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
