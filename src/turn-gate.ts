// When does what the caller said go to the model? (LEA-196)
//
// The assistant is never interrupted. Everything the caller says is collected here and sent to the model as ONE turn,
// only when it is quiet:
//   - the caller is not talking and no transcript is still on its way,
//   - the assistant is not busy (thinking, producing or playing speech),
//   - and a waiting time has passed that depends on what was said:
//       long speech (more than 1 s of sound)  ending in a full sentence  -> 1 s
//       long speech                           cut off, no full sentence  -> 1.5 s
//       short speech (under 1 s of sound)                                -> 3 s
//   Whatever the caller says meanwhile is added to the same turn, and the waiting starts again.
//
// Speech that starts while the assistant is busy ("over" her) is kept, but it counts as short, whatever its length: the
// caller spoke before the question was finished, so we wait to see whether they say more.
//
// The gate does not look at the words, only at time and sound. Which transcripts are sound at all (low confidence) is
// decided before, in transcript-confidence.ts.

export interface TurnTiming {
  /** Wait after long speech that ends in a full sentence. */
  completeMs: number;
  /** Wait after long speech that stops without a full sentence. */
  fragmentMs: number;
  /** Wait after short speech. */
  shortMs: number;
  /** Speech with at least this much sound is long. */
  longSoundMs: number;
  /** Silence the speech detector waits for before it says "speech stopped"; it is part of the reported length. */
  vadSilenceMs: number;
  /** Audio the detector adds before the speech it found (prefix padding); the reported audio start already includes it. */
  vadPrefixMs: number;
  /** How often the gate looks at the clock. */
  pollMs: number;
  /** A transcript that has not arrived this long after the speech stopped is given up. */
  transcriptTimeoutMs: number;
}

export const TURN_TIMING: TurnTiming = {
  completeMs: 1000,
  fragmentMs: 1500,
  shortMs: 3000,
  longSoundMs: 1000,
  vadSilenceMs: 400,
  vadPrefixMs: 300,
  pollMs: 100,
  transcriptTimeoutMs: 6000,
};

export type TurnKind = "long-complete" | "long-fragment" | "short";

export interface SentTurn {
  kind: TurnKind;
  /** How many separate pieces of speech were joined. */
  pieces: number;
  /** Sound in the pieces that count (speech over the assistant counts 0). */
  soundMs: number;
  /** From the first piece's transcript to the sending. */
  waitedMs: number;
}

export interface HeardInfo {
  /** Length of the sound; Infinity when no speech events came with it (nothing is known). */
  soundMs: number;
  /** The caller started while the assistant was busy. */
  overlap: boolean;
  /** The text was kept for the next turn. */
  held: boolean;
}

export interface GateDeps {
  send: (text: string, info: SentTurn) => void;
  assistantBusy: () => boolean;
  now?: () => number;
  /** Tests move time by hand and call tick() themselves. */
  autoPoll?: boolean;
}

interface Piece { text: string; soundMs: number; overlap: boolean; at: number }
interface Utterance { soundMs: number; overlap: boolean }

const SENTENCE_END = /[.!?…]["')»”]*\s*$/;

export class TurnGate {
  private readonly pieces: Piece[] = [];
  private utterances: Utterance[] = []; // stopped, transcript not here yet
  private speaking = false;
  private startedAt = 0;
  private startedBusy = false;
  private lastStopAt = 0;
  private quietSince = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: GateDeps, private readonly timing: TurnTiming = TURN_TIMING) {
    this.now = deps.now ?? Date.now;
  }

  speechStarted(): void {
    this.dropStaleUtterances(this.now());
    this.speaking = true;
    this.startedAt = this.now();
    this.startedBusy = this.deps.assistantBusy();
    this.quietSince = this.now();
  }

  /** `startMs` / `endMs`: audio times from the speech events (the end includes the detector's silence). */
  speechStopped(audio?: { startMs?: number; endMs?: number }): void {
    const now = this.now();
    this.dropStaleUtterances(now);
    const wall = now - (this.speaking ? this.startedAt : now);
    // The audio times include the detector's padding on both sides; the wall clock only the silence at the end.
    const fromAudio = audio && typeof audio.startMs === "number" && typeof audio.endMs === "number" && audio.endMs >= audio.startMs;
    const soundMs = fromAudio
      ? audio.endMs! - audio.startMs! - this.timing.vadSilenceMs - this.timing.vadPrefixMs
      : wall - this.timing.vadSilenceMs;
    this.utterances.push({ soundMs: Math.max(0, soundMs), overlap: this.speaking && this.startedBusy });
    this.speaking = false;
    this.lastStopAt = now;
    this.quietSince = now;
  }

  /** The transcript of the oldest utterance arrived. `accept` false: it is not to be sent (low confidence, empty). */
  transcript(text: string, accept = true): HeardInfo {
    const u = this.utterances.shift() ?? { soundMs: Infinity, overlap: false };
    const now = this.now();
    this.quietSince = now;
    const clean = text.trim();
    if (!accept || !clean) return { soundMs: u.soundMs, overlap: u.overlap, held: false };
    this.pieces.push({ text: clean, soundMs: u.overlap ? 0 : u.soundMs, overlap: u.overlap, at: now });
    this.startPolling();
    this.tick();
    return { soundMs: u.soundMs, overlap: u.overlap, held: true };
  }

  hasPending(): boolean { return this.pieces.length > 0; }

  dispose(): void {
    this.pieces.length = 0;
    this.utterances = [];
    this.stopPolling();
  }

  /** Looks at the clock: sends the collected speech when it has been quiet long enough. */
  tick(): void {
    if (this.pieces.length === 0) { this.stopPolling(); return; }
    const now = this.now();
    this.dropStaleUtterances(now);
    if (this.speaking || this.utterances.length > 0 || this.deps.assistantBusy()) { this.quietSince = now; return; }
    const { delay, kind, soundMs } = this.plan();
    if (now - this.quietSince < delay) return;
    const pieces = this.pieces.splice(0);
    this.stopPolling();
    this.deps.send(pieces.map((p) => p.text).join(" "), { kind, pieces: pieces.length, soundMs, waitedMs: now - pieces[0].at });
  }

  private plan(): { delay: number; kind: TurnKind; soundMs: number } {
    const soundMs = this.pieces.reduce((sum, p) => sum + p.soundMs, 0);
    if (soundMs < this.timing.longSoundMs) return { delay: this.timing.shortMs, kind: "short", soundMs };
    const last = this.pieces[this.pieces.length - 1].text;
    return SENTENCE_END.test(last)
      ? { delay: this.timing.completeMs, kind: "long-complete", soundMs }
      : { delay: this.timing.fragmentMs, kind: "long-fragment", soundMs };
  }

  private dropStaleUtterances(now: number): void {
    if (this.utterances.length > 0 && !this.speaking && now - this.lastStopAt > this.timing.transcriptTimeoutMs) this.utterances = [];
  }

  private startPolling(): void {
    if (this.deps.autoPoll === false || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.timing.pollMs);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
