import { WebSocket } from "ws";
import { CallLogger, generateCallSummary, maybeCreatePostCallEnquiry, SmsOptions, TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import type { AssistantSettings } from "./config";
import { logger } from "./logger";
import {
  LIVE_ENDPOINT,
  TranscriptAccumulator,
  buildLiveGreetingInstruction,
  buildLiveSessionStart,
  buildToolResultMessages,
  extractFunctionCall,
} from "./live-protocol";
import { formatOwnerSms } from "./session";
import type { SessionCallbacks, VoiceSession } from "./session-types";
import { sendSmsNotifications } from "./sms";
import { executeTool as defaultExecuteTool } from "./tools";

const START_TIMEOUT_MS = 4000;
// The goodbye may still be streaming when end_call arrives, so wait for a quiet gap
// before asking Twilio to confirm playback, then hang up on the echoed mark.
const END_CALL_IDLE_MS = 1200;
const END_CALL_MARK_FALLBACK_MS = 15000;
// Streaming audio that never goes quiet must not keep the line open: after end_call,
// ask Twilio to confirm playback at the latest this long after the request.
const END_CALL_MAX_WAIT_MS = 6000;
// The caller's own goodbye can be transcribed a moment after end_call arrives, so only
// speech later than this counts as the caller wanting to continue.
const END_CALL_RESUME_GRACE_MS = 1500;

export interface LiveSessionDeps {
  connect?: (url: string, apiKey: string) => WebSocket;
  executeTool?: typeof defaultExecuteTool;
}

function defaultConnect(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export class LiveCallSession implements VoiceSession {
  readonly audioFormat = "mulaw8" as const;

  private ws: WebSocket | null = null;
  private readonly logger: CallLogger;
  private readonly transcript = new TranscriptAccumulator();
  private readonly connect: (url: string, apiKey: string) => WebSocket;
  private readonly runTool: typeof defaultExecuteTool;
  private readonly calendarProjectId: string;
  private started = false;
  private readyAt = 0;
  private firstAudioLogged = false;
  private ended = false;
  private hangupRequested = false;
  private hangupMarkSent = false;
  private pendingEndCallMark: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private hangupRequestedAt = 0;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private finalizePromise: Promise<void> | null = null;
  private embeddingTokens = 0;
  private markStarted: (() => void) | null = null;
  private failStart: ((err: Error) => void) | null = null;

  constructor(
    private readonly settings: AssistantSettings | null,
    private readonly projectId: string | null,
    private readonly callerPhone: string | null,
    twilioCallSid: string | null,
    private readonly callbacks: SessionCallbacks,
    deps: LiveSessionDeps = {}
  ) {
    this.logger = new CallLogger(projectId, twilioCallSid);
    this.logger.transcript = this.transcript.entries;
    this.connect = deps.connect ?? defaultConnect;
    this.runTool = deps.executeTool ?? defaultExecuteTool;
    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const { message } = buildLiveSessionStart(this.settings, this.callerPhone);
    this.logger.openaiPayload = message["session"];

    const connectStartedAt = Date.now();
    logger.info("connecting to OpenAI Live", { project_id: this.projectId ?? "none" });
    const ws = this.connect(LIVE_ENDPOINT, apiKey);
    this.ws = ws;

    const ready = new Promise<void>((resolve, reject) => {
      this.markStarted = resolve;
      this.failStart = reject;
    });
    const timeout = setTimeout(
      () => this.failStart?.(new Error("OpenAI Live session start timed out")),
      START_TIMEOUT_MS
    );

    ws.on("open", () => ws.send(JSON.stringify(message)));
    ws.on("message", (data) => {
      this.handleMessage(data.toString()).catch((e) => logger.error("handleMessage error", { err: e }));
    });
    ws.on("close", (code: number) => {
      this.failStart?.(new Error(`OpenAI Live closed before start (code ${code})`));
      logger.warn("OpenAI Live disconnected", { code });
      if (!this.ended) {
        this.callbacks.sendJson({ type: "error", message: `OpenAI Live disconnected (code ${code})` });
      }
    });
    ws.on("error", (e: Error) => {
      this.failStart?.(e);
      logger.error("OpenAI Live WS error", { err: e });
      this.callbacks.sendJson({ type: "error", message: `OpenAI Live error: ${e.message}` });
    });

    try {
      await ready;
    } finally {
      clearTimeout(timeout);
    }

    logger.info("OpenAI Live session ready", { ms_since_connect: Date.now() - connectStartedAt });
    // Greet first: the model only speaks while input audio is flowing, and every
    // millisecond spent on the database write below is silence for the caller.
    this.sendGreeting();
    // Only create the calls row once Live is confirmed, so a fallback to Standard
    // never leaves a duplicate row behind. createCall never throws.
    await this.logger.createCall(this.callerPhone);
  }

  handleClientAudio(mulawBase64: string): void {
    if (!this.started) return;
    this.send({ type: "session.input_audio.append", audio: mulawBase64 });
  }

  handleTwilioMark(name: string): void {
    if (name !== this.pendingEndCallMark) return;
    this.pendingEndCallMark = null;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    logger.info("end_call goodbye audio confirmed played, hanging up", { markName: name });
    this.callbacks.endCall();
  }

  async abort(): Promise<void> {
    this.ended = true;
    this.clearTimers();
    this.ws?.close();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
    logger.info("session ending, generating summary");
    await this.finalizeOnce();
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendGreeting(): void {
    const greeting = buildLiveGreetingInstruction(this.settings);
    if (!greeting) return;
    logger.info("sending greeting instruction");
    this.send({
      type: "session.instructions.append",
      event_id: "greeting_1",
      delegation_id: null,
      content: greeting,
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg["type"] as string;

    if (type === "session.output_audio.delta") {
      if (!this.firstAudioLogged) {
        this.firstAudioLogged = true;
        logger.info("first assistant audio sent to caller", { ms_since_session_ready: Date.now() - this.readyAt });
      }
      this.callbacks.sendAudio(msg["delta"] as string, "mulaw8");
      if (this.hangupRequested) this.armHangupTimer();
      return;
    }

    if (type === "error") logger.error("OpenAI Live error event", { detail: JSON.stringify(msg) });
    else logger.debug("← live event", { type });

    if (type === "session.started") {
      this.started = true;
      this.readyAt = Date.now();
      this.markStarted?.();
      return;
    }
    if (type === "session.input_transcript.delta") {
      const delta = String(msg["delta"] ?? "");
      this.transcript.addDelta("user", delta);
      if (delta.trim()) this.resumeIfCallerSpeaksAfterHangupRequest();
      return;
    }
    if (type === "session.output_transcript.delta") {
      this.transcript.addDelta("assistant", String(msg["delta"] ?? ""));
      return;
    }
    if (type === "session.closed") {
      logger.info("OpenAI Live session closed", { usage: JSON.stringify(msg["usage"] ?? null) });
      return;
    }

    const call = extractFunctionCall(msg);
    if (call) await this.executeToolCall(call.callId, call.name, call.argumentsJson);
  }

  private async executeToolCall(callId: string, name: string, argsJson: string): Promise<void> {
    logger.info("executing tool", { name });
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson); } catch { /* invalid json from model */ }

    // Feed the shared call logger the same shape it already understands.
    this.logger.handleOpenAIEvent({
      type: "response.function_call_arguments.done",
      call_id: callId,
      name,
      arguments: argsJson,
    });

    if (name === "end_call") {
      logger.info("end_call requested", { reason: String(args["reason"] ?? "conversation complete") });
      this.sendToolResult(callId, { status: "ok" }, false);
      this.hangupRequested = true;
      this.hangupRequestedAt = Date.now();
      // The summary and SMS run when the line actually closes (session.end), so a caller
      // who keeps talking does not get a call that was already finalized.
      this.armHangupTimer();
      this.maxWaitTimer = setTimeout(() => this.sendHangupMark(), END_CALL_MAX_WAIT_MS);
      return;
    }

    const t0 = Date.now();
    const { result, embeddingTokens } = await this.runTool(
      name,
      args,
      this.projectId ?? "",
      this.calendarProjectId,
      this.logger.callId ?? undefined,
      this.settings?.knowledge_top_n ?? 5,
      this.callerPhone
    );
    this.embeddingTokens += embeddingTokens;
    logger.info("tool executed", { name, duration_ms: Date.now() - t0 });
    this.sendToolResult(callId, result, true);
  }

  private sendToolResult(callId: string, result: unknown, continueResponse: boolean): void {
    this.logger.handleClientEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    });
    for (const m of buildToolResultMessages(callId, result, continueResponse)) this.send(m);
  }

  private armHangupTimer(): void {
    if (this.hangupMarkSent) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.sendHangupMark(), END_CALL_IDLE_MS);
  }

  // The caller spoke after end_call was requested: keep the call open instead of cutting them off.
  private resumeIfCallerSpeaksAfterHangupRequest(): void {
    if (!this.hangupRequested || this.ended) return;
    if (Date.now() - this.hangupRequestedAt < END_CALL_RESUME_GRACE_MS) return;
    logger.info("caller spoke after end_call, keeping the call open");
    this.clearTimers();
    this.hangupRequested = false;
    this.hangupMarkSent = false;
    this.pendingEndCallMark = null;
  }

  private sendHangupMark(): void {
    if (this.hangupMarkSent) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.idleTimer = null;
    this.maxWaitTimer = null;
    this.hangupMarkSent = true;
    const markName = `end-call-${Date.now()}`;
    this.pendingEndCallMark = markName;
    this.callbacks.sendMark(markName);
    this.fallbackTimer = setTimeout(() => {
      logger.warn("end_call mark not acknowledged in time, hanging up anyway", { markName });
      this.pendingEndCallMark = null;
      this.callbacks.endCall();
    }, END_CALL_MARK_FALLBACK_MS);
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.idleTimer = null;
    this.fallbackTimer = null;
    this.maxWaitTimer = null;
  }

  private finalizeOnce(): Promise<void> {
    this.finalizePromise ??= this.finalize();
    return this.finalizePromise;
  }

  private async finalize(): Promise<void> {
    this.transcript.flush();
    const apiKey = process.env.OPENAI_API_KEY ?? "";

    const smsOptions: SmsOptions | undefined = this.settings
      ? {
          smsOwnerEnabled: this.settings.sms_owner_enabled ?? false,
          smsCallerEnabled: this.settings.sms_caller_enabled ?? false,
          smsOwnerInstructions: this.settings.sms_owner_instructions ?? null,
          smsCallerInstructions: this.settings.sms_caller_instructions ?? null,
          emailOwnerEnabled: this.settings.email_owner_enabled ?? false,
        }
      : undefined;

    const {
      title, summary, ownerSms, callerSms, emailOwner, summaryInputTokens, summaryOutputTokens,
      shouldCreateEnquiry, enquiryTitle, enquiryDescription,
    } = await generateCallSummary(
      apiKey, this.logger.transcript, smsOptions, this.settings?._project_language ?? null,
      !!this.settings?.capabilities?.["enquiries"]
    );

    await maybeCreatePostCallEnquiry({
      shouldCreate: shouldCreateEnquiry,
      callId: this.logger.callId,
      projectId: this.projectId,
      callerPhone: this.callerPhone,
      enquiryTitle,
      enquiryDescription,
    });

    const ownerSmsFinal = ownerSms
      ? formatOwnerSms(ownerSms, {
          callerPhone: this.callerPhone,
          startMs: this.logger.callStartMs,
          callId: this.logger.callId,
          lang: this.settings?._project_language ?? null,
        })
      : null;

    const { ownerSent, callerSent } = await sendSmsNotifications({
      ownerSms: ownerSmsFinal,
      ownerPhone: this.settings?.owner_phone ?? null,
      callerSms,
      callerPhone: this.callerPhone,
    });

    const tokenUsage: TokenUsage = {
      ...ZERO_TOKEN_USAGE,
      summaryIn: summaryInputTokens,
      summaryOut: summaryOutputTokens,
      searchEmbedding: this.embeddingTokens,
    };

    await this.logger.finalizeCall(title, summary, ownerSent, callerSent, ownerSmsFinal, callerSms, emailOwner, tokenUsage);

    if (this.settings?.email_owner_enabled && emailOwner && this.logger.callId) {
      const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
      fetch(`${base}/api/notify/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: this.logger.callId,
          project_id: this.projectId,
          email_body: emailOwner,
          caller_phone: this.callerPhone,
          ai_title: title,
          duration_seconds: this.logger.callDurationSeconds,
        }),
      }).catch((e) => logger.error("notify/call error", { err: e }));
    }
  }
}
