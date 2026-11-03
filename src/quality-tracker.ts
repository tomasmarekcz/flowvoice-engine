// Measures how a call went (LEA-154): interruptions, noise that triggered speech detection, dead air, tool trouble and
// lost connections. It only counts and reports; it never changes what the assistant does, and it never throws, so a
// bug here cannot hurt a call. Events carry numbers and tool names only: no caller text, names or phone numbers.

export interface QualityStats {
  /** The caller really spoke (non-empty transcript) while the assistant was still audible. */
  interruptions: number;
  /** Speech detection fired but nothing was transcribed (noise, a cough). */
  false_triggers: number;
  /** Stretches where nobody spoke and no tool was running for at least DEAD_AIR_MS. */
  dead_air_count: number;
  dead_air_ms: number;
  /** Tools that failed or took longer than SLOW_TOOL_MS. */
  tool_problems: number;
  /** Connection to OpenAI lost while the call was still running. */
  disconnects: number;
  /** Lost connections that were re-made so the call could go on (LEA-160). */
  reconnects: number;
  /** The call started on Standard because Live could not start. */
  fallback: boolean;
  /** Milliseconds from the start of the call to the first sound of the assistant (null: it never spoke). */
  first_audio_ms: number | null;
  /** Times the caller's audio stopped arriving for 100 ms or more (a bad line, packet loss). */
  inbound_gaps: number;
  /** Average loudness of the caller's audio in dB below full scale, over the frames with sound (null: none). */
  caller_dbfs: number | null;
}

export type QualityEmit = (eventType: string, payload: Record<string, unknown>) => void;

export const DEAD_AIR_MS = 5000;
export const SLOW_TOOL_MS = 3000;
// The assistant counts as still audible until this long before its queued audio runs out.
const OVERLAP_MARGIN_MS = 200;
// Audio frames below this loudness are line noise or silence and do not count towards the caller's level.
const SOUND_FLOOR_DBFS = -55;
// The caller's audio normally arrives every 20 ms; this much later counts as a gap in the line.
const INBOUND_GAP_MS = 100;
// Live has no "caller started speaking" event: a transcript delta after this long without one starts a new utterance.
const NEW_UTTERANCE_GAP_MS = 1500;

/** Duration of a base64 audio chunk, from its encoded length (no decoding). */
export function audioDurationMs(base64: string, format: "pcm24" | "mulaw8"): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  return format === "pcm24" ? bytes / 48 : bytes / 8;
}

/** A tool result that reports an error (the shape every tool in tools.ts uses). */
export function toolResultFailed(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result && !!(result as { error: unknown }).error;
}

export class CallQualityTracker {
  private stats: QualityStats = {
    interruptions: 0, false_triggers: 0, dead_air_count: 0, dead_air_ms: 0, tool_problems: 0, disconnects: 0, reconnects: 0, fallback: false,
    first_audio_ms: null, inbound_gaps: 0, caller_dbfs: null,
  };
  private readonly startedAt: number;
  private lastInboundTimestamp: number | null = null;
  private levelSum = 0;
  private levelCount = 0;
  // When the audio already sent to the caller runs out (the model streams faster than real time).
  private playbackEndsAt = 0;
  private lastActivityAt: number | null = null;
  private toolsRunning = 0;
  private lastCallerDeltaAt = 0;
  // Speech segments waiting for their transcript: how much assistant audio was still playing when the caller started (0 = none).
  private segments: number[] = [];
  private finished = false;

  constructor(private readonly emit: QualityEmit, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** Audio from the assistant arrived; `durationMs` is how long it plays. */
  assistantAudio(durationMs: number): void {
    this.safely(() => {
      const t = this.now();
      if (this.stats.first_audio_ms === null) this.stats.first_audio_ms = t - this.startedAt;
      this.closeGap(t);
      this.playbackEndsAt = Math.max(t, this.playbackEndsAt) + durationMs;
      this.lastActivityAt = this.playbackEndsAt;
    });
  }

  /**
   * One frame of the caller's audio arrived from the phone line. `timestampMs` is the line's own clock (Twilio's media
   * timestamp), so a jump means audio really went missing; `levelDbfs` is the frame's loudness.
   */
  inboundFrame(timestampMs: number, levelDbfs: number): void {
    this.safely(() => {
      const prev = this.lastInboundTimestamp;
      this.lastInboundTimestamp = timestampMs;
      if (prev !== null && timestampMs - prev >= INBOUND_GAP_MS) this.stats.inbound_gaps++;
      if (levelDbfs > SOUND_FLOOR_DBFS) {
        this.levelSum += levelDbfs;
        this.levelCount++;
      }
    });
  }

  /** The audio queue at the caller was cleared (a barge-in handled by the engine). */
  playbackCleared(): void {
    this.safely(() => {
      const t = this.now();
      this.playbackEndsAt = t;
      this.lastActivityAt = t;
    });
  }

  /** Standard: speech detection says the caller started talking. */
  callerSpeechStarted(): void {
    this.safely(() => {
      const t = this.now();
      this.closeGap(t);
      this.segments.push(this.assistantAudible(t) ? Math.round(this.playbackEndsAt - t) : 0);
      this.lastActivityAt = t;
    });
  }

  /** Standard: speech detection says the caller stopped talking. */
  callerSpeechStopped(): void {
    this.safely(() => { this.lastActivityAt = this.now(); });
  }

  /** Standard: the transcript of one speech segment arrived (empty text = nothing was said). */
  callerTranscribed(text: string): void {
    this.safely(() => {
      const remainingMs = this.segments.shift() ?? 0;
      if (text.trim()) {
        if (remainingMs > 0) {
          this.stats.interruptions++;
          this.emit("quality.interruption", { assistant_remaining_ms: remainingMs });
        }
      } else {
        this.stats.false_triggers++;
        this.emit("quality.false_trigger", { during_assistant: remainingMs > 0 });
      }
    });
  }

  /** Live: a piece of the caller's transcript arrived. The start of an utterance over the assistant is an interruption. */
  callerTextDelta(text: string): void {
    this.safely(() => {
      if (!text.trim()) return;
      const t = this.now();
      const startsUtterance = t - this.lastCallerDeltaAt > NEW_UTTERANCE_GAP_MS;
      this.lastCallerDeltaAt = t;
      if (startsUtterance) {
        this.closeGap(t);
        if (this.assistantAudible(t)) {
          this.stats.interruptions++;
          this.emit("quality.interruption", { assistant_remaining_ms: Math.round(this.playbackEndsAt - t), inferred: true });
        }
      }
      this.lastActivityAt = t;
    });
  }

  toolStarted(): void {
    this.safely(() => {
      const t = this.now();
      this.closeGap(t);
      this.toolsRunning++;
      this.lastActivityAt = t;
    });
  }

  toolFinished(name: string, durationMs: number, failed: boolean): void {
    this.safely(() => {
      this.toolsRunning = Math.max(0, this.toolsRunning - 1);
      this.lastActivityAt = this.now();
      if (failed || durationMs > SLOW_TOOL_MS) {
        this.stats.tool_problems++;
        this.emit("quality.tool_problem", { tool: name, duration_ms: Math.round(durationMs), kind: failed ? "error" : "slow" });
      }
    });
  }

  /** The connection to OpenAI dropped while the call was running. */
  disconnected(code: number): void {
    this.safely(() => {
      this.stats.disconnects++;
      this.emit("quality.disconnect", { code });
    });
  }

  /** A lost connection to OpenAI was made again and the call went on. */
  reconnected(): void {
    this.safely(() => {
      this.stats.reconnects++;
      this.emit("quality.reconnected", {});
    });
  }

  /** Live could not start and this call runs on Standard instead. */
  markFallback(reason: string): void {
    this.safely(() => {
      this.stats.fallback = true;
      this.emit("quality.engine_fallback", { reason });
    });
  }

  /** Call over: count the silence at the end, then return the totals. Safe to call twice. */
  finish(): QualityStats {
    this.safely(() => {
      if (this.finished) return;
      this.finished = true;
      this.closeGap(this.now());
    });
    return {
      ...this.stats,
      caller_dbfs: this.levelCount > 0 ? Math.round(this.levelSum / this.levelCount) : null,
    };
  }

  private assistantAudible(t: number): boolean {
    return this.playbackEndsAt - OVERLAP_MARGIN_MS > t;
  }

  // Called at the start of every new activity: if nothing happened since the last one for long enough, that was dead air.
  private closeGap(t: number): void {
    if (this.lastActivityAt === null || this.toolsRunning > 0) return;
    const gap = t - this.lastActivityAt;
    if (gap >= DEAD_AIR_MS) {
      this.stats.dead_air_count++;
      this.stats.dead_air_ms += gap;
      this.emit("quality.dead_air", { duration_ms: Math.round(gap) });
    }
  }

  private safely(fn: () => void): void {
    try { fn(); } catch { /* measuring must never affect the call */ }
  }
}
