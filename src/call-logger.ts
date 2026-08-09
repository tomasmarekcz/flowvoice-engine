import { getSupabaseUrl, getSupabaseHeaders } from "./config";
import { logger } from "./logger";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp_ms: number;
}

interface ToolCallEntry {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
  timestamp_ms: number;
}

interface PendingToolCall {
  name: string;
  args: Record<string, unknown>;
  startMs: number;
}

export interface SmsOptions {
  smsOwnerEnabled: boolean;
  smsCallerEnabled: boolean;
  smsOwnerInstructions: string | null;
  smsCallerInstructions: string | null;
  emailOwnerEnabled: boolean;
}

export interface TokenUsage {
  realtimeAudioIn: number;
  realtimeAudioOut: number;
  realtimeTextIn: number;
  realtimeTextOut: number;
  summaryIn: number;
  summaryOut: number;
  searchEmbedding: number;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  realtimeAudioIn: 0, realtimeAudioOut: 0,
  realtimeTextIn: 0,  realtimeTextOut: 0,
  summaryIn: 0,       summaryOut: 0,
  searchEmbedding: 0,
};

export class CallLogger {
  callId: string | null = null;
  transcript: TranscriptEntry[] = [];
  openaiPayload: unknown = null;

  private projectId: string | null;
  private twilioCallSid: string | null;
  private seq = 0;
  private startMs = Date.now();
  private toolCalls: ToolCallEntry[] = [];
  private pending: Record<string, PendingToolCall> = {};

  get callDurationSeconds(): number {
    return Math.round((Date.now() - this.startMs) / 1000);
  }

  get callStartMs(): number {
    return this.startMs;
  }

  private get enabled(): boolean {
    try { getSupabaseUrl(); getSupabaseHeaders(); return !!this.projectId; }
    catch { return false; }
  }

  constructor(projectId: string | null, twilioCallSid: string | null = null) {
    this.projectId = projectId;
    this.twilioCallSid = twilioCallSid;
  }

  async createCall(callerPhone: string | null): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${getSupabaseUrl()}/rest/v1/calls`, {
        method: "POST",
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          project_id: this.projectId,
          caller_phone: callerPhone ?? null,
          started_at: new Date(this.startMs).toISOString(),
          status: "new",
          transcript: [],
          tool_calls: [],
          twilio_call_sid: this.twilioCallSid ?? null,
        }),
      });
      const rows = (await res.json()) as Array<{ id: string }>;
      this.callId = rows?.[0]?.id ?? null;
      if (this.callId) logger.info("call created", { call_id: this.callId });
      else logger.warn("createCall returned no id", { rows: JSON.stringify(rows) });
    } catch (e) {
      logger.error("createCall error", { err: e });
    }
  }

  logEvent(eventType: string, direction: string, payload: unknown): void {
    if (!this.enabled || !this.callId) return;
    fetch(`${getSupabaseUrl()}/rest/v1/call_events`, {
      method: "POST",
      headers: { ...getSupabaseHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        call_id: this.callId,
        project_id: this.projectId,
        seq: this.seq++,
        timestamp_ms: Date.now(),
        event_type: eventType,
        direction,
        payload,
      }),
    }).catch((e: Error) => logger.error("logEvent error", { err: e }));
  }

  handleOpenAIEvent(msg: Record<string, unknown>): void {
    const t = msg["type"] as string;
    if (
      t === "response.output_audio.delta" ||
      t === "response.output_audio_transcript.delta" ||
      t === "input_audio_buffer.speech_started" ||
      t === "input_audio_buffer.speech_stopped"
    ) return;

    if (t === "response.output_audio_transcript.done" && msg["transcript"]) {
      this.transcript.push({ role: "assistant", text: msg["transcript"] as string, timestamp_ms: Date.now() });
      this.logEvent(t, "inbound", { transcript: msg["transcript"] });
      return;
    }
    if (t === "conversation.item.input_audio_transcription.completed" && msg["transcript"]) {
      this.transcript.push({ role: "user", text: msg["transcript"] as string, timestamp_ms: Date.now() });
      this.logEvent(t, "inbound", { transcript: msg["transcript"] });
      return;
    }
    if (t === "response.function_call_arguments.done") {
      try {
        this.pending[msg["call_id"] as string] = {
          name: msg["name"] as string,
          args: JSON.parse((msg["arguments"] as string) ?? "{}"),
          startMs: Date.now(),
        };
      } catch { /* ignore parse errors */ }
      this.logEvent(t, "inbound", { name: msg["name"], call_id: msg["call_id"], arguments: msg["arguments"] });
      return;
    }
    if (t === "session.created" || t === "session.updated") {
      this.logEvent(t, "inbound", { model: (msg["session"] as Record<string, unknown>)?.["model"] });
      return;
    }
    if (t === "error") this.logEvent(t, "inbound", msg);
  }

  handleClientEvent(msg: Record<string, unknown>): void {
    const t = msg["type"] as string;
    if (t === "input_audio_buffer.append") return;
    if (
      t === "conversation.item.create" &&
      (msg["item"] as Record<string, unknown>)?.["type"] === "function_call_output"
    ) {
      const item = msg["item"] as Record<string, unknown>;
      const callId = item["call_id"] as string;
      const pending = this.pending[callId];
      if (pending) {
        let result: unknown;
        try { result = JSON.parse(item["output"] as string); }
        catch { result = item["output"]; }
        this.toolCalls.push({
          name: pending.name,
          args: pending.args,
          result,
          duration_ms: Date.now() - pending.startMs,
          timestamp_ms: pending.startMs,
        });
        delete this.pending[callId];
      }
    }
  }

  async finalizeCall(
    aiTitle: string | null,
    aiSummary: string | null,
    smsOwnerSent = false,
    smsCallerSent = false,
    smsOwnerText: string | null = null,
    smsCallerText: string | null = null,
    emailOwnerText: string | null = null,
    tokenUsage: TokenUsage = ZERO_TOKEN_USAGE,
  ): Promise<void> {
    if (!this.enabled || !this.callId) return;
    const endMs = Date.now();
    const duration_seconds = Math.round((endMs - this.startMs) / 1000);
    this.logEvent("call.ended", "system", {
      duration_seconds,
      transcript_turns: this.transcript.length,
      tool_calls_count: this.toolCalls.length,
    });
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fetch(`${getSupabaseUrl()}/rest/v1/calls?id=eq.${this.callId}`, {
        method: "PATCH",
        headers: { ...getSupabaseHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({
          ended_at: new Date(endMs).toISOString(),
          duration_seconds,
          billable_minutes: duration_seconds > 0 ? Math.ceil(duration_seconds / 60) : 0,
          transcript: this.transcript,
          tool_calls: this.toolCalls,
          ai_title: aiTitle ?? null,
          ai_summary: aiSummary ?? null,
          openai_payload: this.openaiPayload ?? null,
          sms_owner_sent: smsOwnerSent,
          sms_caller_sent: smsCallerSent,
          sms_owner_text: smsOwnerText ?? null,
          sms_caller_text: smsCallerText ?? null,
          email_owner_text: emailOwnerText ?? null,
          realtime_audio_input_tokens:  tokenUsage.realtimeAudioIn,
          realtime_audio_output_tokens: tokenUsage.realtimeAudioOut,
          realtime_text_input_tokens:   tokenUsage.realtimeTextIn,
          realtime_text_output_tokens:  tokenUsage.realtimeTextOut,
          summary_input_tokens:         tokenUsage.summaryIn,
          summary_output_tokens:        tokenUsage.summaryOut,
          search_embedding_tokens:      tokenUsage.searchEmbedding,
        }),
      });
      logger.info("call finalized", { call_id: this.callId, duration_seconds, turns: this.transcript.length });
    } catch (e) {
      logger.error("finalizeCall error", { err: e });
    }
  }
}

const DEFAULT_OWNER_SMS_INSTRUCTIONS =
  "Summarise who called, what they need, and what action is required.";
const DEFAULT_CALLER_SMS_INSTRUCTIONS =
  "Thank the caller, briefly confirm what was agreed, and say we will be in touch.";

export { DEFAULT_OWNER_SMS_INSTRUCTIONS, DEFAULT_CALLER_SMS_INSTRUCTIONS };

const LANGUAGE_NAMES: Record<string, string> = { cs: "Czech", en: "English" };

export async function generateCallSummary(
  apiKey: string,
  transcript: TranscriptEntry[],
  smsOptions?: SmsOptions,
  projectLanguage?: string | null
): Promise<{ title: string | null; summary: string | null; ownerSms: string | null; callerSms: string | null; emailOwner: string | null; summaryInputTokens: number; summaryOutputTokens: number }> {
  if (!apiKey || transcript.length === 0) return { title: null, summary: null, ownerSms: null, callerSms: null, emailOwner: null, summaryInputTokens: 0, summaryOutputTokens: 0 };

  const needOwnerSms = !!smsOptions?.smsOwnerEnabled;
  const needCallerSms = !!smsOptions?.smsCallerEnabled;
  const needOwnerEmail = !!smsOptions?.emailOwnerEnabled;

  const ownerInstr = smsOptions?.smsOwnerInstructions?.trim() || DEFAULT_OWNER_SMS_INSTRUCTIONS;
  const callerInstr = smsOptions?.smsCallerInstructions?.trim() || DEFAULT_CALLER_SMS_INSTRUCTIONS;

  const smsParts = [
    needOwnerSms
      ? `\n* owner_sms: Write an SMS for the business owner, maximum 300 characters.\n    Follow these instructions: ${ownerInstr}\n    Include only information supported by the conversation. Make the message immediately understandable without requiring the owner to read the transcript.`
      : "",
    needCallerSms
      ? `\n* caller_sms: Write an SMS for the caller, maximum 300 characters.\n    Follow these instructions: ${callerInstr}\n    Write it as a natural message from the business. Include only confirmed information and never invent dates, times, prices, promises, or next steps.`
      : "",
    needOwnerEmail
      ? `\n* owner_email: Write a professional email body for the business owner summarising this call. 2-4 short paragraphs. Cover: who called and why, key details they provided, what was agreed or what needs action. Plain text only — no markdown, no subject line, no greeting/sign-off (those are added by the template). Be direct and informative.`
      : "",
  ].join("");

  const responseShape = `{"title":"…","summary":"…"${needOwnerSms ? ',"owner_sms":"…"' : ""}${needCallerSms ? ',"caller_sms":"…"' : ""}${needOwnerEmail ? ',"owner_email":"…"' : ""}}`;

  const systemPrompt = `You are processing a completed business phone call.

Based only on the conversation, generate:

* title: A clear, specific title of up to 6 words that describes the caller's main reason for calling or the outcome of the call. Prefer concrete details such as the requested service, appointment type, problem, or customer intent. Avoid generic titles such as "Customer call", "General inquiry", or "Phone conversation".
* summary: One concise sentence summarizing the most important information from the call. Include what the caller wanted, any relevant details they provided, and the agreed outcome or next step. Do not include unimportant small talk or repeat information.

${
    projectLanguage && LANGUAGE_NAMES[projectLanguage]
      ? `Write everything in ${LANGUAGE_NAMES[projectLanguage]} — the business's configured language.`
      : "Use the language primarily spoken by the caller."
  }${smsParts ? "\n\nAlso generate:" + smsParts : ""}

Return valid JSON only, with no markdown or additional text:
${responseShape}`;

  const lines = transcript
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.text}`)
    .join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini-2026-03-17",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: lines.slice(0, 6000) },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 2000,
      }),
    });
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as {
      title?: string; summary?: string; owner_sms?: string; caller_sms?: string; owner_email?: string;
    };
    return {
      title: parsed.title ?? null,
      summary: parsed.summary ?? null,
      ownerSms: parsed.owner_sms ?? null,
      callerSms: parsed.caller_sms ?? null,
      emailOwner: parsed.owner_email ?? null,
      summaryInputTokens: data.usage?.prompt_tokens ?? 0,
      summaryOutputTokens: data.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    logger.error("generateCallSummary error", { err: e });
    return { title: null, summary: null, ownerSms: null, callerSms: null, emailOwner: null, summaryInputTokens: 0, summaryOutputTokens: 0 };
  }
}
