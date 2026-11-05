// LEA-158 / LEA-160: how a call ends, shared by the Standard, Live and Pipeline sessions.
// The watchdog watches the silence on the line and the length of the call; each session only says what to do
// (speak a fixed sentence, hang up) and tells the watchdog what it hears.

import type { AssistantSettings } from "./config";
import type { PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";
import { effectiveLanguage } from "./persona";

/** Silence after the assistant has finished speaking before it asks "Are you still there?". */
export const SILENCE_ASK_MS = 6000;
/** Further silence after that question before the assistant says goodbye and hangs up. */
export const SILENCE_HANGUP_MS = 6000;
/** Pipeline: no spoken questions about silence; after this much silence (Assistant -> Advanced settings) the call just ends (LEA-181). */
export const DEFAULT_SILENCE_HANGUP_SECONDS = 30;
export const MIN_SILENCE_HANGUP_SECONDS = 10;
export const MAX_SILENCE_HANGUP_SECONDS = 120;
/** Pipeline: a caller who is talking when the length limit is reached is let finish; the goodbye comes at the latest after this long. */
export const LIMIT_GRACE_MS = 30_000;
/** The caller counts as busy (speaking, or waiting for the transcript) for this long after the sound starts / stops. */
const CALLER_SOUND_CAP_MS = 30_000;
const CALLER_TRANSCRIPT_WAIT_MS = 10_000;
/** The caller is warned this long before the call-length limit. */
export const LIMIT_WARNING_BEFORE_MS = 60_000;
export const DEFAULT_MAX_CALL_MINUTES = 10;
export const MIN_MAX_CALL_MINUTES = 2;
export const MAX_MAX_CALL_MINUTES = 30;
/** The caller's own goodbye is transcribed a moment after end_call arrives: only speech later than this keeps the call open. */
export const RESUME_GRACE_MS = 1500;
/** If Twilio never confirms that the goodbye was played, hang up anyway after this long. */
export const END_CALL_MARK_FALLBACK_MS = 15000;

export type EndReason = "caller" | "silence" | "time_limit" | "technical_error";

/** Call-length limit from the customer's setting; a missing or odd value means the default. */
export function maxCallMs(settings: AssistantSettings | null): number {
  const raw = Number(settings?.max_call_minutes);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CALL_MINUTES;
  return Math.min(MAX_MAX_CALL_MINUTES, Math.max(MIN_MAX_CALL_MINUTES, Math.round(minutes))) * 60_000;
}

/** Pipeline: how long the line may be silent before the call ends without a word; from the customer's setting, 10 to 120 s. */
export function silenceHangupMs(settings: AssistantSettings | null): number {
  const raw = Number(settings?.silence_hangup_seconds);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_HANGUP_SECONDS;
  return Math.min(MAX_SILENCE_HANGUP_SECONDS, Math.max(MIN_SILENCE_HANGUP_SECONDS, Math.round(seconds))) * 1000;
}

/** end_call is on unless the customer switched it off (a missing key counts as on). */
export function endCallEnabled(settings: AssistantSettings | null): boolean {
  const caps = settings?.capabilities;
  return !caps || caps["end_call"] !== false;
}

const GOODBYE = /\b(na shledanou|nashledanou|na slyšenou|na viděnou|hezký den|hezký zbytek|přeji pěkný|mějte se|goodbye|bye|have a (great|nice|good) day|take care)\b/i;

/** True when the assistant's last words sound like a goodbye. Used only as a safety net, together with silence. */
export function containsGoodbye(text: string): boolean {
  return GOODBYE.test(text);
}

/** Fixed sentences and recorded clips come in Czech and English; "auto" follows the project's language. */
export function speaksEnglish(settings: AssistantSettings | null): boolean {
  const language = effectiveLanguage(settings);
  return language === "en" || (language === "auto" && (settings?._project_language ?? "").toLowerCase().startsWith("en"));
}

export interface FixedTexts {
  silenceAsk: string;
  silenceBye: string;
  limitWarning: string;
  limitBye: string;
  reconnected: string;
  /** Said by the engine when the model hung up without saying goodbye. */
  goodbye: string;
}

/** The fixed sentences in the language of the call (editable in the admin prompt registry). */
export function fixedTexts(settings: AssistantSettings | null, snapshot: PromptSnapshot): FixedTexts {
  const en = speaksEnglish(settings);
  return {
    silenceAsk: snapshot.text(en ? P.silenceAskEn : P.silenceAskCs),
    silenceBye: snapshot.text(en ? P.silenceByeEn : P.silenceByeCs),
    limitWarning: snapshot.text(en ? P.limitWarningEn : P.limitWarningCs),
    limitBye: snapshot.text(en ? P.limitByeEn : P.limitByeCs),
    reconnected: snapshot.text(en ? P.reconnectedEn : P.reconnectedCs),
    goodbye: snapshot.text(en ? P.goodbyeEn : P.goodbyeCs),
  };
}

export interface WatchdogHooks {
  /** Say a fixed sentence now and carry on with the call. */
  speak(text: string): void | Promise<void>;
  /** Say a fixed sentence, wait until it has been heard, then hang up. */
  sayAndHangUp(text: string, reason: EndReason): void | Promise<void>;
  /** Hang up without saying anything more. */
  hangUp(reason: EndReason): void;
  texts: FixedTexts;
}

/**
 * Watches one call. Silence is counted from the moment the assistant stops speaking, never while a tool runs or the
 * line is being re-connected. The length limit runs from start() whatever happens.
 */
export interface WatchdogOptions {
  /**
   * Quiet mode (Pipeline, LEA-181): the watchdog never speaks about silence and never warns about the length limit. A silent
   * line just ends the call after `hangupMs`, and at the length limit the caller is let finish before the goodbye.
   */
  silent?: { hangupMs: number };
}

export class CallWatchdog {
  private silenceTimer: NodeJS.Timeout | null = null;
  private warnTimer: NodeJS.Timeout | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  private stage: 0 | 1 = 0; // 1 = the "still there?" question has been asked
  private busyUntil = 0; // when the assistant's speech that is queued on the line will have been heard
  private tools = 0;
  private responding = false;
  private suspended = false;
  private goodbyeSaid = false;
  private stopped = false;
  private callerBusyUntil = 0; // the caller is speaking or the transcript of what they said is still on its way
  private limitTimerPoll: NodeJS.Timeout | null = null;

  constructor(private readonly hooks: WatchdogHooks, private readonly maxMs: number, private readonly options: WatchdogOptions = {}) {}

  start(): void {
    this.stopped = false;
    if (!this.options.silent && this.maxMs > LIMIT_WARNING_BEFORE_MS) {
      this.warnTimer = setTimeout(() => this.fireWarning(), this.maxMs - LIMIT_WARNING_BEFORE_MS);
    }
    this.limitTimer = setTimeout(() => this.fireLimit(), this.maxMs);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.silenceTimer, this.warnTimer, this.limitTimer, this.limitTimerPoll]) if (t) clearTimeout(t);
    this.silenceTimer = this.warnTimer = this.limitTimer = this.limitTimerPoll = null;
  }

  /** The caller said something (voice detected or words transcribed). */
  callerSpoke(): void {
    this.stage = 0;
    this.goodbyeSaid = false;
    this.callerBusyUntil = 0;
    this.arm();
  }

  /** Speech detection hears the caller start: silence is not counted while they talk (LEA-181). */
  callerSoundStarted(): void {
    this.callerBusyUntil = Date.now() + CALLER_SOUND_CAP_MS;
    this.arm();
  }

  /** The caller's sound stopped: their transcript is on its way, so silence still is not counted for a while. */
  callerSoundStopped(): void {
    this.callerBusyUntil = Date.now() + CALLER_TRANSCRIPT_WAIT_MS;
    this.arm();
  }

  /** The transcript of an utterance arrived (or failed); nothing is on its way any more. */
  transcriptDone(): void {
    this.callerBusyUntil = 0;
    this.arm();
  }

  /** Assistant audio reached the line; `ms` is how long it plays. Silent filler frames must not be reported. */
  assistantAudio(ms: number): void {
    const now = Date.now();
    this.busyUntil = Math.max(now, this.busyUntil) + ms;
    this.arm();
  }

  /** The assistant's words as text, used only to spot a goodbye. */
  assistantSaid(text: string): void {
    if (containsGoodbye(text)) this.goodbyeSaid = true;
  }

  /** The model is generating or speaking an answer: the line is not silent, whatever the audio clock says. */
  responseActive(on: boolean): void {
    this.responding = on;
    if (on && this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (!on) this.arm();
  }

  /** True while assistant speech queued on the line has not finished playing. */
  assistantBusy(): boolean { return Date.now() < this.busyUntil; }

  toolStarted(): void { this.tools++; if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; } }
  toolFinished(): void { this.tools = Math.max(0, this.tools - 1); this.arm(); }

  /** Pause the silence check (a hang-up is under way, or the connection is being re-made). The length limit keeps running. */
  suspend(on: boolean): void {
    this.suspended = on;
    if (on && this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (!on) this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.suspended || this.tools > 0 || this.responding) return;
    const silent = this.options.silent;
    // Quiet mode: a goodbye that was said is followed by a short wait, otherwise by the customer's silence time.
    const after = silent ? (this.goodbyeSaid ? SILENCE_ASK_MS : silent.hangupMs) : (this.stage === 0 ? SILENCE_ASK_MS : SILENCE_HANGUP_MS);
    const wait = Math.max(0, Math.max(this.busyUntil, this.callerBusyUntil) - Date.now()) + after;
    this.silenceTimer = setTimeout(() => this.fireSilence(), wait);
  }

  private fireSilence(): void {
    this.silenceTimer = null;
    if (this.stopped || this.suspended) return;
    // Never decide on silence while something is going on (an answer is being made, a tool runs, the caller is talking).
    if (this.responding || this.tools > 0 || Date.now() < this.callerBusyUntil) { this.arm(); return; }
    if (this.options.silent) {
      this.stop();
      void this.hooks.hangUp("silence");
      return;
    }
    if (this.stage === 0 && this.goodbyeSaid) {
      // The assistant already said goodbye and the caller is silent: the line was only left open by mistake.
      void this.hooks.hangUp("silence");
      return;
    }
    if (this.stage === 0) {
      this.stage = 1;
      void this.hooks.speak(this.hooks.texts.silenceAsk);
      this.arm();
      return;
    }
    this.stop();
    void this.hooks.sayAndHangUp(this.hooks.texts.silenceBye, "silence");
  }

  private fireWarning(): void {
    this.warnTimer = null;
    if (this.stopped) return;
    void this.hooks.speak(this.hooks.texts.limitWarning);
  }

  private fireLimit(): void {
    this.limitTimer = null;
    if (this.stopped) return;
    if (this.options.silent) { this.waitForCallerThenSayLimitBye(Date.now()); return; }
    this.stop();
    void this.hooks.sayAndHangUp(this.hooks.texts.limitBye, "time_limit");
  }

  // Quiet mode: the limit is reached, but a caller who is talking (or whose answer is being made) is let finish first.
  private waitForCallerThenSayLimitBye(since: number): void {
    this.limitTimerPoll = null;
    if (this.stopped) return;
    const now = Date.now();
    const settled = !this.responding && this.tools === 0 && now >= this.callerBusyUntil && now >= this.busyUntil;
    if (settled || now - since >= LIMIT_GRACE_MS) {
      this.stop();
      void this.hooks.sayAndHangUp(this.hooks.texts.limitBye, "time_limit");
      return;
    }
    this.limitTimerPoll = setTimeout(() => this.waitForCallerThenSayLimitBye(since), 500);
  }
}

/** The line shown to the owner in the notification when the call ended because of a technical problem. */
export function technicalErrorLine(lang: string | null): string {
  return lang === "en"
    ? "⚠️ The call was cut short by a technical problem. Please call the customer back."
    : "⚠️ Hovor se kvůli technické chybě přerušil. Zavolejte prosím zákazníkovi zpět.";
}

/**
 * What the owner's notifications say about a call that ended because of a technical problem (added to the summary the
 * owner already gets, when the owner has that notification on). A call with nothing said still gets a short summary.
 */
export function withTechnicalNotice(opts: {
  technical: boolean;
  ownerSms: string | null;
  emailOwner: string | null;
  ownerEnabled: boolean;
  emailEnabled: boolean;
  lang: string | null;
}): { ownerSms: string | null; emailOwner: string | null } {
  if (!opts.technical) return { ownerSms: opts.ownerSms, emailOwner: opts.emailOwner };
  const empty = opts.lang === "en" ? "The call was cut off before the assistant could note anything." : "Hovor se přerušil dřív, než stihl asistent cokoli zapsat.";
  const line = technicalErrorLine(opts.lang);
  return {
    ownerSms: opts.ownerSms || (opts.ownerEnabled ? empty : null),
    emailOwner: opts.emailOwner ? `${line}\n\n${opts.emailOwner}` : opts.emailEnabled ? `${line}\n\n${empty}` : null,
  };
}
