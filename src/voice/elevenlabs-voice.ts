// LEA-166: ElevenLabs as the voice of the Hybrid and Pipeline engines. Each sentence is one streaming request to
// /v1/text-to-speech/<voice>/stream in the phone line's own format (ulaw_8000), so nothing needs converting. The next
// sentence is requested while the current one still plays and its audio waits its turn, so there is no gap between
// sentences. `previous_text` carries the sentence before it, so the intonation continues.
import { logger } from "../logger";
import { elevenLabsModel } from "../models";
import type { VoiceEvents, VoiceProvider } from "./types";

const FIRST_BYTE_TIMEOUT_MS = 5000;
const MAX_PARALLEL = 2;

export interface ElevenLabsVoiceOptions {
  voiceId: string;
  /** "cs" or "en" when the call's language is known; left out otherwise (the model decides from the text). */
  language?: "cs" | "en" | null;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface Job {
  id: number;
  text: string;
  previous: string | null;
  ctrl: AbortController;
  chunks: string[]; // base64 audio waiting to be sent
  started: boolean;
  done: boolean;
  failed: boolean;
}

export class ElevenLabsVoice implements VoiceProvider {
  readonly format = "mulaw8" as const;
  readonly name = "elevenlabs";
  readonly model: string;

  private events: VoiceEvents | null = null;
  private jobs: Job[] = [];
  private lastText: string | null = null;
  private closed = false;
  private failedOnce = false;

  constructor(private readonly options: ElevenLabsVoiceOptions) {
    this.model = options.model ?? elevenLabsModel();
  }

  async start(events: VoiceEvents): Promise<void> {
    this.events = events;
    if (!(this.options.apiKey ?? process.env.ELEVENLABS_API_KEY)) throw new Error("ELEVENLABS_API_KEY not set");
  }

  speak(sentenceId: number, text: string): void {
    if (this.closed) return;
    this.jobs.push({ id: sentenceId, text, previous: this.lastText, ctrl: new AbortController(), chunks: [], started: false, done: false, failed: false });
    this.lastText = text;
    this.pump();
  }

  cancel(): void {
    for (const job of this.jobs) job.ctrl.abort();
    this.jobs = [];
    this.lastText = null;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  // Start the requests of the first MAX_PARALLEL sentences that have not started yet.
  private pump(): void {
    this.jobs.slice(0, MAX_PARALLEL).forEach((job) => {
      if (!job.started) { job.started = true; void this.run(job); }
    });
  }

  private async run(job: Job): Promise<void> {
    const apiKey = this.options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    const doFetch = this.options.fetchImpl ?? fetch;
    const timer = setTimeout(() => job.ctrl.abort(new Error("no sound from ElevenLabs in time")), FIRST_BYTE_TIMEOUT_MS);
    try {
      const body: Record<string, unknown> = {
        text: job.text,
        model_id: this.model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
      };
      if (this.options.language) body["language_code"] = this.options.language;
      if (job.previous) body["previous_text"] = job.previous;
      const res = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.options.voiceId}/stream?output_format=ulaw_8000`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: job.ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`ElevenLabs answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        if (value && value.length > 0) { job.chunks.push(Buffer.from(value).toString("base64")); this.drain(); }
      }
    } catch (e) {
      if (job.ctrl.signal.aborted && !this.jobs.includes(job)) return; // cancelled on purpose
      job.failed = true;
      if (!this.failedOnce) logger.error("ElevenLabs request failed", { event: "voice.elevenlabs_failed", err: e });
      this.failedOnce = true;
      this.events?.onError(e instanceof Error ? e : new Error(String(e)));
      return;
    } finally {
      clearTimeout(timer);
    }
    job.done = true;
    this.drain();
  }

  // Send the audio of the first sentence; when it is complete, report it and move on to the next one.
  private drain(): void {
    for (;;) {
      const head = this.jobs[0];
      if (!head || head.failed) return;
      while (head.chunks.length > 0) this.events?.onAudio(head.chunks.shift()!, head.id);
      if (!head.done) return;
      this.jobs.shift();
      this.events?.onUsage?.({ audioOutputTokens: 0, textInputTokens: 0, characters: head.text.length });
      this.events?.onSentenceDone(head.id);
      this.pump();
    }
  }
}
