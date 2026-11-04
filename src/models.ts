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

/** Pipeline engine: speech recognition. */
export const pipelineSttModel = (): string => process.env.PIPELINE_STT_MODEL || "gpt-4o-transcribe";
