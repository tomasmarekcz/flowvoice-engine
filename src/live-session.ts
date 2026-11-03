import { WebSocket } from "ws";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { recordUsage } from "./prompts/store";
import { CallLogger, generateCallSummary, maybeCreatePostCallEnquiry, prepareEnquiryCheck, SmsOptions, TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import type { AssistantSettings } from "./config";
import { logger } from "./logger";
import { CallWatchdog, END_CALL_MARK_FALLBACK_MS, RESUME_GRACE_MS, fixedTexts, maxCallMs, speaksEnglish, withTechnicalNotice, type EndReason } from "./call-ending";
import { fallbackClip } from "./fallback-audio";
import { bindToCurrentContext } from "./log/context";
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
import { CallQualityTracker, audioDurationMs, toolResultFailed } from "./quality-tracker";
import { InputBuffer } from "./input-buffer";
import { isSilentMulaw } from "./audio";
import { sendSmsNotifications, shouldSkipCallSms } from "./sms";
import { bookingMadeFromResult, bookingsForSummary, callerSmsWithConfirmation, confirmedBookingFromResult, type ConfirmedBooking } from "./booking-confirmation";
import { fetchOwnerBookingBlock } from "./owner-booking-block";
import { planTestCallNotifications } from "./test-call";
import { refreshExternalCalendars } from "./ical-refresh";
import { executeTool as defaultExecuteTool } from "./tools";

// How long Live may take to start before the call is answered by Standard instead. It was 4 s; one production call timed out
// at that limit (30. 10. 2026) while staging starts took 1.6 s on average and 2.5 s at most.
const START_TIMEOUT_MS = 6000;
// The goodbye may still be streaming when end_call arrives, so wait for a quiet gap
// before asking Twilio to confirm playback, then hang up on the echoed mark.
const END_CALL_IDLE_MS = 1200;
// Streaming audio that never goes quiet must not keep the line open: after end_call,
// ask Twilio to confirm playback at the latest this long after the request.
const END_CALL_MAX_WAIT_MS = 6000;
// The caller's own goodbye can be transcribed a moment after end_call arrives, so only
// speech later than this counts as the caller wanting to continue.
const MAX_RECONNECTS = 2;
const RECONNECT_TIMEOUT_MS = 6000;
const RESUME_TRANSCRIPT_TURNS = 40;
// A fixed sentence (silence, limit) that is due while the assistant is talking waits for this long at most.
const FIXED_SENTENCE_MAX_WAIT_MS = 8000;

export interface LiveSessionDeps {
  connect?: (url: string, apiKey: string) => WebSocket;
  executeTool?: typeof defaultExecuteTool;
  promptSnapshot?: PromptSnapshot;
}

function defaultConnect(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export class LiveCallSession implements VoiceSession {
  readonly audioFormat = "mulaw8" as const;

  private ws: WebSocket | null = null;
  private readonly logger: CallLogger;
  private readonly quality = new CallQualityTracker((type, payload) => this.logger.logEvent(type, "system", payload));
  private readonly transcript = new TranscriptAccumulator();
  private readonly connect: (url: string, apiKey: string) => WebSocket;
  private readonly runTool: typeof defaultExecuteTool;
  private readonly calendarProjectId: string;
  // Appointments written as already confirmed during this call: the caller gets a confirmation after it (LEA-132).
  private confirmedBookings: ConfirmedBooking[] = [];
  // Any booking (waiting or confirmed) made during this call: the owner's call-summary SMS then carries it (LEA-149).
  private bookingMade = false;
  private started = false;
  private readyAt = 0;
  private firstAudioLogged = false;
  private ended = false;
  // Why the call ended when it was not the caller hanging up (LEA-158/160).
  private endReason: EndReason = "caller";
  private hangupRequested = false;
  private hangupMarkSent = false;
  private pendingEndCallMark: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private hangupRequestedAt = 0;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private finalizePromise: Promise<void> | null = null;
  // Keeping watch over the call and re-making a lost connection (LEA-158/160).
  private watchdog: CallWatchdog | null = null;
  private hangupFinal = false; // a hang-up that the caller speaking can no longer take back (silence, limit, error)
  private startMessage: Record<string, unknown> | null = null;
  private reconnecting = false;
  private resumeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private assistantTail = ""; // the last words the assistant said, to spot a goodbye
  private embeddingTokens = 0;
  private markStarted: (() => void) | null = null;
  private failStart: ((err: Error) => void) | null = null;
  private promptSnapshot: PromptSnapshot = emptySnapshot();
  // The caller's first words arrive before Live has started; they wait here instead of being dropped (LEA-155).
  private readonly inputBuffer = new InputBuffer();

  constructor(
    private readonly settings: AssistantSettings | null,
    private readonly projectId: string | null,
    private readonly callerPhone: string | null,
    private readonly twilioCallSid: string | null,
    private readonly callbacks: SessionCallbacks,
    deps: LiveSessionDeps = {}
  ) {
    this.logger = new CallLogger(projectId, this.twilioCallSid);
    this.logger.transcript = this.transcript.entries;
    this.connect = deps.connect ?? defaultConnect;
    this.runTool = deps.executeTool ?? defaultExecuteTool;
    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";
    // One snapshot of the editable prompts for the whole call (LEA-63), loaded by the session factory.
    this.promptSnapshot = deps.promptSnapshot ?? emptySnapshot();
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    refreshExternalCalendars(this.projectId); // in the background, while the assistant greets (LEA-139)

    const { message } = buildLiveSessionStart(this.settings, this.callerPhone, this.promptSnapshot);
    recordUsage(this.promptSnapshot.usedVersionIds());
    this.logger.openaiPayload = message["session"];
    this.startMessage = message;

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
    this.attachSocket(ws, message);

    try {
      await ready;
    } finally {
      clearTimeout(timeout);
    }

    logger.info("OpenAI Live session ready", { event: "openai.connected", ms_since_connect: Date.now() - connectStartedAt });
    // Greet first: the model only speaks while input audio is flowing, and every
    // millisecond spent on the database write below is silence for the caller.
    this.sendGreeting();
    // Only create the calls row once Live is confirmed, so a fallback to Standard
    // never leaves a duplicate row behind. createCall never throws.
    await this.logger.createCall(this.callerPhone);
    this.watchdog = new CallWatchdog({
      speak: (text) => this.speakFixed(text),
      sayAndHangUp: (text, reason) => this.sayAndHangUp(text, reason),
      hangUp: (reason) => { this.endReason = reason; this.hangupFinal = true; this.sendHangupMark(); },
      texts: fixedTexts(this.settings, this.promptSnapshot),
    }, this.twilioCallSid ? maxCallMs(this.settings) : 24 * 60 * 60_000); // a test call keeps its own time limit
    this.watchdog.start();
  }

  // ─── The connection to OpenAI Live ──────────────────────────────────────────────

  private attachSocket(ws: WebSocket, message: Record<string, unknown>): void {
    // WebSocket callbacks do not inherit async context: bind each to the call's log context.
    ws.on("open", bindToCurrentContext(() => ws.send(JSON.stringify(message))));
    ws.on("message", bindToCurrentContext((data) => {
      if (ws !== this.ws) return; // an old connection
      this.handleMessage(data.toString()).catch((e) => logger.error("handleMessage error", { err: e }));
    }));
    ws.on("close", bindToCurrentContext((code: number) => {
      if (ws !== this.ws) return;
      this.failStart?.(new Error(`OpenAI Live closed before start (code ${code})`));
      logger.warn("OpenAI Live disconnected", { event: "openai.closed", code });
      if (this.ended) return;
      this.resumeWaiter?.reject(new Error(`closed before ready (code ${code})`));
      if (this.started || this.reconnecting) this.onConnectionLost(code);
      else {
        this.quality.disconnected(code);
        this.callbacks.sendJson({ type: "error", message: `OpenAI Live disconnected (code ${code})` });
      }
    }));
    ws.on("error", bindToCurrentContext((e: Error) => {
      if (ws !== this.ws) return;
      this.failStart?.(e);
      logger.error("OpenAI Live WS error", { event: "openai.ws_error", err: e });
      this.callbacks.sendJson({ type: "error", message: `OpenAI Live error: ${e.message}` });
    }));
  }

  // The same session settings, plus what was said so far, so the new session neither greets again nor starts over.
  private resumeMessage(): Record<string, unknown> {
    const base = JSON.parse(JSON.stringify(this.startMessage)) as { session: { instructions: string; delegation: { responses: { instructions: string } } } };
    const turns = this.transcript.entries.slice(-RESUME_TRANSCRIPT_TURNS)
      .map((t) => `${t.role === "user" ? "Caller" : "Assistant"}: ${t.text}`).join("\n");
    const note = `===CALL IN PROGRESS===\nThe connection dropped for a moment and was restored. The call is already under way: do NOT greet again and do not start over. This is what was said so far:\n${turns || "(nothing yet)"}\nContinue naturally from the last thing said.`;
    base.session.instructions += `\n\n${note}`;
    base.session.delegation.responses.instructions += `\n\n${note}`;
    return base as unknown as Record<string, unknown>;
  }

  private onConnectionLost(code: number): void {
    this.quality.disconnected(code);
    this.callbacks.sendJson({ type: "error", message: `OpenAI Live disconnected (code ${code})` });
    if (this.reconnecting) return;
    void this.recoverConnection();
  }

  // The connection dropped in the middle of the call: say so, make it again (twice at most), and if that fails apologise and hang up.
  private async recoverConnection(): Promise<void> {
    this.reconnecting = true;
    this.started = false; // the caller's words wait in the buffer until the new session is ready
    this.watchdog?.suspend(true);
    this.playClip("wait");
    for (let attempt = 1; attempt <= MAX_RECONNECTS && !this.ended; attempt++) {
      try {
        await this.reconnectOnce();
        this.reconnecting = false;
        this.quality.reconnected();
        logger.info("OpenAI Live connection restored", { event: "openai.reconnected", attempt });
        this.watchdog?.suspend(false);
        this.speakFixed(fixedTexts(this.settings, this.promptSnapshot).reconnected);
        return;
      } catch (e) {
        logger.warn("OpenAI Live reconnect failed", { event: "openai.reconnect_failed", attempt, err: e });
        try { this.ws?.close(); } catch { /* already closed */ }
      }
    }
    if (this.ended) return;
    this.reconnecting = false;
    this.endReason = "technical_error";
    this.hangupFinal = true;
    this.watchdog?.stop();
    this.playClip("apology");
    this.hangupRequested = true;
    this.sendHangupMark();
  }

  private reconnectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.resumeWaiter = null; reject(new Error("reconnect timed out")); }, RECONNECT_TIMEOUT_MS);
      this.resumeWaiter = {
        resolve: () => { clearTimeout(timer); this.resumeWaiter = null; resolve(); },
        reject: (e) => { clearTimeout(timer); this.resumeWaiter = null; reject(e); },
      };
      const ws = this.connect(LIVE_ENDPOINT, process.env.OPENAI_API_KEY ?? "");
      this.ws = ws;
      this.attachSocket(ws, this.resumeMessage());
    });
  }

  /** Plays a recorded sentence on the phone line (Live always speaks the phone's own format). */
  private playClip(kind: "wait" | "apology"): void {
    const lang = speaksEnglish(this.settings) ? "en" : "cs";
    const clip = fallbackClip(kind, lang);
    if (clip) this.callbacks.sendAudio(clip, "mulaw8");
  }

  // ─── Fixed sentences (LEA-160) ──────────────────────────────────────────────────

  /** Makes the voice say exactly this sentence; if the assistant is talking right now it waits for a pause. */
  private speakFixed(text: string, waited = 0): void {
    if (this.ended || this.reconnecting) return;
    if (this.watchdog?.assistantBusy() && waited < FIXED_SENTENCE_MAX_WAIT_MS) {
      setTimeout(() => this.speakFixed(text, waited + 500), 500);
      return;
    }
    this.send({
      type: "session.instructions.append",
      event_id: `fixed_${Date.now()}`,
      delegation_id: null,
      content: `SPEAK NOW: say exactly this sentence to the caller, word for word, once, and nothing else, then wait for the caller:\n\n"${text}"`,
    });
    this.send({ type: "response.create", event_id: `fixed_response_${Date.now()}` });
  }

  /** Says a sentence, then hangs up once it has been heard (silence, call-length limit). The caller cannot take it back. */
  private sayAndHangUp(text: string, reason: EndReason): void {
    if (this.ended) return;
    this.endReason = reason;
    this.hangupFinal = true;
    this.hangupRequested = true;
    this.hangupRequestedAt = Date.now();
    this.speakFixed(text);
    // The quiet-gap timer is armed by the sentence's own audio (see the audio handler); this is the backstop.
    this.maxWaitTimer = setTimeout(() => this.sendHangupMark(), FIXED_SENTENCE_MAX_WAIT_MS + END_CALL_MAX_WAIT_MS);
  }

  handleClientAudio(mulawBase64: string): void {
    if (!this.started) {
      this.inputBuffer.push(mulawBase64);
      return;
    }
    this.send({ type: "session.input_audio.append", audio: mulawBase64 });
  }

  noteInboundFrame(timestampMs: number, levelDbfs: number): void {
    this.quality.inboundFrame(timestampMs, levelDbfs);
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
    const greeting = buildLiveGreetingInstruction(this.settings, this.promptSnapshot);
    if (!greeting) return;
    logger.info("sending greeting instruction");
    this.send({
      type: "session.instructions.append",
      event_id: "greeting_1",
      delegation_id: null,
      content: greeting,
    });
    // Appending instructions alone does not make the model talk: without this it stayed
    // silent until the caller spoke first.
    this.send({ type: "response.create", event_id: "greeting_response" });
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
      // Live streams audio all the time, silent frames between sentences included (measured, LEA-155). Only real speech
      // counts as the assistant talking, for the quality numbers and for the "goodbye has gone quiet" hang-up timer.
      const speech = !isSilentMulaw(String(msg["delta"] ?? ""));
      if (speech) {
        const ms = audioDurationMs(String(msg["delta"] ?? ""), "mulaw8");
        this.quality.assistantAudio(ms);
        this.watchdog?.assistantAudio(ms);
      }
      this.callbacks.sendAudio(msg["delta"] as string, "mulaw8");
      if (speech && this.hangupRequested) this.armHangupTimer();
      return;
    }

    if (type === "error") logger.error("OpenAI Live error event", { detail: JSON.stringify(msg) });
    else logger.debug("← live event", { type });

    if (type === "session.started") {
      this.started = true;
      this.resumeWaiter?.resolve();
      this.readyAt = Date.now();
      for (const frame of this.inputBuffer.drain()) this.send({ type: "session.input_audio.append", audio: frame });
      this.markStarted?.();
      return;
    }
    if (type === "session.input_transcript.delta") {
      const delta = String(msg["delta"] ?? "");
      this.transcript.addDelta("user", delta);
      this.quality.callerTextDelta(delta);
      if (delta.trim()) {
        this.assistantTail = "";
        this.watchdog?.callerSpoke();
        this.resumeIfCallerSpeaksAfterHangupRequest();
      }
      return;
    }
    if (type === "session.output_transcript.delta") {
      const said = String(msg["delta"] ?? "");
      this.transcript.addDelta("assistant", said);
      this.assistantTail = (this.assistantTail + said).slice(-80);
      this.watchdog?.assistantSaid(this.assistantTail);
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
      this.watchdog?.suspend(true);
      // The summary and SMS run when the line actually closes (session.end), so a caller
      // who keeps talking does not get a call that was already finalized.
      this.armHangupTimer();
      this.maxWaitTimer = setTimeout(() => this.sendHangupMark(), END_CALL_MAX_WAIT_MS);
      return;
    }

    const t0 = Date.now();
    this.quality.toolStarted();
    this.watchdog?.toolStarted();
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
    this.quality.toolFinished(name, Date.now() - t0, toolResultFailed(result));
    this.watchdog?.toolFinished();
    if (name === "create_calendar_event") {
      const booking = confirmedBookingFromResult(result);
      if (booking) this.confirmedBookings.push(booking);
      if (bookingMadeFromResult(result)) this.bookingMade = true;
    }
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
    if (!this.hangupRequested || this.ended || this.hangupFinal) return;
    if (Date.now() - this.hangupRequestedAt < RESUME_GRACE_MS) return;
    logger.info("caller spoke after end_call, keeping the call open");
    this.clearHangupTimers();
    this.hangupRequested = false;
    this.hangupMarkSent = false;
    this.pendingEndCallMark = null;
    this.watchdog?.suspend(false);
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
    this.watchdog?.stop();
    this.clearHangupTimers();
  }

  private clearHangupTimers(): void {
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

    const skipSms = shouldSkipCallSms(this.logger.callDurationSeconds, this.logger.transcript);
    if (skipSms) logger.info("skipping SMS: short call or caller said nothing", { seconds: this.logger.callDurationSeconds });

    // A test call from the QR code: the first one really sends the owner's SMS and e-mail, later ones only write them
    // into the call detail (same rules as the Standard session).
    const technicalEnd = this.endReason === "technical_error";
    const { testCall, plan } = await planTestCallNotifications(this.twilioCallSid, this.projectId, this.logger.callId, skipSms);

    const smsOptions: SmsOptions | undefined = this.settings
      ? {
          smsOwnerEnabled: (!skipSms || technicalEnd) && (plan.forceGenerate || (this.settings.sms_owner_enabled ?? false)),
          smsCallerEnabled: !skipSms && (this.settings.sms_caller_enabled ?? false),
          smsOwnerInstructions: this.settings.sms_owner_instructions ?? null,
          smsCallerInstructions: this.settings.sms_caller_instructions ?? null,
          emailOwnerEnabled: plan.forceGenerate || (this.settings.email_owner_enabled ?? false),
          confirmedBookings: this.confirmedBookings.length > 0 ? bookingsForSummary(this.confirmedBookings, this.settings._calendar_timezone ?? "Europe/Prague") : null,
        }
      : undefined;

    const enquiryRules = await prepareEnquiryCheck(this.settings, this.logger.callId, this.projectId);

    const {
      title, summary, ownerSms: ownerSmsRaw, callerSms, emailOwner: emailOwnerRaw, summaryInputTokens, summaryOutputTokens,
      shouldCreateEnquiry, enquiryTitle, enquiryDescription, enquiryCustomerName, enquiryCustomerEmail,
    } = await generateCallSummary(
      apiKey, this.logger.transcript, smsOptions, this.settings?._project_language ?? null,
      enquiryRules, this.promptSnapshot
    );
    recordUsage(this.promptSnapshot.usedVersionIds());
    // LEA-158/160: a call cut short by a technical problem says so in the notifications the owner already gets.
    const { ownerSms, emailOwner } = withTechnicalNotice({
      technical: technicalEnd, ownerSms: ownerSmsRaw, emailOwner: emailOwnerRaw,
      ownerEnabled: !!this.settings?.sms_owner_enabled, emailEnabled: !!this.settings?.email_owner_enabled, lang: this.settings?._project_language ?? null,
    });

    await maybeCreatePostCallEnquiry({
      shouldCreate: shouldCreateEnquiry,
      callId: this.logger.callId,
      projectId: this.projectId,
      callerPhone: this.callerPhone,
      enquiryTitle,
      enquiryDescription,
      customerName: enquiryCustomerName,
      customerEmail: enquiryCustomerEmail,
    });

    const bookingBlock = ownerSms && this.bookingMade ? await fetchOwnerBookingBlock(this.logger.callId, this.projectId) : null;
    const ownerSmsFinal = ownerSms
      ? formatOwnerSms(ownerSms, {
          callerPhone: this.callerPhone,
          startMs: this.logger.callStartMs,
          callId: this.logger.callId,
          lang: this.settings?._project_language ?? null,
          booking: bookingBlock,
        technicalError: technicalEnd,
        })
      : null;

    // LEA-132: a booking written as confirmed always reaches the caller as a confirmation: inside the SMS the AI writes
    // when the owner has the caller SMS on, otherwise as a short fixed SMS.
    const callerSmsFinal = callerSmsWithConfirmation(
      callerSms,
      this.confirmedBookings,
      {
        business: this.settings?._project_name ?? null,
        timezone: this.settings?._calendar_timezone ?? "Europe/Prague",
        language: this.settings?._project_language ?? null,
      },
      this.promptSnapshot
    );

    const { ownerSent, callerSent, ownerSid, callerSid } = await sendSmsNotifications({
      ownerSms: plan.send ? ownerSmsFinal : null,
      ownerPhone: this.settings?.owner_phone ?? null,
      // A test call never texts the number the owner typed: that is their own phone, and nobody asked for the SMS.
      callerSms: plan.send && !testCall ? callerSmsFinal : null,
      callerPhone: this.callerPhone,
    });

    const tokenUsage: TokenUsage = {
      ...ZERO_TOKEN_USAGE,
      summaryIn: summaryInputTokens,
      summaryOut: summaryOutputTokens,
      searchEmbedding: this.embeddingTokens,
    };

    await this.logger.finalizeCall(title, summary, ownerSent, callerSent, ownerSmsFinal, callerSmsFinal, emailOwner, tokenUsage, { owner: ownerSid, caller: callerSid });
    await this.logger.saveQuality(this.quality.finish());
    if (this.endReason !== "caller") await this.logger.saveEndReason(this.endReason);

    if (plan.send && (plan.forceGenerate || this.settings?.email_owner_enabled) && emailOwner && this.logger.callId) {
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
          first_test_call: testCall && plan.send,
        }),
      }).catch((e) => logger.error("notify/call error", { err: e }));
    }
  }
}
