// How sure speech recognition is about a transcript (LEA-196). Noise, clicks and the assistant's own voice coming back
// through the line are often "transcribed" into invented words ("Ok.", "Dobrý den, jak se máte?"). Those words carry
// low probabilities; real speech is almost always near 0. OpenAI sends the per-token log probabilities when the session
// asks for `item.input_audio_transcription.logprobs`.

export interface Confidence {
  /** Word tokens counted (punctuation and spaces are left out). */
  tokens: number;
  /** The least sure word token (log probability, 0 = certain, -3 = very unsure). */
  minLogprob: number;
  /** Average log probability of the word tokens. */
  avgLogprob: number;
}

export interface ConfidenceLimits {
  /** A transcript with a word token below this is low confidence. */
  minLogprob: number;
  /** A transcript whose average is below this is low confidence. */
  avgLogprob: number;
}

// A token that is only spaces, punctuation or symbols. The full stop after "Ok" is often unsure even on clean speech.
const NOT_A_WORD = /^[\s\p{P}\p{S}]*$/u;

export function analyzeLogprobs(raw: unknown): Confidence | null {
  if (!Array.isArray(raw)) return null;
  const values: number[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { token, logprob } = item as { token?: unknown; logprob?: unknown };
    if (typeof token !== "string" || typeof logprob !== "number" || !Number.isFinite(logprob)) continue;
    if (NOT_A_WORD.test(token)) continue;
    values.push(logprob);
  }
  if (values.length === 0) return null;
  return {
    tokens: values.length,
    minLogprob: Math.min(...values),
    avgLogprob: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

/** No measurement (the model sent none) is never low: the filter then does nothing. */
export function isLowConfidence(c: Confidence | null, limits: ConfidenceLimits): boolean {
  if (!c) return false;
  return c.minLogprob < limits.minLogprob || c.avgLogprob < limits.avgLogprob;
}
