import type { AssistantSettings } from "./config";
import type { TranscriptEntry } from "./call-logger";
import { buildPromptFromSettings, buildTools, type OpenAITool } from "./prompt";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";

export const LIVE_ENDPOINT = "wss://api.openai.com/v1/live/sessions";

// Voices verified against the real gpt-live-1 API (an unknown voice name is rejected).
export const LIVE_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse",
];
export const DEFAULT_LIVE_VOICE = "marin";

export function liveModel(): string {
  return process.env.LIVE_MODEL ?? "gpt-live-1";
}

export function liveBackendModel(): string {
  return process.env.LIVE_BACKEND_MODEL ?? "gpt-5.6-luna";
}

// The voice model only speaks. It gets the role and business facts, but the tools and the
// knowledge live in the backend, so most of this prompt is about handing work over to it.
const BACKEND_RULES: Record<string, string> = {
  search_knowledge: "the business's own knowledge base (services, prices, opening hours, policies, insurance, staff, anything specific to this business)",
  web_search: "searching the internet for current information",
  get_services: "the list of services",
  get_day_availability: "calendar availability",
  create_calendar_event: "booking appointments",
  create_enquiry: "logging a request for the business owner to follow up",
  end_call: "ending the call",
};

function buildVoiceBackendRules(tools: OpenAITool[], snapshot: PromptSnapshot): string {
  const abilities = [...new Set(tools.map((t) => BACKEND_RULES[t.name]).filter(Boolean))];
  const list = abilities.length > 0 ? `\nThe backend can handle: ${abilities.join("; ")}.` : "";
  return snapshot.text(P.liveBackendRules, { abilities_note: list });
}

// Facts only, no default language: the caller's language decides, not the project setting.
function buildVoiceBusinessContext(settings: AssistantSettings | null, snapshot: PromptSnapshot): string | null {
  const lines: string[] = [];
  if (settings?._project_name) lines.push(`* Business name: ${settings._project_name}`);
  if (settings?._project_industry) lines.push(`* Business type: ${settings._project_industry}`);
  if (settings?._project_description) lines.push(`* Business description: ${settings._project_description}`);
  if (lines.length === 0) return null;
  return `${snapshot.text(P.liveVoiceBusinessContextIntro)}\n\n${lines.join("\n")}`;
}

export function buildLiveVoicePrompt(
  settings: AssistantSettings | null,
  tools: OpenAITool[],
  snapshot: PromptSnapshot = emptySnapshot()
): string {
  const sections = [snapshot.text(P.liveVoiceBase)];
  const context = buildVoiceBusinessContext(settings, snapshot);
  if (context) sections.push(context);
  const instructions = settings?.system_prompt?.trim();
  if (instructions) {
    sections.push(snapshot.text(P.liveVoiceBusinessInstructions, { instructions }));
  }
  sections.push(buildVoiceBackendRules(tools, snapshot), snapshot.text(P.liveVoiceEndingRules));
  return sections.join("\n\n");
}

export function pickLiveVoice(voice: string | null | undefined): string {
  return voice && LIVE_VOICES.includes(voice) ? voice : DEFAULT_LIVE_VOICE;
}

export function buildLiveGreetingInstruction(settings: AssistantSettings | null, snapshot: PromptSnapshot = emptySnapshot()): string | null {
  if (!settings?.greeting_enabled) return null;
  const msg = settings.greeting_message?.trim();
  if (!msg) return null;
  return snapshot.text(P.liveGreetingInstruction, { greeting: msg });
}

export function buildLiveSessionStart(
  settings: AssistantSettings | null,
  callerPhone: string | null,
  snapshot: PromptSnapshot = emptySnapshot()
): { message: Record<string, unknown>; tools: OpenAITool[] } {
  const tools = buildTools(settings, snapshot);
  const businessPrompt = buildPromptFromSettings(settings, callerPhone, { includeGreeting: false }, snapshot);
  const backendInstructions = tools.some((t) => t.name === "end_call")
    ? `${businessPrompt}\n\n${snapshot.text(P.liveBackendEndCallRule)}`
    : businessPrompt;
  const message = {
    type: "session.start",
    event_id: "start_1",
    session: {
      model: liveModel(),
      instructions: buildLiveVoicePrompt(settings, tools, snapshot),
      audio: {
        format: { type: "audio/pcmu", rate: 8000 },
        output: { voice: pickLiveVoice(settings?.voice) },
      },
      delegation: {
        type: "responses",
        responses: {
          model: liveBackendModel(),
          instructions: backendInstructions,
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
