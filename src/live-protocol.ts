import type { AssistantSettings } from "./config";
import type { TranscriptEntry } from "./call-logger";
import { buildPromptFromSettings, buildTools, type OpenAITool } from "./prompt";

export const LIVE_ENDPOINT = "wss://api.openai.com/v1/live/sessions";

// Voices verified for gpt-live-1. Extend after checking them with the harness.
export const LIVE_VOICES = ["marin"];
export const DEFAULT_LIVE_VOICE = "marin";

export function liveModel(): string {
  return process.env.LIVE_MODEL ?? "gpt-live-1";
}

export function liveBackendModel(): string {
  return process.env.LIVE_BACKEND_MODEL ?? "gpt-5.6-terra";
}

// Short on purpose: the live model only speaks. The business prompt goes to the backend.
export const LIVE_CONVERSATION_PROMPT = `You are the voice of a professional phone assistant for a business. Speak naturally, warmly and briefly, always in the caller's language, and ask one question at a time. Whenever the caller needs information, an action such as booking, a lookup, or logging a request, or anything you are not certain about, ask the backend for help instead of guessing. Never say an action was completed until the backend confirms it.`;

export function pickLiveVoice(voice: string | null | undefined): string {
  return voice && LIVE_VOICES.includes(voice) ? voice : DEFAULT_LIVE_VOICE;
}

export function buildLiveGreetingInstruction(settings: AssistantSettings | null): string | null {
  if (!settings?.greeting_enabled) return null;
  const msg = settings.greeting_message?.trim();
  if (!msg) return null;
  return `The call has just connected. Speak first. Say exactly this, word for word, then wait for the caller:\n\n"${msg}"`;
}

export function buildLiveSessionStart(
  settings: AssistantSettings | null,
  callerPhone: string | null
): { message: Record<string, unknown>; tools: OpenAITool[] } {
  const tools = buildTools(settings);
  const message = {
    type: "session.start",
    event_id: "start_1",
    session: {
      model: liveModel(),
      instructions: LIVE_CONVERSATION_PROMPT,
      audio: {
        format: { type: "audio/pcmu", rate: 8000 },
        output: { voice: pickLiveVoice(settings?.voice) },
      },
      delegation: {
        type: "responses",
        responses: {
          model: liveBackendModel(),
          instructions: buildPromptFromSettings(settings, callerPhone, { includeGreeting: false }),
          tools,
          tool_choice: tools.length > 0 ? "auto" : "none",
          // One tool call at a time, so a single response.create after each result is always correct.
          parallel_tool_calls: false,
        },
      },
    },
  };
  return { message, tools };
}

export interface LiveFunctionCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export function extractFunctionCall(msg: Record<string, unknown>): LiveFunctionCall | null {
  if (msg["type"] !== "response.event") return null;
  const inner = msg["event"] as Record<string, unknown> | undefined;
  if (!inner || inner["type"] !== "response.output_item.done") return null;
  const item = inner["item"] as Record<string, unknown> | undefined;
  if (!item || item["type"] !== "function_call") return null;
  const callId = item["call_id"];
  const name = item["name"];
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return {
    callId,
    name,
    argumentsJson: typeof item["arguments"] === "string" ? item["arguments"] : "{}",
  };
}

export function buildToolResultMessages(
  callId: string,
  result: unknown,
  continueResponse: boolean
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    {
      type: "response.item.create",
      event_id: `tool_result_${callId}`,
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    },
  ];
  if (continueResponse) {
    messages.push({ type: "response.create", event_id: `continue_${callId}` });
  }
  return messages;
}

export class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  private current: { role: "user" | "assistant"; text: string; startedAt: number } | null = null;

  addDelta(role: "user" | "assistant", delta: string, now: number = Date.now()): void {
    if (!delta) return;
    if (this.current && this.current.role !== role) this.flush();
    if (!this.current) this.current = { role, text: "", startedAt: now };
    this.current.text += delta;
  }

  flush(): void {
    if (!this.current) return;
    const text = this.current.text.trim();
    if (text) {
      this.entries.push({ role: this.current.role, text, timestamp_ms: this.current.startedAt });
    }
    this.current = null;
  }
}
