import { WebSocket } from "ws";
import { CallLogger, generateCallSummary, maybeCreatePostCallEnquiry, prepareEnquiryCheck, SmsOptions, TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import { loadAssistantSettings, AssistantSettings } from "./config";
import { logger } from "./logger";
import { bindToCurrentContext } from "./log/context";
import { buildPromptFromSettings, buildTools } from "./prompt";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { getSnapshot, recordUsage } from "./prompts/store";
import { executeTool } from "./tools";
import { sendSmsNotifications, shouldSkipCallSms } from "./sms";
import { bookingMadeFromResult, bookingsForSummary, callerSmsWithConfirmation, confirmedBookingFromResult, type ConfirmedBooking } from "./booking-confirmation";
import { fetchOwnerBookingBlock, type OwnerBookingBlock } from "./owner-booking-block";
import { planTestCallNotifications } from "./test-call";
import { refreshExternalCalendars } from "./ical-refresh";
import type { AudioFormat, SessionCallbacks, VoiceSession } from "./session-types";
import { CallQualityTracker, audioDurationMs, toolResultFailed } from "./quality-tracker";
import { PlaybackClock } from "./playback-clock";
import { InputBuffer } from "./input-buffer";

export function formatOwnerSms(
  rawSummary: string,
  opts: { callerPhone: string | null; startMs: number; callId: string | null; lang: string | null; booking?: OwnerBookingBlock | null }
): string {
  const isCs = opts.lang === "cs";
  // LEA-149: a call that made a booking is one notice: the heading says so and the booking follows the summary.
  const header = opts.booking ? `🆕 ${opts.booking.heading}` : isCs ? "🆕 Nová konverzace" : "🆕 New conversation";
  const time = new Intl.DateTimeFormat(isCs ? "cs-CZ" : "en-US", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
  }).format(opts.startMs);
  const phoneLine = `📞 ${opts.callerPhone ?? (isCs ? "neznámé číslo" : "unknown number")} • ${time}`;

  const lines = [header, phoneLine, rawSummary, ...(opts.booking?.lines ?? [])];
  if (opts.callId) {
    const base = process.env.PUBLIC_APP_URL ?? "https://leadoro.io";
    lines.push(`🔗 ${base}/conversations/${opts.callId}`);
  }
  return lines.join("\n");
}

export type { SessionCallbacks } from "./session-types";

// If Twilio never echoes back the mark confirming the goodbye audio finished
// playing (e.g. a dropped Twilio WS event), don't leave the call hanging open.
const END_CALL_MARK_FALLBACK_MS = 15000;

export interface CallSessionOptions {
  /** Set by the session factory when Live could not start and this call runs on Standard instead (LEA-154). */
  fallbackReason?: string;
  /** Audio format spoken with OpenAI: "pcmu" = the phone line's own format, no conversion (LEA-155); default PCM 24 kHz. */
  audio?: "pcmu" | "pcm24";
}

export class CallSession implements VoiceSession {
  readonly audioFormat: AudioFormat;
  private projectId: string | null;
  private callerPhone: string | null;
  private twilioCallSid: string | null;
  private callbacks: SessionCallbacks;
  private openaiWs: WebSocket | null = null;
  private logger: CallLogger;
  private quality = new CallQualityTracker((type, payload) => this.logger.logEvent(type, "system", payload));
  private calendarProjectId = "admin-test";
  // Appointments written as already confirmed during this call: the caller gets a confirmation after it (LEA-132).
  private confirmedBookings: ConfirmedBooking[] = [];
  // Any booking (waiting or confirmed) made during this call: the owner's call-summary SMS then carries it (LEA-149).
  private bookingMade = false;
  private ended = false;
  private settings: AssistantSettings | null = null;
  private promptSnapshot: PromptSnapshot = emptySnapshot();
  private pendingEndCallMark: string | null = null;
  private endCallFallbackTimer: NodeJS.Timeout | null = null;
  // What the caller has heard, and the barge-in state (LEA-155).
  private readonly clock = new PlaybackClock();
  private dropAudio = false;
  // The caller's audio waits here until OpenAI has accepted the session settings (its default format is not ours).
  private readonly inputBuffer = new InputBuffer();
  private listening = false;
  private usageAccum = {
    realtimeAudioIn: 0, realtimeAudioOut: 0,
    realtimeTextIn: 0,  realtimeTextOut: 0,
    searchEmbedding: 0,
  };

  constructor(
    projectId: string | null,
    callerPhone: string | null,
    twilioCallSid: string | null,
    callbacks: SessionCallbacks,
    private preloadedSettings?: AssistantSettings | null,
    private preloadedSnapshot?: PromptSnapshot,
    private readonly options: CallSessionOptions = {}
  ) {
    this.audioFormat = options.audio === "pcmu" ? "mulaw8" : "pcm24";
    this.projectId = projectId;
    this.callerPhone = callerPhone;
    this.twilioCallSid = twilioCallSid;
    this.callbacks = callbacks;
    this.logger = new CallLogger(projectId, twilioCallSid);
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    refreshExternalCalendars(this.projectId); // in the background, while the assistant greets (LEA-139)

    // The call row is written while the connection to OpenAI is being made, not before it (LEA-155).
    const callCreated = this.logger.createCall(this.callerPhone);
    const [settings, promptSnapshot] = await Promise.all([
      this.preloadedSettings !== undefined ? this.preloadedSettings : loadAssistantSettings(this.projectId),
      this.preloadedSnapshot ?? getSnapshot(),
    ]);
    // One snapshot of the editable prompts for the whole call (LEA-63); falls back to the code defaults on any problem.
    this.promptSnapshot = promptSnapshot;
    if (this.options.fallbackReason) callCreated.then(() => this.quality.markFallback(this.options.fallbackReason!));

    this.settings = settings;
    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";

    const instructions = buildPromptFromSettings(settings, this.callerPhone, {}, this.promptSnapshot);
    const tools = buildTools(settings, this.promptSnapshot);
    recordUsage(this.promptSnapshot.usedVersionIds());
    const voice = settings?.voice ?? "alloy";

    this.logger.openaiPayload = { model: "gpt-realtime-2", voice, instructions, tools };
    const audioFormat = this.options.audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 };

    logger.info("connecting to OpenAI", { project_id: this.projectId ?? "none" });

    const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.openaiWs = openaiWs;

    // WebSocket callbacks do not inherit async context: bind each to the call's log context.
    openaiWs.on("open", bindToCurrentContext(() => {
      logger.info("OpenAI connected, sending session.update", { event: "openai.connected" });
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions,
          tools,
          tool_choice: tools.length > 0 ? "auto" : "none",
          audio: {
            input: {
              format: audioFormat,
              transcription: { model: "gpt-4o-transcribe" },
              // Filters background noise (a TV, the street) before it can count as speech and cut the assistant off.
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.8,
                prefix_padding_ms: 300,
                silence_duration_ms: 400,
              },
            },
            output: { format: audioFormat, voice },
          },
        },
      }));
      // The call id exists once the row is written; the client is told then, with the connection already up.
      callCreated.then(() => this.callbacks.sendJson({
        type: "proxy.connected",
        calendar_project_id: this.calendarProjectId,
        call_id: this.logger.callId,
        // The engine tells the client when to stop playing (engine.clear_audio); it need not guess from speech_started.
        barge_in: "engine",
      }));
    }));

    openaiWs.on("message", bindToCurrentContext((data) => {
      this.handleOpenAIMessage(data.toString()).catch((e) =>
        logger.error("handleOpenAIMessage error", { err: e })
      );
    }));

    openaiWs.on("close", bindToCurrentContext((code) => {
      logger.warn("OpenAI disconnected", { event: "openai.closed", code });
      if (!this.ended) {
        this.quality.disconnected(code);
        this.callbacks.sendJson({ type: "error", message: `OpenAI disconnected (code ${code})` });
      }
    }));

    openaiWs.on("error", bindToCurrentContext((e) => {
      logger.error("OpenAI WS error", { event: "openai.ws_error", err: e });
      this.callbacks.sendJson({ type: "error", message: `OpenAI error: ${e.message}` });
    }));
  }

  handleClientAudio(audioBase64: string): void {
    if (!this.listening) {
      // OpenAI has not accepted our audio format yet: keep the first words of the caller instead of losing them.
      this.inputBuffer.push(audioBase64);
      return;
    }
    this.sendInputAudio(audioBase64);
  }

  private sendInputAudio(audioBase64: string): void {
    if (this.openaiWs?.readyState !== WebSocket.OPEN) return;
    this.openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audioBase64 }));
  }

  noteInboundFrame(timestampMs: number, levelDbfs: number): void {
    this.quality.inboundFrame(timestampMs, levelDbfs);
  }

  handleClientEvent(msg: Record<string, unknown>): void {
    if (this.openaiWs?.readyState !== WebSocket.OPEN) return;
    this.openaiWs.send(JSON.stringify(msg));
    this.logger.handleClientEvent(msg);
  }

  // Twilio echoes a "mark" event back once it has actually finished playing
  // all audio queued before that mark — used to confirm the end_call goodbye
  // was fully heard before we close the connection.
  handleTwilioMark(name: string): void {
    if (name !== this.pendingEndCallMark) return;
    this.pendingEndCallMark = null;
    if (this.endCallFallbackTimer) {
      clearTimeout(this.endCallFallbackTimer);
      this.endCallFallbackTimer = null;
    }
    logger.info("end_call goodbye audio confirmed played, hanging up", { markName: name });
    this.callbacks.endCall();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    logger.info("session ending, generating summary", { event: "call.ending" });
    if (this.openaiWs?.readyState === WebSocket.OPEN) this.openaiWs.close();
    const apiKey = process.env.OPENAI_API_KEY ?? "";

    const skipSms = shouldSkipCallSms(this.logger.callDurationSeconds, this.logger.transcript);
    if (skipSms) logger.info("skipping SMS: short call or caller said nothing", { seconds: this.logger.callDurationSeconds });

    const { testCall, plan } = await planTestCallNotifications(this.twilioCallSid, this.projectId, this.logger.callId, skipSms);

    const smsOptions: SmsOptions | undefined = this.settings
      ? {
          smsOwnerEnabled: !skipSms && (plan.forceGenerate || (this.settings.sms_owner_enabled ?? false)),
          smsCallerEnabled: !skipSms && (this.settings.sms_caller_enabled ?? false),
          smsOwnerInstructions: this.settings.sms_owner_instructions ?? null,
          smsCallerInstructions: this.settings.sms_caller_instructions ?? null,
          emailOwnerEnabled: !skipSms && (plan.forceGenerate || (this.settings.email_owner_enabled ?? false)),
          confirmedBookings: this.confirmedBookings.length > 0 ? bookingsForSummary(this.confirmedBookings, this.settings._calendar_timezone ?? "Europe/Prague") : null,
        }
      : undefined;

    const enquiryRules = await prepareEnquiryCheck(this.settings, this.logger.callId, this.projectId);

    const {
      title, summary, ownerSms, callerSms, emailOwner, summaryInputTokens, summaryOutputTokens,
      shouldCreateEnquiry, enquiryTitle, enquiryDescription, enquiryCustomerName, enquiryCustomerEmail,
    } = await generateCallSummary(
      apiKey, this.logger.transcript, smsOptions, this.settings?._project_language ?? null,
      enquiryRules, this.promptSnapshot
    );
    recordUsage(this.promptSnapshot.usedVersionIds());

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
      realtimeAudioIn:  this.usageAccum.realtimeAudioIn,
      realtimeAudioOut: this.usageAccum.realtimeAudioOut,
      realtimeTextIn:   this.usageAccum.realtimeTextIn,
      realtimeTextOut:  this.usageAccum.realtimeTextOut,
      summaryIn:        summaryInputTokens,
      summaryOut:       summaryOutputTokens,
      searchEmbedding:  this.usageAccum.searchEmbedding,
    };

    await this.logger.finalizeCall(title, summary, ownerSent, callerSent, ownerSmsFinal, callerSmsFinal, emailOwner, tokenUsage, { owner: ownerSid, caller: callerSid });
    await this.logger.saveQuality(this.quality.finish());

    // Send email notification if enabled
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

  private async handleOpenAIMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = msg["type"] as string;

    // The assistant's speech is dropped after a barge-in: what OpenAI had already sent must not reach the caller.
    if (type === "response.output_audio.delta") {
      if (this.dropAudio) return;
      const format = this.audioFormat === "mulaw8" ? "mulaw8" : "pcm24";
      const ms = audioDurationMs(String(msg["delta"] ?? ""), format);
      this.clock.audio(String(msg["item_id"] ?? ""), ms);
      this.quality.assistantAudio(ms);
      this.logger.handleOpenAIEvent(msg);
      this.callbacks.sendAudio(msg["delta"] as string, format);
      return;
    }

    if (type === "error") {
      logger.error("OpenAI error event", { event: "openai.error_event", detail: JSON.stringify(msg) });
    } else {
      logger.debug("← openai event", { type });
    }

    if (type === "response.created") this.dropAudio = false; // a new answer: its speech is wanted again

    if (type === "response.done") {
      const response = msg["response"] as Record<string, unknown> | undefined;
      const usage = response?.["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const inDet  = usage["input_token_details"]  as Record<string, number> | undefined;
        const outDet = usage["output_token_details"] as Record<string, number> | undefined;
        this.usageAccum.realtimeAudioIn  += inDet?.["audio_tokens"]  ?? 0;
        this.usageAccum.realtimeAudioOut += outDet?.["audio_tokens"] ?? 0;
        this.usageAccum.realtimeTextIn   += inDet?.["text_tokens"]   ?? 0;
        this.usageAccum.realtimeTextOut  += outDet?.["text_tokens"]  ?? 0;
        logger.info("openai response done", {
          event: "openai.response_done",
          usage_tokens: {
            audio_in: inDet?.["audio_tokens"] ?? 0,
            audio_out: outDet?.["audio_tokens"] ?? 0,
            text_in: inDet?.["text_tokens"] ?? 0,
            text_out: outDet?.["text_tokens"] ?? 0,
          },
        });
      }
    }

    if (type === "session.updated" && !this.listening) {
      // OpenAI now speaks our audio format: release what the caller said while it was being set up.
      this.listening = true;
      for (const frame of this.inputBuffer.drain()) this.sendInputAudio(frame);
    }

    if (type === "session.updated" && this.settings?.greeting_enabled && this.settings?.greeting_message?.trim()) {
      logger.info("triggering greeting response");
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    }

    // The quality measurement sees the interruption first (it needs the assistant still audible); then the queue is emptied.
    this.trackQuality(type, msg);
    if (type === "input_audio_buffer.speech_started" && this.clock.audible()) this.bargeIn();
    this.logger.handleOpenAIEvent(msg);

    this.callbacks.sendJson(msg);

    if (type === "response.function_call_arguments.done") {
      await this.executeToolCall(
        msg["name"] as string,
        msg["arguments"] as string,
        msg["call_id"] as string
      );
    }
  }

  // Feeds the quality measurement (LEA-154) from the events OpenAI already sends; it never changes the call.
  private trackQuality(type: string, msg: Record<string, unknown>): void {
    if (type === "input_audio_buffer.speech_started") this.quality.callerSpeechStarted();
    else if (type === "input_audio_buffer.speech_stopped") this.quality.callerSpeechStopped();
    else if (type === "conversation.item.input_audio_transcription.completed") this.quality.callerTranscribed(String(msg["transcript"] ?? ""));
  }

  // ─── Barge-in (LEA-155) ─────────────────────────────────────────────────────────
  // OpenAI streams speech several times faster than real time, so the phone line holds seconds of it that the caller
  // has not heard yet. When the caller starts talking, that queue must be emptied and OpenAI told how much of the
  // answer was actually heard, otherwise the assistant keeps talking and later "remembers" saying words nobody heard.
  // OpenAI's own speech detection already ignores a ding or street noise (measured, LEA-155), so the first real speech is enough.

  private bargeIn(): void {
    const playing = this.clock.playing();
    const queuedMs = this.clock.remainingMs();
    const ws = this.openaiWs;
    // OpenAI cancels the answer itself when the caller starts talking; it only needs to be told how much was heard.
    if (ws?.readyState === WebSocket.OPEN) {
      if (playing && playing.itemId) {
        ws.send(JSON.stringify({
          type: "conversation.item.truncate",
          item_id: playing.itemId,
          content_index: 0,
          audio_end_ms: playing.playedMs,
        }));
      }
    }
    this.callbacks.clearAudio?.();
    this.callbacks.sendJson({ type: "engine.clear_audio" });
    this.clock.clear();
    this.quality.playbackCleared();
    this.dropAudio = true;
    logger.info("caller interrupted the assistant", { event: "call.barge_in", played_ms: playing?.playedMs ?? 0, unheard_ms: queuedMs });
  }

  private async executeToolCall(name: string, argsJson: string, callId: string): Promise<void> {
    logger.info("executing tool", { name });
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson); } catch { /* invalid json from model */ }

    // end_call is handled entirely in the engine — no external API call needed
    if (name === "end_call") {
      const reason = (args["reason"] as string) ?? "conversation complete";
      logger.info("end_call requested", { reason });
      const toolResultMsg = {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ status: "ok" }) },
      };
      this.logger.handleClientEvent(toolResultMsg);
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify(toolResultMsg));
        // No response.create — AI should not speak after hanging up
      }
      this.callbacks.sendJson({ type: "engine.tool_done", name });
      // Generate the call summary now, but don't hang up yet — the goodbye
      // audio for this turn may still be streaming out to Twilio. Send a
      // Twilio "mark" right after it; Twilio only echoes it back once that
      // audio has actually finished playing to the caller, which is when we
      // actually close the connection (see handleTwilioMark below).
      this.end().catch((e) => logger.error("end_call session.end error", { err: e }));
      const markName = `end-call-${Date.now()}`;
      this.pendingEndCallMark = markName;
      this.callbacks.sendMark(markName);
      this.endCallFallbackTimer = setTimeout(() => {
        logger.warn("end_call mark not acknowledged in time, hanging up anyway", { markName });
        this.pendingEndCallMark = null;
        this.callbacks.endCall();
      }, END_CALL_MARK_FALLBACK_MS);
      return;
    }

    const t0 = Date.now();
    this.quality.toolStarted();
    const knowledgeTopN = this.settings?.knowledge_top_n ?? 5;
    const { result, embeddingTokens } = await executeTool(name, args, this.projectId ?? "", this.calendarProjectId, this.logger.callId ?? undefined, knowledgeTopN, this.callerPhone);
    if (name === "create_calendar_event") {
      const booking = confirmedBookingFromResult(result);
      if (booking) this.confirmedBookings.push(booking);
      if (bookingMadeFromResult(result)) this.bookingMade = true;
    }
    this.usageAccum.searchEmbedding += embeddingTokens;
    this.quality.toolFinished(name, Date.now() - t0, toolResultFailed(result));
    logger.info("tool executed", { name, duration_ms: Date.now() - t0 });

    this.callbacks.sendJson({ type: "engine.tool_done", name });

    const toolResultMsg = {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    };
    this.logger.handleClientEvent(toolResultMsg);
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(toolResultMsg));
      this.openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
  }
}
