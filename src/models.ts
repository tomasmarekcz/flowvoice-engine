// The OpenAI models each voice engine uses. Defaults live here; an environment variable on the engine server overrides them
// (and Admin → AI Settings → Modely documents the current choice, see admin.ai_models).

/** Standard engine: one Realtime model that listens, thinks and speaks. */
export const standardModel = (): string => process.env.STANDARD_MODEL || "gpt-realtime-2.1";

/** Hybrid engine: the Realtime model that listens and thinks (it answers in text). */
export const hybridBrainModel = (): string => process.env.HYBRID_BRAIN_MODEL || standardModel();

/** Hybrid and Pipeline engines: the Realtime model used only as the voice (text in, speech out). */
export const voiceModel = (): string => process.env.VOICE_MODEL || "gpt-realtime-2.1-mini";

/** Pipeline engine: the text model that thinks (Responses API) and how much it reasons before answering. */
export const pipelineLlmModel = (): string => process.env.PIPELINE_LLM_MODEL || "gpt-6-luna";
export const pipelineLlmEffort = (): string => process.env.PIPELINE_LLM_EFFORT ?? "low";
/**
 * Pipeline engine: the two fixed sentences the engine itself says in the middle of a call ("one moment, let me check"
 * while a tool is slow, and "sorry, I didn't catch that" after speech that could not be read). Off by default
 * (LEA-180): the owner wants to hear the assistant without them. Set PIPELINE_BRIDGE_SENTENCES=on to bring them back.
 * The recorded fallback sentences for a lost connection are not affected.
 */
export const pipelineBridgeSentences = (): boolean => process.env.PIPELINE_BRIDGE_SENTENCES === "on";

/** Pipeline engine: speech recognition. */
/** ElevenLabs voice model (LEA-166): Eleven v4 Turbo, fast and speaks Czech. */
export const elevenLabsModel = (): string => process.env.ELEVENLABS_MODEL || "eleven_v4_turbo";

export const pipelineSttModel = (): string => process.env.PIPELINE_STT_MODEL || "gpt-4o-transcribe";

/**
 * Pipeline engine: low-confidence transcripts (LEA-196). Speech recognition reports how sure it is about each word; noise and
 * clicks come out as invented words with low probabilities.
 *   measure (default): the confidence is measured and written to the call events (`turn.heard`), nothing is dropped.
 *   on:                a transcript below the limits is dropped (not sent to the model, not in the saved conversation).
 *   off:               no check.
 * Limits are log probabilities of the word tokens (0 = certain): the weakest word, and the average of the words.
 */
export type ConfidenceMode = "measure" | "on" | "off";
export const pipelineConfidenceMode = (): ConfidenceMode => {
  const v = process.env.PIPELINE_CONFIDENCE;
  return v === "on" || v === "off" ? v : "measure";
};
export const pipelineConfidenceLimits = (): { minLogprob: number; avgLogprob: number } => {
  const num = (v: string | undefined, fallback: number): number => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback; };
  return { minLogprob: num(process.env.PIPELINE_CONFIDENCE_MIN, -1.5), avgLogprob: num(process.env.PIPELINE_CONFIDENCE_AVG, -0.5) };
};
