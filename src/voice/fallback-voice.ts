// LEA-166: a voice with a spare. If the main voice (ElevenLabs) fails, the rest of the call is read by the spare (OpenAI
// Realtime) and the sentences that were not finished yet are read again, so the caller never sits in silence.
import { logger } from "../logger";
import type { VoiceEvents, VoiceProvider } from "./types";

export class FallbackVoice implements VoiceProvider {
  readonly format = "mulaw8" as const;
  get name(): string { return this.active.name; }
  get model(): string { return this.active.model; }
  /** True once the call switched to the spare voice. */
  get usingSpare(): boolean { return this.active !== this.main; }

  private active: VoiceProvider;
  private events: VoiceEvents | null = null;
  private pending = new Map<number, string>(); // sentences not reported as done yet, in order
  private switching = false;

  constructor(private readonly main: VoiceProvider, private readonly makeSpare: () => VoiceProvider) {
    if (main.format !== "mulaw8") throw new Error("the voices must use the same audio format");
    this.active = main;
  }

  async start(events: VoiceEvents): Promise<void> {
    this.events = events;
    const wrapped = (provider: VoiceProvider): VoiceEvents => ({
      onAudio: (audio, id) => { if (provider === this.active) events.onAudio(audio, id); },
      onSentenceDone: (id) => { if (provider === this.active) { this.pending.delete(id); events.onSentenceDone(id); } },
      onUsage: (u) => events.onUsage?.(u),
      onError: (e) => { if (provider === this.main && this.active === this.main) void this.switchToSpare(e); else if (provider === this.active) events.onError(e); },
    });
    this.wrap = wrapped;
    try {
      await this.main.start(wrapped(this.main));
    } catch (e) {
      await this.switchToSpare(e as Error);
    }
  }

  private wrap: ((p: VoiceProvider) => VoiceEvents) | null = null;

  speak(sentenceId: number, text: string): void {
    this.pending.set(sentenceId, text);
    this.active.speak(sentenceId, text);
  }

  cancel(): void {
    this.pending.clear();
    this.active.cancel();
  }

  close(): void {
    this.main.close();
    if (this.active !== this.main) this.active.close();
  }

  private async switchToSpare(reason: Error): Promise<void> {
    if (this.switching || this.active !== this.main || !this.wrap || !this.events) return;
    this.switching = true;
    logger.warn("voice switched to the spare", { event: "voice.fallback", reason: reason.message.slice(0, 160) });
    const spare = this.makeSpare();
    this.main.close();
    this.active = spare;
    try {
      await spare.start(this.wrap(spare));
      for (const [id, text] of this.pending) spare.speak(id, text);
    } catch (e) {
      this.events.onError(e as Error);
    }
  }
}
