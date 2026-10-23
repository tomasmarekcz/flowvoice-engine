import { getSupabaseUrl, getSupabaseHeaders, type AssistantSettings } from "./config";
import { buildEnquiryRules, enquiryDetailsNoteAfterCall, type EnquiryRules } from "./enquiry-rules";
import { logger } from "./logger";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";
import { setLogContext } from "./log/context";

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
      if (this.callId) {
        setLogContext({ call_id: this.callId });
        logger.info("call created", { event: "call.created", call_id: this.callId });
      }
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
    smsSids: { owner: string | null; caller: string | null } = { owner: null, caller: null },
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
          sms_owner_sid: smsSids.owner,
          sms_caller_sid: smsSids.caller,
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
      logger.info("call finalized", { event: "call.finalized", call_id: this.callId, duration_seconds, turns: this.transcript.length });
    } catch (e) {
      logger.error("finalizeCall error", { err: e });
    }
  }
}

// The wording of these defaults lives in the prompt registry (editable in Admin → AI Settings).
const DEFAULT_OWNER_SMS_INSTRUCTIONS = P.defaultOwnerSmsInstructions.default;
const DEFAULT_CALLER_SMS_INSTRUCTIONS = P.defaultCallerSmsInstructions.default;

export { DEFAULT_OWNER_SMS_INSTRUCTIONS, DEFAULT_CALLER_SMS_INSTRUCTIONS };

const LANGUAGE_NAMES: Record<string, string> = { cs: "Czech", en: "English" };

export async function generateCallSummary(
  apiKey: string,
  transcript: TranscriptEntry[],
  smsOptions?: SmsOptions,
  projectLanguage?: string | null,
  enquiryRules: EnquiryRules | null = null,
  snapshot: PromptSnapshot = emptySnapshot()
): Promise<{
  title: string | null; summary: string | null; ownerSms: string | null; callerSms: string | null; emailOwner: string | null;
  summaryInputTokens: number; summaryOutputTokens: number;
  shouldCreateEnquiry: boolean; enquiryTitle: string | null; enquiryDescription: string | null;
  enquiryCustomerName: string | null; enquiryCustomerEmail: string | null;
}> {
  const empty = {
    title: null, summary: null, ownerSms: null, callerSms: null, emailOwner: null,
    summaryInputTokens: 0, summaryOutputTokens: 0,
    shouldCreateEnquiry: false, enquiryTitle: null, enquiryDescription: null,
    enquiryCustomerName: null, enquiryCustomerEmail: null,
  };
  if (!apiKey || transcript.length === 0) return empty;

  const needOwnerSms = !!smsOptions?.smsOwnerEnabled;
  const needCallerSms = !!smsOptions?.smsCallerEnabled;
  const needOwnerEmail = !!smsOptions?.emailOwnerEnabled;

  const ownerInstr = smsOptions?.smsOwnerInstructions?.trim() || snapshot.text(P.defaultOwnerSmsInstructions);
  const callerInstr = smsOptions?.smsCallerInstructions?.trim() || snapshot.text(P.defaultCallerSmsInstructions);

  const smsParts = [
    needOwnerSms ? `\n${snapshot.text(P.summaryOwnerSms, { instructions: ownerInstr })}` : "",
    needCallerSms ? `\n${snapshot.text(P.summaryCallerSms, { instructions: callerInstr })}` : "",
    needOwnerEmail ? `\n${snapshot.text(P.summaryOwnerEmail)}` : "",
  ].join("");

  const enquiryPart = enquiryRules
    ? `\n\n${snapshot.text(P.summaryEnquiryCheck, {
        conditions: enquiryRules.conditions.map((c) => `- ${c}`).join("\n"),
        details_note: enquiryDetailsNoteAfterCall(enquiryRules),
      })}`
    : "";

  const responseShape = `{"title":"…","summary":"…"${needOwnerSms ? ',"owner_sms":"…"' : ""}${needCallerSms ? ',"caller_sms":"…"' : ""}${needOwnerEmail ? ',"owner_email":"…"' : ""}${enquiryRules ? ',"create_enquiry":false,"enquiry_title":"…","enquiry_description":"…","enquiry_customer_name":null,"enquiry_customer_email":null' : ""}}`;

  const languagePart = projectLanguage && LANGUAGE_NAMES[projectLanguage]
    ? snapshot.text(P.summaryLanguageForced, { language: LANGUAGE_NAMES[projectLanguage] })
    : snapshot.text(P.summaryLanguageAuto);

  const systemPrompt = `${snapshot.text(P.summaryHead)}

${languagePart}${smsParts ? "\n\nAlso generate:" + smsParts : ""}${enquiryPart}

${snapshot.text(P.summaryTail, { response_shape: responseShape })}`;

  const lines = transcript
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.text}`)
    .join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: lines.slice(0, 6000) },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "low",
        max_completion_tokens: 2000,
      }),
    });
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as {
      title?: string; summary?: string; owner_sms?: string; caller_sms?: string; owner_email?: string;
      create_enquiry?: boolean; enquiry_title?: string; enquiry_description?: string;
      enquiry_customer_name?: string | null; enquiry_customer_email?: string | null;
    };
    return {
      title: parsed.title ?? null,
      summary: parsed.summary ?? null,
      ownerSms: parsed.owner_sms ?? null,
      callerSms: parsed.caller_sms ?? null,
      emailOwner: parsed.owner_email ?? null,
      summaryInputTokens: data.usage?.prompt_tokens ?? 0,
      summaryOutputTokens: data.usage?.completion_tokens ?? 0,
      shouldCreateEnquiry: enquiryRules ? !!parsed.create_enquiry : false,
      enquiryTitle: parsed.enquiry_title ?? null,
      enquiryDescription: parsed.enquiry_description ?? null,
      enquiryCustomerName: parsed.enquiry_customer_name?.trim() || null,
      enquiryCustomerEmail: parsed.enquiry_customer_email?.trim() || null,
    };
  } catch (e) {
    logger.error("generateCallSummary error", { err: e });
    return empty;
  }
}

// The after-call safety net only runs when the assistant did not create an enquiry during the call, so this is
// asked once, before the summary is generated: when an enquiry already exists the summary does not even mention
// enquiries. Returns the rules the check should follow, or null when no check is needed. If the lookup fails we
// run the check anyway (a possible duplicate is better than a lost enquiry).
export async function prepareEnquiryCheck(
  settings: AssistantSettings | null,
  callId: string | null,
  projectId: string | null
): Promise<EnquiryRules | null> {
  if (!settings?.capabilities?.["enquiries"] || !callId || !projectId) return null;
  try {
    const res = await fetch(
      `${getSupabaseUrl()}/rest/v1/enquiries?call_id=eq.${callId}&select=id&limit=1`,
      { headers: getSupabaseHeaders() }
    );
    const existing = (await res.json()) as Array<{ id: string }>;
    if (Array.isArray(existing) && existing.length > 0) {
      logger.info("post-call enquiry check skipped, enquiry already exists", { call_id: callId });
      return null;
    }
  } catch (e) {
    logger.error("enquiry existence check failed, running the check anyway", { call_id: callId, err: e });
  }
  return buildEnquiryRules(settings);
}

// Creates the enquiry the after-call check asked for. Same data as the live create_enquiry tool; the name and
// email are only what the customer said during the call, because nobody can ask any more.
export async function maybeCreatePostCallEnquiry(opts: {
  shouldCreate: boolean;
  callId: string | null;
  projectId: string | null;
  callerPhone: string | null;
  enquiryTitle: string | null;
  enquiryDescription: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
}): Promise<void> {
  const { shouldCreate, callId, projectId, callerPhone, enquiryTitle, enquiryDescription, customerName, customerEmail } = opts;
  if (!shouldCreate || !callId || !projectId) return;

  try {
    const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
    const res = await fetch(`${base}/api/enquiries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "",
      },
      body: JSON.stringify({
        project_id: projectId,
        call_id: callId,
        title: enquiryTitle ?? "Follow-up needed",
        description: enquiryDescription ?? null,
        customer_phone: callerPhone || "unknown",
        customer_name: customerName ?? null,
        customer_email: customerEmail ?? null,
        status: "new",
      }),
    });
    if (!res.ok) {
      logger.error("post-call enquiry create failed", { call_id: callId, status: res.status });
      return;
    }
    logger.info("post-call enquiry created", { call_id: callId });
  } catch (e) {
    logger.error("maybeCreatePostCallEnquiry error", { err: e });
  }
}
