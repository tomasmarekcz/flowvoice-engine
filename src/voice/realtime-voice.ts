// LEA-164: OpenAI Realtime used purely as a voice. A separate Realtime session (default gpt-realtime-2.1-mini) is given one
// sentence at a time as a text message and reads it aloud as phone-line audio (mu-law 8 kHz, so nothing needs converting).
// OpenAI is retiring its text-to-speech models (6. 1. 2027) and names this model as the replacement. Measured 2. 11. 2026:
// reads the text exactly, first sound ~0.7 s after the text is sent, about 20 audio tokens per second of speech.
import { WebSocket } from "ws";
import { logger } from "../logger";
import { voiceModel } from "../models";
import type { PromptSnapshot } from "../prompts/core";
import { emptySnapshot } from "../prompts/core";
import { ENGINE_PROMPTS as P } from "../prompts/registry";
import type { VoiceEvents, VoiceProvider } from "./types";

const START_TIMEOUT_MS = 6000;

export interface RealtimeVoiceOptions {
  voice: string;
  model?: string;
  snapshot?: PromptSnapshot;
  apiKey?: string;
  connect?: (url: string, apiKey: string) => WebSocket;
}

interface Pending {
  id: number;
  text: string;
}

export class RealtimeVoice implements VoiceProvider {
  readonly format = "mulaw8" as const;
  readonly name = "openai-realtime";
  readonly model: string;

  private ws: WebSocket | null = null;
  private events: VoiceEvents | null = null;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private responseOpen = false; // OpenAI has an unfinished response for `current`
  private dropAudio = false; // the current response was cancelled: its audio is not wanted
  private itemIds: string[] = [];
  private ready = false;
  private readonly snapshot: PromptSnapshot;

  constructor(private readonly options: RealtimeVoiceOptions) {
    this.model = options.model ?? voiceModel();
    this.snapshot = options.snapshot ?? emptySnapshot();
  }

  async start(events: VoiceEvents): Promise<void> {
    this.events = events;
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
    const ws = this.options.connect ? this.options.connect(url, apiKey) : new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.ws = ws;

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("voice session start timed out")), START_TIMEOUT_MS);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: this.snapshot.text(P.voiceSession),
            audio: {
              input: { turn_detection: null },
              output: { format: { type: "audio/pcmu" }, voice: this.options.voice },
            },
          },
        }));
      });
      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg["type"] === "session.updated" && !this.ready) { clearTimeout(timer); this.ready = true; resolve(); this.pump(); }
        this.handle(msg);
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); this.events?.onError(e as Error); });
      ws.on("close", (code: number) => {
        clearTimeout(timer);
        reject(new Error(`voice session closed (code ${code})`));
        if (this.current || this.queue.length > 0) this.events?.onError(new Error(`voice session closed (code ${code})`));
      });
    });
    await ready;
  }

  speak(sentenceId: number, text: string): void {
    this.queue.push({ id: sentenceId, text });
    this.pump();
  }

  cancel(): void {
    this.queue = [];
    if (this.responseOpen && this.ws?.readyState === WebSocket.OPEN) {
      this.dropAudio = true;
      this.ws.send(JSON.stringify({ type: "response.cancel" }));
    } else {
      this.current = null;
    }
  }

  close(): void {
    this.queue = [];
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private pump(): void {
    if (!this.ready || this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next;
    this.responseOpen = true;
    this.dropAudio = false;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: next.text }] } });
    this.send({ type: "response.create", response: { instructions: this.snapshot.text(P.voiceRead) } });
  }

  private handle(msg: Record<string, unknown>): void {
    const type = msg["type"];
    if (type === "response.output_audio.delta") {
      if (this.dropAudio || !this.current) return;
      this.events?.onAudio(String(msg["delta"] ?? ""), this.current.id);
    } else if (type === "conversation.item.done" || type === "conversation.item.added") {
      const id = (msg["item"] as { id?: string } | undefined)?.id;
      if (id && !this.itemIds.includes(id)) this.itemIds.push(id);
    } else if (type === "response.done") {
      const response = msg["response"] as { usage?: { output_token_details?: { audio_tokens?: number }; input_token_details?: { text_tokens?: number } }; status?: string } | undefined;
      const finished = this.current;
      const cancelled = response?.status === "cancelled";
      if (finished && !cancelled) {
        this.events?.onUsage?.({
          audioOutputTokens: response?.usage?.output_token_details?.audio_tokens ?? 0,
          textInputTokens: response?.usage?.input_token_details?.text_tokens ?? 0,
          characters: finished.text.length,
        });
      }
      this.responseOpen = false;
      this.current = null;
      // Keep the voice session's own conversation small: it only ever needs the sentence being read.
      for (const id of this.itemIds) this.send({ type: "conversation.item.delete", item_id: id });
      this.itemIds = [];
      if (finished && !cancelled && !this.dropAudio) this.events?.onSentenceDone(finished.id);
      this.dropAudio = false;
      this.pump();
    } else if (type === "error") {
      const code = (msg["error"] as { code?: string } | undefined)?.code;
      // Cancelling a response that had just finished is harmless.
      if (code === "response_cancel_not_active" || code === "item_delete_invalid_item_id") return;
      logger.error("voice session error", { event: "voice.error", detail: JSON.stringify(msg).slice(0, 400) });
      this.events?.onError(new Error(`voice session error: ${code ?? "unknown"}`));
    }
  }
}
