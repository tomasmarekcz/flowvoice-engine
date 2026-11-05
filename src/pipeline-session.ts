// LEA-165: the "own chain" voice engine. Speech recognition (an OpenAI Realtime session in transcription mode, which also tells
// us when the caller starts and stops talking), a fast text model that thinks and uses the tools (Responses API), and a
// separate voice that says the answer sentence by sentence. Everything between is ours: the conversation, the tool loop, the
// interruptions. Standard, Live and Hybrid are untouched; a project is switched to this engine by an admin.
import { WebSocket } from "ws";
import { CallLogger, type UsageDetail } from "./call-logger";
import { loadAssistantSettings, type AssistantSettings } from "./config";
import { logger } from "./logger";
import { bindToCurrentContext } from "./log/context";
import { buildPromptFromSettings, buildTools } from "./prompt";
import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";
import { getSnapshot } from "./prompts/store";
import { executeTool } from "./tools";
import { bookingMadeFromResult, confirmedBookingFromResult, type ConfirmedBooking } from "./booking-confirmation";
import { refreshExternalCalendars } from "./ical-refresh";
import type { AudioFormat, SessionCallbacks, VoiceSession } from "./session-types";
import { CallQualityTracker, toolResultFailed } from "./quality-tracker";
import { PlaybackClock } from "./playback-clock";
import { InputBuffer } from "./input-buffer";
import { effectiveLanguage, resolveVoice } from "./persona";
import { pipelineBridgeSentences, pipelineLlmEffort, pipelineLlmModel, pipelineSttModel, voiceModel } from "./models";
import { SpeechOutput } from "./voice/speech-output";
import type { VoiceProvider, VoiceUsage } from "./voice/types";
import { responsesLlm, type LlmStream } from "./pipeline/responses-llm";
import { finishCall } from "./call-finish";
import { CallWatchdog, END_CALL_MARK_FALLBACK_MS, RESUME_GRACE_MS, fixedTexts, maxCallMs, endCallEnabled, speaksEnglish, type EndReason } from "./call-ending";

const STT_START_TIMEOUT_MS = 6000;
// A tool that takes longer than this gets a short "one moment" sentence so the caller does not sit in silence.
const TOOL_FILLER_MS = 1200;
const MAX_TOOL_ROUNDS = 6;
// Speech this long with an empty transcript is a person talking that we did not understand (shorter is noise or a click).
const UNCLEAR_MIN_SPEECH_MS = 700;
// After this many "I didn't catch that" in a row the assistant stops asking and waits.
const MAX_UNCLEAR_IN_ROW = 2;
// Sound cuts the assistant off only after it has lasted this long without a break. Words in the transcript never cut it by
// themselves (LEA-179): speech recognition writes "uh", "um" or a stray character for a click, a cough or the assistant's own
// voice coming back through the line, and each of those used to stop the assistant mid-sentence.
// (LEA-175: one second; was half a second.)
const BARGE_IN_CONFIRM_MS = 1000;
// An answer this short is finished in under a second: the caller waiting for it is better than cutting it off (LEA-175).
const NO_BARGE_IN_WORDS = 5;

export interface PipelineOptions {
  /** Audio format of the caller's side: "pcmu" (phone line, default on Twilio) or PCM 24 kHz (browser test call). */
  audio?: "pcmu" | "pcm24";
  /** Set by the session factory when this call runs on Standard because an engine could not start (LEA-154). */
  fallbackReason?: string;
  voice: (voiceName: string, snapshot: PromptSnapshot) => VoiceProvider;
  /** Test hook: replaces the Responses API. */
  llm?: LlmStream;
  /** Test hook: replaces the WebSocket to OpenAI for speech recognition. */
  connect?: (url: string, apiKey: string) => WebSocket;
}

type HistoryItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export class PipelineCallSession implements VoiceSession {
  readonly audioFormat: AudioFormat;
  private readonly logger: CallLogger;
  private readonly quality = new CallQualityTracker((type, payload) => this.logger.logEvent(type, "system", payload));
  private readonly clock = new PlaybackClock();
  private readonly inputBuffer = new InputBuffer();
  private stt: WebSocket | null = null;
  private listening = false;
  private speech: SpeechOutput | null = null;
  private settings: AssistantSettings | null = null;
  private promptSnapshot: PromptSnapshot = emptySnapshot();
  private calendarProjectId = "admin-test";
  private instructions = "";
  private tools: ReturnType<typeof buildTools> = [];
  private history: HistoryItem[] = [];
  private assistantEntry: number | null = null; // index in `history` of the answer being spoken
  private turnId = 0;
  private turnActive = false;
  private turnCtrl: AbortController | null = null;
  private ended = false;
  private pendingEndCallMark: string | null = null;
  private endCallFallbackTimer: NodeJS.Timeout | null = null;
  // Keeping watch over the call (LEA-158/160).
  private watchdog: CallWatchdog | null = null;
  private endReason: EndReason = "caller";
  private hangupRequestedAt = 0;
  private hangupResumable = false;
  private llmFailuresInRow = 0;
  private confirmedBookings: ConfirmedBooking[] = [];
  private bookingMade = false;
  private embeddingTokens = 0;
  private voiceRecoveries = 0;
  private sttRecoveries = 0;
  private givingUp = false;
  private apiKey = "";
  private speechStartedAt = 0;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private lastSpeechMs = 0;
  private unclearInRow = 0;
  private usage = {
    llmInput: 0, llmCachedInput: 0, llmOutput: 0,
    voiceAudioOut: 0, voiceTextIn: 0, voiceChars: 0,
  };
  private readonly llm: LlmStream;

  constructor(
    private readonly projectId: string | null,
    private readonly callerPhone: string | null,
    private readonly twilioCallSid: string | null,
    private readonly callbacks: SessionCallbacks,
    private readonly preloadedSettings: AssistantSettings | null | undefined,
    private readonly preloadedSnapshot: PromptSnapshot | undefined,
    private readonly options: PipelineOptions
  ) {
    this.audioFormat = options.audio === "pcm24" ? "pcm24" : "mulaw8";
    this.logger = new CallLogger(projectId, twilioCallSid);
    this.llm = options.llm ?? responsesLlm;
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    this.apiKey = apiKey;
    refreshExternalCalendars(this.projectId);

    const callCreated = this.logger.createCall(this.callerPhone);
    const [settings, promptSnapshot] = await Promise.all([
      this.preloadedSettings !== undefined ? this.preloadedSettings : loadAssistantSettings(this.projectId),
      this.preloadedSnapshot ?? getSnapshot(),
    ]);
    this.settings = settings;
    this.promptSnapshot = promptSnapshot;
    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";
    if (this.options.fallbackReason) callCreated.then(() => this.quality.markFallback(this.options.fallbackReason!));

    this.instructions = `${buildPromptFromSettings(settings, this.callerPhone, { includeGreeting: false }, promptSnapshot)}\n\n${promptSnapshot.text(P.spokenStyle)}`;
    this.tools = buildTools(settings, promptSnapshot);
    const voiceName = resolveVoice(settings);
    this.logger.openaiPayload = {
      engine: "pipeline", llm: pipelineLlmModel(), effort: pipelineLlmEffort(), stt: pipelineSttModel(), voice: voiceName,
      instructions: this.instructions, tools: this.tools,
    };

    logger.info("starting pipeline session", { project_id: this.projectId ?? "none", llm: pipelineLlmModel(), effort: pipelineLlmEffort() });
    this.speech = this.createSpeech(voiceName);
    await Promise.all([this.connectStt(apiKey, settings), this.speech.start()]);
    await callCreated;

    this.callbacks.sendJson({ type: "proxy.connected", calendar_project_id: this.calendarProjectId, call_id: this.logger.callId, barge_in: "engine" });

    // The greeting is known text: straight to the voice, and the model is told it has been said.
    const greeting = settings?.greeting_enabled ? settings.greeting_message?.trim() : "";
    if (greeting) {
      this.speech.say(greeting);
      this.history.push({ role: "assistant", content: greeting });
      this.logger.handleOpenAIEvent({ type: "response.output_text.done", text: greeting });
    }

    this.watchdog = new CallWatchdog({
      speak: (text) => this.speakHint(text),
      sayAndHangUp: (text, reason) => this.sayAndHangUp(text, reason),
      hangUp: (reason) => { this.endReason = reason; void this.hangUp(this.turnId, false); },
      texts: fixedTexts(settings, promptSnapshot),
    }, settings ? maxCallMs(settings) : 24 * 60 * 60_000); // a test call has the same time limit as a real call (LEA-174); only a call without a project is unlimited
    this.watchdog.start();
  }

  // ─── Speech recognition ─────────────────────────────────────────────────────────

  private connectStt(apiKey: string, settings: AssistantSettings | null): Promise<void> {
    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    const ws = this.options.connect ? this.options.connect(url, apiKey) : new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.stt = ws;
    const language = effectiveLanguage(settings);
    return new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => reject(new Error("speech recognition start timed out")), STT_START_TIMEOUT_MS);
      ws.on("open", bindToCurrentContext(() => {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: this.audioFormat === "mulaw8" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 },
                noise_reduction: { type: "near_field" },
                transcription: {
                  model: pipelineSttModel(),
                  // A soft hint, not a lock (LEA-175): the caller is expected to speak this language but may switch. No word list (LEA-166).
                  prompt: this.promptSnapshot.text(P.sttHint, { language: language === "en" || (language === "auto" && speaksEnglish(settings)) ? "English" : "Czech" }),
                },
                turn_detection: { type: "server_vad", threshold: 0.8, prefix_padding_ms: 300, silence_duration_ms: 400 },
              },
            },
          },
        }));
      }));
      ws.on("message", bindToCurrentContext((data) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg["type"] === "session.updated" && !this.listening) {
          clearTimeout(timer);
          started = true;
          this.listening = true;
          for (const frame of this.inputBuffer.drain()) this.sendInput(frame);
          resolve();
        }
        this.handleSttEvent(msg);
      }));
      ws.on("error", bindToCurrentContext((e: Error) => {
        logger.error("speech recognition socket error", { event: "stt.ws_error", err: e });
        if (!started) { clearTimeout(timer); reject(e); }
      }));
      ws.on("close", bindToCurrentContext((code: number) => {
        if (!started) { clearTimeout(timer); reject(new Error(`speech recognition closed (code ${code})`)); return; }
        if (ws === this.stt) this.onSttLost(code);
      }));
    });
  }

  private handleSttEvent(msg: Record<string, unknown>): void {
    const type = msg["type"] as string;
    if (type === "error") { logger.error("speech recognition error event", { event: "stt.error_event", detail: JSON.stringify(msg).slice(0, 400) }); return; }
    if (type === "input_audio_buffer.speech_started") {
      this.quality.callerSpeechStarted();
      this.speechStartedAt = Date.now();
      if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
      this.bargeInTimer = setTimeout(() => this.onVerifiedCallerSpeech(true), BARGE_IN_CONFIRM_MS);
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.quality.callerSpeechStopped();
      if (this.bargeInTimer) { clearTimeout(this.bargeInTimer); this.bargeInTimer = null; }
      this.lastSpeechMs = this.speechStartedAt ? Date.now() - this.speechStartedAt : 0;
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(msg["transcript"] ?? "");
      this.quality.callerTranscribed(text);
      this.logger.handleOpenAIEvent(msg);
      if (this.ended) return;
      if (text.trim()) { this.unclearInRow = 0; this.onVerifiedCallerSpeech(false); this.startTurn(text.trim()); }
      else this.onUnclearSpeech();
    } else if (type === "conversation.item.input_audio_transcription.failed") {
      logger.warn("transcription of an utterance failed", { event: "stt.transcription_failed", detail: JSON.stringify(msg).slice(0, 300) });
      if (!this.ended) this.onUnclearSpeech();
    }
  }

  // The caller really speaks (the sound lasted long enough, or it was transcribed into words): the line is not silent
  // and a goodbye in progress can be taken back. Only `cut` (the sound lasted a full second) also stops speech that is
  // playing or being produced; words alone never do (LEA-179). A turn that is still thinking is replaced when the new
  // words are recognised.
  private onVerifiedCallerSpeech(cut: boolean): void {
    if (this.bargeInTimer) { clearTimeout(this.bargeInTimer); this.bargeInTimer = null; }
    if (this.ended) return;
    this.watchdog?.callerSpoke();
    this.cancelHangupIfCallerSpeaks();
    if (cut && (this.clock.audible() || this.speech?.busy) && !this.answerIsShort()) this.bargeIn();
  }

  // The answer being spoken has only a few words: let it finish.
  private answerIsShort(): boolean {
    const entry = this.assistantEntry !== null ? this.history[this.assistantEntry] : null;
    if (!entry || !("role" in entry) || entry.role !== "assistant") return false;
    return entry.content.trim().split(/\s+/).length <= NO_BARGE_IN_WORDS;
  }

  // The caller talked for a while but nothing could be made of it: ask once more instead of staying silent.
  private onUnclearSpeech(): void {
    if (!pipelineBridgeSentences()) return; // LEA-180: off by default
    if (this.givingUp || this.turnActive || !this.speech || this.speech.busy || this.clock.audible()) return;
    if (this.lastSpeechMs < UNCLEAR_MIN_SPEECH_MS || this.unclearInRow >= MAX_UNCLEAR_IN_ROW) return;
    this.unclearInRow++;
    const sentence = this.promptSnapshot.text(effectiveLanguage(this.settings) === "en" ? P.unclearEn : P.unclearCs);
    logger.info("caller speech not understood, asking again", { event: "pipeline.unclear", speech_ms: this.lastSpeechMs, in_row: this.unclearInRow });
    this.speech.say(sentence);
    this.history.push({ role: "assistant", content: sentence });
    this.logger.handleOpenAIEvent({ type: "response.output_text.done", text: sentence });
  }

  // Speech recognition dropped during the call: reconnect once; if that fails too, apologise and end the call properly.
  private onSttLost(code: number): void {
    if (this.ended || this.givingUp) return;
    logger.warn("speech recognition disconnected", { event: "stt.closed", code, recoveries: this.sttRecoveries });
    this.quality.disconnected(code);
    this.listening = false; // caller audio is held in the buffer until the new connection is ready
    if (this.sttRecoveries >= 1) { void this.giveUp(); return; }
    this.sttRecoveries++;
    this.connectStt(this.apiKey, this.settings).catch((e) => {
      logger.error("speech recognition reconnect failed", { event: "stt.reconnect_failed", err: e });
      void this.giveUp();
    });
  }

  private async giveUp(): Promise<void> {
    if (this.givingUp || this.ended) return;
    this.givingUp = true;
    this.endReason = "technical_error";
    this.watchdog?.stop();
    this.abortTurn();
    try { this.stt?.close(); } catch { /* already closed */ }
    this.callbacks.sendJson({ type: "error", message: "Speech recognition disconnected" });
    const sentence = this.promptSnapshot.text(effectiveLanguage(this.settings) === "en" ? P.connectionLostEn : P.connectionLostCs);
    this.logger.handleOpenAIEvent({ type: "response.output_text.done", text: sentence });
    this.speech?.say(sentence);
    await this.hangUp(this.turnId, false);
  }

  handleClientAudio(audioBase64: string): void {
    if (!this.listening) { this.inputBuffer.push(audioBase64); return; }
    this.sendInput(audioBase64);
  }

  private sendInput(audio: string): void {
    if (this.stt?.readyState === WebSocket.OPEN) this.stt.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  }

  noteInboundFrame(timestampMs: number, levelDbfs: number): void {
    this.quality.inboundFrame(timestampMs, levelDbfs);
  }

  // ─── The voice ──────────────────────────────────────────────────────────────────

  private createSpeech(voiceName: string): SpeechOutput {
    const provider = this.options.voice(voiceName, this.promptSnapshot);
    return new SpeechOutput(provider, {
      sendAudio: (audio, format) => this.callbacks.sendAudio(audio, format),
      clock: this.clock,
      onSpeech: (ms) => { this.quality.assistantAudio(ms); this.watchdog?.assistantAudio(ms); },
      onUsage: (u: VoiceUsage) => { this.usage.voiceAudioOut += u.audioOutputTokens; this.usage.voiceTextIn += u.textInputTokens; this.usage.voiceChars += u.characters; },
      onError: (e) => this.onVoiceProblem(e.message),
      onStall: () => this.onVoiceProblem("no sound from the voice"),
    });
  }

  // The voice broke: start it once more; after that the call goes on without a voice (the log and the quality numbers show it).
  private onVoiceProblem(reason: string): void {
    if (this.ended) return;
    logger.error("voice problem", { event: "voice.problem", reason, recoveries: this.voiceRecoveries });
    this.quality.toolFinished("voice", 0, true);
    this.speech?.close();
    if (this.voiceRecoveries < 1) {
      this.voiceRecoveries++;
      this.speech = this.createSpeech(resolveVoice(this.settings));
      this.speech.start().catch((e) => logger.error("voice restart failed", { event: "voice.restart_failed", err: e }));
    }
  }

  // ─── One turn: the caller said something, the model answers ───────────────────────

  private startTurn(text: string): void {
    this.abortTurn();
    this.history.push({ role: "user", content: text });
    void this.runTurn();
  }

  private abortTurn(): void {
    this.turnId++;
    this.turnCtrl?.abort();
    this.turnCtrl = null;
    this.turnActive = false;
    this.watchdog?.responseActive(false);
  }

  private async runTurn(attempt = 0): Promise<void> {
    const turn = this.turnId;
    const ctrl = new AbortController();
    this.turnCtrl = ctrl;
    this.turnActive = true;
    this.watchdog?.responseActive(true);
    this.assistantEntry = null;
    let spoke = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let text = "";
        const calls: Array<{ callId: string; name: string; arguments: string }> = [];
        const stream = this.llm({
          model: pipelineLlmModel(), effort: pipelineLlmEffort(), instructions: this.instructions,
          input: this.history, tools: this.tools, signal: ctrl.signal,
        });
        for await (const event of stream) {
          if (turn !== this.turnId) return;
          if (event.type === "text") { text += event.delta; spoke = true; this.speech?.pushText(event.delta); }
          else if (event.type === "tool_call") calls.push(event);
          else if (event.type === "usage") { this.usage.llmInput += event.inputTokens; this.usage.llmCachedInput += event.cachedInputTokens; this.usage.llmOutput += event.outputTokens; }
        }
        if (turn !== this.turnId) return;
        this.speech?.endText();
        this.llmFailuresInRow = 0;
        if (text.trim()) {
          this.watchdog?.assistantSaid(text);
          this.history.push({ role: "assistant", content: text });
          this.assistantEntry = this.history.length - 1;
          this.logger.handleOpenAIEvent({ type: "response.output_text.done", text });
        }
        if (calls.length === 0) {
          // A second, small model checks whether this answer was the end of the call (the main model sometimes forgets end_call).
          if (text.trim()) void this.checkCallFinished(turn);
          return;
        }
        for (const call of calls) {
          this.history.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments });
          if (call.name === "end_call") {
            this.history.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify({ status: "ok" }) });
            // The model sometimes hangs up without a word (LEA-158): then the engine says the goodbye itself.
            if (!text.trim()) this.speakFixed(fixedTexts(this.settings, this.promptSnapshot).goodbye);
            await this.hangUp(turn, true);
            return;
          }
          await this.runTool(call, turn);
        }
        if (turn !== this.turnId) return;
      }
      logger.warn("pipeline turn stopped after too many tool rounds", { event: "pipeline.max_rounds" });
    } catch (e) {
      if (ctrl.signal.aborted || turn !== this.turnId) return;
      logger.error("pipeline turn failed", { event: "pipeline.turn_error", err: e, attempt });
      this.quality.toolFinished("llm", 0, true);
      this.speech?.endText();
      // The model did not answer: ask once more if nothing was said yet; if it keeps failing, end the call properly (LEA-160).
      if (!spoke && attempt === 0) {
        this.turnActive = false;
        await new Promise((r) => setTimeout(r, 300));
        if (turn === this.turnId && !this.ended) { void this.runTurn(1); return; }
      } else if (++this.llmFailuresInRow >= 2) {
        void this.giveUp();
      }
    } finally {
      if (turn === this.turnId) { this.turnActive = false; this.watchdog?.responseActive(false); }
    }
  }

  // LEA-174: safety net for end_call. After an answer without a tool call, a small model reads the last lines and says
  // whether the call is over. It runs while the answer is spoken; if the caller speaks meanwhile, the call goes on.
  private async checkCallFinished(turn: number): Promise<void> {
    if (this.ended || this.givingUp || !endCallEnabled(this.settings)) return;
    const lines = this.history
      .filter((h): h is { role: "user" | "assistant"; content: string } => "role" in h)
      .slice(-6)
      .map((h) => `${h.role === "user" ? "Caller" : "Assistant"}: ${h.content}`);
    if (lines.length < 2) return;
    try {
      let answer = "";
      const stream = this.llm({
        model: pipelineLlmModel(), effort: pipelineLlmEffort(), instructions: this.promptSnapshot.text(P.endCheck),
        input: [{ role: "user", content: lines.join("\n") }], tools: [], signal: AbortSignal.timeout(8000),
      });
      for await (const event of stream) {
        if (event.type === "text") answer += event.delta;
        else if (event.type === "usage") { this.usage.llmInput += event.inputTokens; this.usage.llmCachedInput += event.cachedInputTokens; this.usage.llmOutput += event.outputTokens; }
      }
      const finished = /^\s*END\b/i.test(answer);
      logger.info("end check", { event: "call.end_check", finished });
      if (!finished || turn !== this.turnId || this.ended) return;
      await this.hangUp(turn, true);
    } catch (e) {
      logger.warn("end check failed", { event: "call.end_check_failed", err: e });
    }
  }

  private async runTool(call: { callId: string; name: string; arguments: string }, turn: number): Promise<void> {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.arguments); } catch { /* invalid json from the model */ }
    this.logger.handleOpenAIEvent({ type: "response.function_call_arguments.done", call_id: call.callId, name: call.name, arguments: call.arguments });
    logger.info("executing tool", { name: call.name });
    this.quality.toolStarted();
    this.watchdog?.toolStarted();
    const t0 = Date.now();
    const filler = !pipelineBridgeSentences() ? null : setTimeout(() => {
      if (turn === this.turnId && this.speech && !this.speech.busy && !this.clock.audible()) {
        this.speech.say(this.promptSnapshot.text(effectiveLanguage(this.settings) === "en" ? P.fillerEn : P.fillerCs));
      }
    }, TOOL_FILLER_MS);
    let result: unknown;
    try {
      const out = await executeTool(call.name, args, this.projectId ?? "", this.calendarProjectId, this.logger.callId ?? undefined, this.settings?.knowledge_top_n ?? 5, this.callerPhone, this.promptSnapshot);
      result = out.result;
      this.embeddingTokens += out.embeddingTokens;
    } finally {
      if (filler) clearTimeout(filler);
      this.watchdog?.toolFinished();
    }
    this.quality.toolFinished(call.name, Date.now() - t0, toolResultFailed(result));
    if (call.name === "create_calendar_event") {
      const booking = confirmedBookingFromResult(result);
      if (booking) this.confirmedBookings.push(booking);
      if (bookingMadeFromResult(result)) this.bookingMade = true;
    }
    const output = JSON.stringify(result);
    this.logger.handleClientEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.callId, output } });
    // The output goes into the conversation even if the caller interrupted meanwhile, so the model's tool call never dangles.
    this.history.push({ type: "function_call_output", call_id: call.callId, output });
    this.callbacks.sendJson({ type: "engine.tool_done", name: call.name });
  }

  // ─── The caller interrupts ──────────────────────────────────────────────────────

  private bargeIn(): void {
    const queuedMs = this.clock.remainingMs();
    const heard = this.speech?.cancel() ?? "";
    this.abortTurn();
    // The conversation keeps only what the caller heard of the interrupted answer.
    if (this.assistantEntry !== null && this.history[this.assistantEntry] && "role" in this.history[this.assistantEntry]) {
      if (heard) this.history[this.assistantEntry] = { role: "assistant", content: heard };
      else this.history.splice(this.assistantEntry, 1);
    } else if (heard) {
      this.history.push({ role: "assistant", content: heard });
    }
    this.assistantEntry = null;
    this.callbacks.clearAudio?.();
    this.callbacks.sendJson({ type: "engine.clear_audio" });
    this.clock.clear();
    this.quality.playbackCleared();
    logger.info("caller interrupted the assistant", { event: "call.barge_in", engine: "pipeline", heard_chars: heard.length, unheard_ms: queuedMs });
  }

  // ─── End of the call ────────────────────────────────────────────────────────────

  private async hangUp(turn: number, resumable: boolean): Promise<void> {
    logger.info("end_call requested", { event: "call.end_call", reason: this.endReason });
    this.callbacks.sendJson({ type: "engine.tool_done", name: "end_call" });
    this.speech?.endText();
    await this.speech?.drained();
    if (turn !== this.turnId) return; // the caller spoke during the goodbye: the call goes on
    this.beginHangup(resumable);
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

  /** Makes the assistant say exactly this sentence now; the call goes on afterwards. */
  private speakFixed(text: string): void {
    if (this.ended || !this.speech) return;
    this.speech.say(text);
    this.history.push({ role: "assistant", content: text });
    this.logger.handleOpenAIEvent({ type: "response.output_text.done", text });
  }

  /** Says a sentence, waits until it has been heard, then hangs up (silence, call-length limit). */
  private async sayAndHangUp(text: string, reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.endReason = reason;
    this.watchdog?.suspend(true);
    this.abortTurn();
    await this.speakHint(text);
    await this.speech?.drained();
    this.beginHangup(false);
  }

  // LEA-175: silence and call-length sentences are said by the model itself (a system hint in the conversation), so they come
  // in the right language, address and voice. The recorded text of the watchdog is the fallback when the model says nothing.
  private hintFor(fixed: string): string | null {
    const texts = fixedTexts(this.settings, this.promptSnapshot);
    const snap = this.promptSnapshot;
    if (fixed === texts.silenceAsk) return snap.text(P.hintSilenceAsk);
    if (fixed === texts.silenceBye) return snap.text(P.hintSilenceBye);
    if (fixed === texts.limitWarning) return snap.text(P.hintLimitWarning);
    if (fixed === texts.limitBye) return snap.text(P.hintLimitBye);
    return null;
  }

  private async speakHint(fixed: string): Promise<void> {
    const hint = this.hintFor(fixed);
    if (this.ended || !hint) { this.speakFixed(fixed); return; }
    this.abortTurn();
    const turn = this.turnId;
    const ctrl = new AbortController();
    this.turnCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 8000);
    this.turnActive = true;
    this.watchdog?.responseActive(true);
    this.assistantEntry = null;
    let text = "";
    try {
      const stream = this.llm({
        model: pipelineLlmModel(), effort: pipelineLlmEffort(), instructions: this.instructions,
        input: [...this.history, { role: "developer", content: hint }], tools: [], signal: ctrl.signal,
      });
      for await (const event of stream) {
        if (turn !== this.turnId) return; // the caller spoke meanwhile: the new turn takes over
        if (event.type === "text") { text += event.delta; this.speech?.pushText(event.delta); }
        else if (event.type === "usage") { this.usage.llmInput += event.inputTokens; this.usage.llmCachedInput += event.cachedInputTokens; this.usage.llmOutput += event.outputTokens; }
      }
      if (turn !== this.turnId) return;
      this.speech?.endText();
      if (text.trim()) {
        this.history.push({ role: "assistant", content: text });
        this.assistantEntry = this.history.length - 1;
        this.logger.handleOpenAIEvent({ type: "response.output_text.done", text });
        return;
      }
    } catch (e) {
      if (turn !== this.turnId) return;
      logger.warn("hint turn failed, using the recorded sentence", { event: "pipeline.hint_failed", err: e });
      this.speech?.endText();
      if (text.trim()) return;
    } finally {
      clearTimeout(timer);
      if (turn === this.turnId) { this.turnActive = false; this.watchdog?.responseActive(false); }
    }
    this.speakFixed(fixed);
  }

  handleTwilioMark(name: string): void {
    if (name !== this.pendingEndCallMark) return;
    this.pendingEndCallMark = null;
    if (this.endCallFallbackTimer) { clearTimeout(this.endCallFallbackTimer); this.endCallFallbackTimer = null; }
    logger.info("end_call goodbye audio confirmed played, hanging up", { markName: name, reason: this.endReason });
    this.finishHangup();
  }

  /** Close everything without writing the call (the engine could not start; the call row is removed). */
  async abort(): Promise<void> {
    this.watchdog?.stop();
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.ended = true;
    this.abortTurn();
    this.speech?.close();
    try { this.stt?.close(); } catch { /* already closed */ }
    await this.logger.discardCall();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.watchdog?.stop();
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.abortTurn();
    logger.info("session ending, generating summary", { event: "call.ending" });
    this.speech?.close();
    try { this.stt?.close(); } catch { /* already closed */ }
    const detail: UsageDetail = {
      engine: "pipeline",
      brain_model: pipelineLlmModel(),
      stt_model: pipelineSttModel(),
      stt_seconds: this.logger.callDurationSeconds,
      llm_input_tokens: this.usage.llmInput,
      llm_cached_input_tokens: this.usage.llmCachedInput,
      llm_output_tokens: this.usage.llmOutput,
      voice_provider: "openai-realtime",
      voice_model: voiceModel(),
      voice_audio_output_tokens: this.usage.voiceAudioOut,
      voice_text_input_tokens: this.usage.voiceTextIn,
      voice_characters: this.usage.voiceChars,
    };
    await finishCall({
      logger: this.logger, settings: this.settings, projectId: this.projectId, callerPhone: this.callerPhone, twilioCallSid: this.twilioCallSid,
      promptSnapshot: this.promptSnapshot, confirmedBookings: this.confirmedBookings, bookingMade: this.bookingMade,
      searchEmbeddingTokens: this.embeddingTokens, quality: this.quality.finish(), usageDetail: detail,
      endReason: this.endReason,
    });
  }
}
