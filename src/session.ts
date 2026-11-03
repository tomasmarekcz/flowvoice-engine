import { WebSocket } from "ws";
import { CallLogger, type UsageDetail, generateCallSummary, maybeCreatePostCallEnquiry, prepareEnquiryCheck, SmsOptions, TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import { loadAssistantSettings, AssistantSettings } from "./config";
import { logger } from "./logger";
import { withTechnicalNotice } from "./call-ending";
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
import { resolveVoice } from "./persona";
import { standardModel, voiceModel } from "./models";
import { SpeechOutput } from "./voice/speech-output";
import type { VoiceProvider, VoiceUsage } from "./voice/types";
import { InputBuffer } from "./input-buffer";
import { CallWatchdog, END_CALL_MARK_FALLBACK_MS, RESUME_GRACE_MS, fixedTexts, maxCallMs, speaksEnglish, technicalErrorLine, type EndReason } from "./call-ending";
import { fallbackClip } from "./fallback-audio";

export function formatOwnerSms(
  rawSummary: string,
  opts: { callerPhone: string | null; startMs: number; callId: string | null; lang: string | null; booking?: OwnerBookingBlock | null; technicalError?: boolean }
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

  const lines = [header, phoneLine, rawSummary, ...(opts.technicalError ? [technicalErrorLine(opts.lang)] : []), ...(opts.booking?.lines ?? [])];
  if (opts.callId) {
    const base = process.env.PUBLIC_APP_URL ?? "https://leadoro.io";
    lines.push(`🔗 ${base}/conversations/${opts.callId}`);
  }
  return lines.join("\n");
}

export type { SessionCallbacks } from "./session-types";

// How many times a lost connection to OpenAI is re-made before the call is ended with an apology (LEA-160).
const MAX_RECONNECTS = 2;
const RECONNECT_TIMEOUT_MS = 6000;
// The history handed to the new session after a reconnect.
const RESUME_TRANSCRIPT_TURNS = 40;

export interface CallSessionOptions {
  /** Set by the session factory when Live could not start and this call runs on Standard instead (LEA-154). */
  fallbackReason?: string;
  /** Audio format spoken with OpenAI: "pcmu" = the phone line's own format, no conversion (LEA-155); default PCM 24 kHz. */
  audio?: "pcmu" | "pcm24";
  /** Realtime model for this call; default is the Standard model (STANDARD_MODEL). */
  model?: string;
  /**
   * Hybrid engine (LEA-164): the Realtime model listens and thinks but answers in text; this provider says the text.
   * Absent = the Realtime model speaks itself (Standard).
   */
  voice?: (voiceName: string, snapshot: PromptSnapshot) => VoiceProvider;
  /** A connection to OpenAI that was opened ahead of the call (LEA-162): used instead of opening a new one. */
  socket?: WebSocket | null;
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
  // Why the call ended when it was not the caller hanging up (LEA-158/160).
  private endReason: EndReason = "caller";
  private settings: AssistantSettings | null = null;
  private promptSnapshot: PromptSnapshot = emptySnapshot();
  private pendingEndCallMark: string | null = null;
  private endCallFallbackTimer: NodeJS.Timeout | null = null;
  // Ending the call and keeping watch over it (LEA-158/160).
  private watchdog: CallWatchdog | null = null;
  private hangupRequestedAt = 0;
  private hangupResumable = false; // an end_call can be taken back when the caller speaks again; silence / limit / error cannot
  private fixedSentence: string | null = null; // waiting for the current answer to finish before it can be said
  private hangUpAfterFixed: EndReason | null = null;
  private fixedInFlight = 0; // fixed-sentence answers asked for and not yet finished
  private goodbyeText: string | null = null;
  private goodbyeSent = false;
  // Connection to OpenAI (re-made once it drops, LEA-160).
  private instructions = "";
  private tools: ReturnType<typeof buildTools> = [];
  private voiceName = "";
  private callCreated: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private resumeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private resumed = false;
  // What the caller has heard, and the barge-in state (LEA-155).
  private readonly clock = new PlaybackClock();
  private dropAudio = false;
  // The caller's audio waits here until OpenAI has accepted the session settings (its default format is not ours).
  private readonly inputBuffer = new InputBuffer();
  private listening = false;
  // Hybrid engine state (LEA-164).
  private speech: SpeechOutput | null = null;
  private voiceReady: Promise<void> = Promise.resolve();
  private nativeVoice = false; // the separate voice failed twice: the Realtime model speaks by itself from now on
  private voiceRecoveries = 0;
  private brainResponseActive = false;
  private spokeThisResponse = false; // the answer under way has already had words or sound (so a goodbye was said)
  private lastAssistantItemId: string | null = null;
  private voiceUsage = { audioOutputTokens: 0, textInputTokens: 0, characters: 0 };
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

    this.instructions = buildPromptFromSettings(settings, this.callerPhone, {}, this.promptSnapshot);
    this.tools = buildTools(settings, this.promptSnapshot);
    recordUsage(this.promptSnapshot.usedVersionIds());
    this.voiceName = resolveVoice(settings);
    this.callCreated = callCreated;

    const model = this.options.model ?? standardModel();
    this.logger.openaiPayload = { model, voice: this.voiceName, instructions: this.instructions, tools: this.tools, engine: this.options.voice ? "hybrid" : "standard" };
    if (this.options.voice) this.voiceReady = this.startVoice(this.voiceName);

    logger.info("connecting to OpenAI", { project_id: this.projectId ?? "none" });
    this.openConnection(false);

    this.watchdog = new CallWatchdog({
      speak: (text) => this.speakFixed(text),
      sayAndHangUp: (text, reason) => this.sayAndHangUp(text, reason),
      hangUp: (reason) => { this.endReason = reason; this.beginHangup(false); },
      texts: fixedTexts(settings, this.promptSnapshot),
    }, this.twilioCallSid ? maxCallMs(settings) : 24 * 60 * 60_000); // a test call keeps its own time limit
    this.watchdog.start();

    // Hybrid: the call only counts as started once the voice is ready, so a voice that cannot start falls back to Standard.
    await this.voiceReady;
  }

  // ─── The connection to OpenAI ───────────────────────────────────────────────────

  private openConnection(resumed: boolean): void {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const model = this.options.model ?? standardModel();
    const audioFormat = this.options.audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 };
    const instructions = resumed ? `${this.instructions}\n\n${this.resumeNote()}` : this.instructions;

    const prewarmed = !resumed ? this.options.socket ?? null : null;
    const openaiWs = prewarmed ?? new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.openaiWs = openaiWs;
    this.resumed = resumed;

    // WebSocket callbacks do not inherit async context: bind each to the call's log context.
    const onOpen = bindToCurrentContext(() => {
      logger.info(resumed ? "OpenAI reconnected, sending session.update" : "OpenAI connected, sending session.update", { event: "openai.connected" });
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          // Hybrid: the model answers in text and a separate voice says it. The audio output below is the fallback voice.
          ...(this.options.voice && !this.nativeVoice ? { output_modalities: ["text"] } : {}),
          instructions,
          tools: this.tools,
          tool_choice: this.tools.length > 0 ? "auto" : "none",
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
            output: { format: audioFormat, voice: this.voiceName },
          },
        },
      }));
      if (resumed) return;
      // The call id exists once the row is written; the client is told then, with the connection already up.
      this.callCreated.then(() => this.callbacks.sendJson({
        type: "proxy.connected",
        calendar_project_id: this.calendarProjectId,
        call_id: this.logger.callId,
        // The engine tells the client when to stop playing (engine.clear_audio); it need not guess from speech_started.
        barge_in: "engine",
      }));
    });
    // A connection opened ahead of the call may already be open: its "open" event has passed.
    if (prewarmed && prewarmed.readyState === WebSocket.OPEN) onOpen();
    else openaiWs.on("open", onOpen);

    openaiWs.on("message", bindToCurrentContext((data) => {
      if (openaiWs !== this.openaiWs) return; // an old connection
      this.handleOpenAIMessage(data.toString()).catch((e) =>
        logger.error("handleOpenAIMessage error", { err: e })
      );
    }));

    openaiWs.on("close", bindToCurrentContext((code) => {
      if (openaiWs !== this.openaiWs) return;
      logger.warn("OpenAI disconnected", { event: "openai.closed", code });
      if (this.ended) return;
      this.resumeWaiter?.reject(new Error(`closed before ready (code ${code})`));
      this.onConnectionLost(code);
    }));

    openaiWs.on("error", bindToCurrentContext((e) => {
      if (openaiWs !== this.openaiWs) return;
      logger.error("OpenAI WS error", { event: "openai.ws_error", err: e });
      this.callbacks.sendJson({ type: "error", message: `OpenAI error: ${e.message}` });
    }));
  }

  // What the new session is told about the call so far, so it neither greets again nor forgets what was agreed.
  private resumeNote(): string {
    const turns = this.logger.transcript.slice(-RESUME_TRANSCRIPT_TURNS)
      .map((t) => `${t.role === "user" ? "Caller" : "Assistant"}: ${t.text}`).join("\n");
    return `===CALL IN PROGRESS===\nThe connection dropped for a moment and was restored. The call is already under way: do NOT greet again and do not start over. This is what was said so far:\n${turns || "(nothing yet)"}\nContinue naturally from the last thing said.`;
  }

  // The connection dropped in the middle of the call: say so, make it again (twice at most), and if that fails apologise and hang up.
  private onConnectionLost(code: number): void {
    this.quality.disconnected(code);
    this.callbacks.sendJson({ type: "error", message: `OpenAI disconnected (code ${code})` });
    if (this.reconnecting) return;
    void this.recoverConnection();
  }

  private async recoverConnection(): Promise<void> {
    this.reconnecting = true;
    this.listening = false; // the caller's words wait in the buffer until the new session is ready
    this.watchdog?.suspend(true);
    this.playClip("wait");
    for (let attempt = 1; attempt <= MAX_RECONNECTS && !this.ended; attempt++) {
      try {
        await this.reconnectOnce();
        this.reconnecting = false;
        this.quality.reconnected();
        logger.info("OpenAI connection restored", { event: "openai.reconnected", attempt });
        this.watchdog?.suspend(false);
        await this.speakFixed(fixedTexts(this.settings, this.promptSnapshot).reconnected);
        return;
      } catch (e) {
        logger.warn("OpenAI reconnect failed", { event: "openai.reconnect_failed", attempt, err: e });
        try { this.openaiWs?.close(); } catch { /* already closed */ }
      }
    }
    if (this.ended) return;
    // Nothing helped: apologise with the recorded sentence and end the call properly; the owner is told in the summary.
    this.reconnecting = false;
    this.endReason = "technical_error";
    this.watchdog?.stop();
    this.playClip("apology");
    this.beginHangup(false);
  }

  private reconnectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.resumeWaiter = null; reject(new Error("reconnect timed out")); }, RECONNECT_TIMEOUT_MS);
      this.resumeWaiter = {
        resolve: () => { clearTimeout(timer); this.resumeWaiter = null; resolve(); },
        reject: (e) => { clearTimeout(timer); this.resumeWaiter = null; reject(e); },
      };
      this.openConnection(true);
    });
  }

  /** Plays a recorded sentence on the phone line (nothing on a browser test call, which has no phone format). */
  private playClip(kind: "wait" | "apology"): void {
    if (this.audioFormat !== "mulaw8") return;
    const lang = speaksEnglish(this.settings) ? "en" : "cs";
    const clip = fallbackClip(kind, lang, this.voiceName);
    if (clip) this.callbacks.sendAudio(clip, "mulaw8");
  }

  // ─── Fixed sentences and hanging up (LEA-158/160) ───────────────────────────────

  /** Makes the assistant say exactly this sentence now; the call goes on afterwards. */
  private async speakFixed(text: string): Promise<void> {
    if (this.ended) return;
    if (this.hybrid) {
      await this.voiceReady;
      this.speech?.say(text);
      this.logger.handleOpenAIEvent({ type: "response.output_audio_transcript.done", transcript: text });
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }));
      }
      return;
    }
    if (this.brainResponseActive) { this.fixedSentence = text; return; } // said as soon as the answer under way is done
    this.sendFixed(text);
  }

  // A fixed sentence that waited for the answer under way is said now; a goodbye is followed by the hang-up, but only
  // once every fixed sentence asked for (a slow OpenAI may still owe the "still there?" question) has been spoken.
  private afterResponseDone(): void {
    if (this.fixedInFlight > 0) this.fixedInFlight--;
    if (this.fixedSentence) {
      const text = this.fixedSentence;
      this.fixedSentence = null;
      this.sendFixed(text);
      return;
    }
    if (this.hangUpAfterFixed && this.goodbyeSent && this.fixedInFlight === 0) {
      this.hangUpAfterFixed = null;
      this.goodbyeSent = false;
      this.beginHangup(false);
    }
  }

  private sendFixed(text: string): void {
    if (this.openaiWs?.readyState !== WebSocket.OPEN) return;
    this.fixedInFlight++;
    if (text === this.goodbyeText) this.goodbyeSent = true;
    this.openaiWs.send(JSON.stringify({
      type: "response.create",
      response: { instructions: `Say exactly this sentence to the caller, word for word, and nothing else: "${text}"`, tool_choice: "none" },
    }));
  }

  /** Says a sentence, waits until it has been spoken, then hangs up (silence, call-length limit). */
  private async sayAndHangUp(text: string, reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.endReason = reason;
    this.watchdog?.suspend(true);
    if (this.hybrid) {
      await this.speakFixed(text);
      await this.speech!.drained();
      this.beginHangup(false);
      return;
    }
    this.hangUpAfterFixed = reason;
    this.goodbyeText = text;
    await this.speakFixed(text);
  }

  // The line closes once Twilio confirms that everything queued before the mark has been heard.
  // `resumable`: an end_call the caller can take back by speaking again.
  private beginHangup(resumable: boolean): void {
    if (this.ended || this.pendingEndCallMark) return;
    this.hangupRequestedAt = Date.now();
    this.hangupResumable = resumable;
    this.watchdog?.suspend(true);
    const markName = `end-call-${Date.now()}`;
    this.pendingEndCallMark = markName;
    this.callbacks.sendMark(markName);
    this.endCallFallbackTimer = setTimeout(() => {
      logger.warn("end_call mark not acknowledged in time, hanging up anyway", { markName });
      this.pendingEndCallMark = null;
      this.finishHangup();
    }, END_CALL_MARK_FALLBACK_MS);
  }

  // The caller spoke after end_call: the goodbye was premature, so the call goes on.
  private cancelHangupIfCallerSpeaks(): void {
    if (!this.pendingEndCallMark || !this.hangupResumable) return;
    if (Date.now() - this.hangupRequestedAt < RESUME_GRACE_MS) return;
    logger.info("caller spoke after end_call, keeping the call open", { event: "call.end_call_cancelled" });
    this.pendingEndCallMark = null;
    if (this.endCallFallbackTimer) { clearTimeout(this.endCallFallbackTimer); this.endCallFallbackTimer = null; }
    this.hangupResumable = false;
    this.watchdog?.suspend(false);
  }

  private finishHangup(): void {
    this.end().catch((e) => logger.error("end_call session.end error", { err: e }));
    this.callbacks.endCall();
  }

  private usageDetail(): UsageDetail {
    const model = this.options.model ?? standardModel();
    if (!this.options.voice) return { engine: "standard", brain_model: model };
    return {
      engine: "hybrid",
      brain_model: model,
      voice_provider: "openai-realtime",
      voice_model: voiceModel(),
      voice_audio_output_tokens: this.voiceUsage.audioOutputTokens,
      voice_text_input_tokens: this.voiceUsage.textInputTokens,
      voice_characters: this.voiceUsage.characters,
    };
  }

  // ─── Hybrid: the separate voice ─────────────────────────────────────────────────

  private startVoice(voiceName: string): Promise<void> {
    const provider = this.options.voice!(voiceName, this.promptSnapshot);
    this.speech = new SpeechOutput(provider, {
      sendAudio: (audio, format) => this.callbacks.sendAudio(audio, format),
      clock: this.clock,
      onSpeech: (ms) => { this.quality.assistantAudio(ms); this.watchdog?.assistantAudio(ms); },
      onUsage: (u: VoiceUsage) => {
        this.voiceUsage.audioOutputTokens += u.audioOutputTokens;
        this.voiceUsage.textInputTokens += u.textInputTokens;
        this.voiceUsage.characters += u.characters;
      },
      onError: (e) => this.onVoiceProblem(e.message),
      onStall: () => this.onVoiceProblem("no sound from the voice"),
    });
    return this.speech.start();
  }

  // The voice broke in the middle of a call: start it again once; if that does not help, the Realtime model speaks itself.
  private onVoiceProblem(reason: string): void {
    if (this.ended || this.nativeVoice) return;
    logger.error("voice problem", { event: "voice.problem", reason, recoveries: this.voiceRecoveries });
    this.quality.toolFinished("voice", 0, true);
    this.speech?.close();
    if (this.voiceRecoveries < 1 && this.options.voice) {
      this.voiceRecoveries++;
      this.voiceReady = this.startVoice(resolveVoice(this.settings)).catch(() => this.switchToNativeVoice());
    } else {
      this.switchToNativeVoice();
    }
  }

  private switchToNativeVoice(): void {
    this.nativeVoice = true;
    this.speech = null;
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify({ type: "session.update", session: { type: "realtime", output_modalities: ["audio"] } }));
    }
    logger.warn("hybrid voice replaced by the Realtime model's own voice", { event: "voice.native_fallback" });
  }

  private get hybrid(): boolean { return !!this.options.voice && !this.nativeVoice && !!this.speech; }

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
    logger.info("end_call goodbye audio confirmed played, hanging up", { markName: name, reason: this.endReason });
    this.finishHangup();
  }

  /** Close everything without writing the call (the engine could not start and Standard answers instead). */
  async abort(): Promise<void> {
    this.ended = true;
    this.watchdog?.stop();
    this.speech?.close();
    try { this.openaiWs?.close(); } catch { /* already closed */ }
    await this.logger.discardCall();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.watchdog?.stop();
    logger.info("session ending, generating summary", { event: "call.ending" });
    this.speech?.close();
    if (this.openaiWs?.readyState === WebSocket.OPEN) this.openaiWs.close();
    const apiKey = process.env.OPENAI_API_KEY ?? "";

    const skipSms = shouldSkipCallSms(this.logger.callDurationSeconds, this.logger.transcript);
    if (skipSms) logger.info("skipping SMS: short call or caller said nothing", { seconds: this.logger.callDurationSeconds });

    const technicalEnd = this.endReason === "technical_error";
    const { testCall, plan } = await planTestCallNotifications(this.twilioCallSid, this.projectId, this.logger.callId, skipSms);

    const smsOptions: SmsOptions | undefined = this.settings
      ? {
          smsOwnerEnabled: (!skipSms || technicalEnd) && (plan.forceGenerate || (this.settings.sms_owner_enabled ?? false)),
          smsCallerEnabled: !skipSms && (this.settings.sms_caller_enabled ?? false),
          smsOwnerInstructions: this.settings.sms_owner_instructions ?? null,
          smsCallerInstructions: this.settings.sms_caller_instructions ?? null,
          emailOwnerEnabled: (!skipSms || technicalEnd) && (plan.forceGenerate || (this.settings.email_owner_enabled ?? false)),
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
    await this.logger.saveUsageDetail(this.usageDetail());
    if (this.endReason !== "caller") await this.logger.saveEndReason(this.endReason);

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
      this.watchdog?.assistantAudio(ms);
      this.spokeThisResponse = true;
      this.logger.handleOpenAIEvent(msg);
      this.callbacks.sendAudio(msg["delta"] as string, format);
      return;
    }

    if (type === "error") {
      logger.error("OpenAI error event", { event: "openai.error_event", detail: JSON.stringify(msg) });
    } else {
      logger.debug("← openai event", { type });
    }

    if (type === "response.created") { this.dropAudio = false; this.brainResponseActive = true; this.spokeThisResponse = false; this.watchdog?.responseActive(true); } // a new answer: its speech is wanted again
    if (type === "response.done") {
      this.brainResponseActive = false;
      this.watchdog?.responseActive(false);
      this.afterResponseDone();
    }
    if (type === "response.output_audio_transcript.done") this.watchdog?.assistantSaid(String(msg["transcript"] ?? ""));
    if (type === "response.output_text.done") this.watchdog?.assistantSaid(String(msg["text"] ?? ""));
    if (type === "input_audio_buffer.speech_started") { this.watchdog?.callerSpoke(); this.cancelHangupIfCallerSpeaks(); }
    if (type === "response.output_item.added") {
      const item = msg["item"] as { id?: string; role?: string; type?: string } | undefined;
      if (item?.type === "message" && item.role === "assistant" && item.id) this.lastAssistantItemId = item.id;
    }
    if (this.options.voice && !this.nativeVoice) {
      if (type === "response.output_text.delta" && this.speech && !this.dropAudio) { this.spokeThisResponse = true; this.speech.pushText(String(msg["delta"] ?? "")); }
      if (type === "response.output_text.done" && this.speech && !this.dropAudio) this.speech.endText();
    }

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

    if (type === "session.updated" && this.resumeWaiter) this.resumeWaiter.resolve();

    if (type === "session.updated" && !this.resumed && this.settings?.greeting_enabled && this.settings?.greeting_message?.trim()) {
      logger.info("triggering greeting response");
      if (this.options.voice) {
        // Hybrid: the greeting is known text, so it goes straight to the voice without waiting for the model.
        void this.sayGreeting(this.settings.greeting_message.trim());
      } else if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    }

    // The quality measurement sees the interruption first (it needs the assistant still audible); then the queue is emptied.
    this.trackQuality(type, msg);
    if (type === "input_audio_buffer.speech_started" && (this.clock.audible() || (this.hybrid && this.speech!.busy))) this.bargeIn();
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

  private async sayGreeting(text: string): Promise<void> {
    await this.voiceReady;
    if (this.nativeVoice || !this.speech) {
      // No separate voice: the Realtime model speaks the greeting itself.
      if (this.openaiWs?.readyState === WebSocket.OPEN) this.openaiWs.send(JSON.stringify({ type: "response.create" }));
      return;
    }
    this.speech.say(text);
    // The model should know what it has already said.
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }));
    }
    this.logger.handleOpenAIEvent({ type: "response.output_audio_transcript.done", transcript: text });
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
    if (this.hybrid) { this.bargeInHybrid(); return; }
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

  // Hybrid: the answer is text spoken by a separate voice. Stop the voice, empty the phone line, and tell the model only what was heard.
  private bargeInHybrid(): void {
    const queuedMs = this.clock.remainingMs();
    const heard = this.speech?.cancel() ?? "";
    const ws = this.openaiWs;
    if (ws?.readyState === WebSocket.OPEN) {
      if (this.lastAssistantItemId) ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: this.lastAssistantItemId }));
      if (heard) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: heard }] } }));
    }
    this.lastAssistantItemId = null;
    this.callbacks.clearAudio?.();
    this.callbacks.sendJson({ type: "engine.clear_audio" });
    this.clock.clear();
    this.quality.playbackCleared();
    this.dropAudio = true; // the rest of the interrupted answer's text is not to be spoken
    logger.info("caller interrupted the assistant", { event: "call.barge_in", engine: "hybrid", heard_chars: heard.length, unheard_ms: queuedMs });
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
      // The model sometimes hangs up without a word (measured, LEA-158): then the engine says the goodbye itself.
      if (!this.spokeThisResponse) {
        await this.sayAndHangUp(fixedTexts(this.settings, this.promptSnapshot).goodbye, "caller");
        return;
      }
      // Hybrid: let the voice finish the goodbye before the line is closed.
      if (this.hybrid) await this.speech!.drained();
      // The goodbye audio for this turn may still be streaming out to Twilio. Send a Twilio "mark" right after it;
      // Twilio only echoes it back once that audio has actually finished playing to the caller, which is when the
      // connection is closed (handleTwilioMark). If the caller speaks first, the hang-up is taken back.
      this.beginHangup(true);
      return;
    }

    const t0 = Date.now();
    this.quality.toolStarted();
    this.watchdog?.toolStarted();
    const knowledgeTopN = this.settings?.knowledge_top_n ?? 5;
    const { result, embeddingTokens } = await executeTool(name, args, this.projectId ?? "", this.calendarProjectId, this.logger.callId ?? undefined, knowledgeTopN, this.callerPhone);
    if (name === "create_calendar_event") {
      const booking = confirmedBookingFromResult(result);
      if (booking) this.confirmedBookings.push(booking);
      if (bookingMadeFromResult(result)) this.bookingMade = true;
    }
    this.usageAccum.searchEmbedding += embeddingTokens;
    this.quality.toolFinished(name, Date.now() - t0, toolResultFailed(result));
    this.watchdog?.toolFinished();
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
