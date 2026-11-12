import { describe, it, expect } from "vitest";
import { analyzeLogprobs, isLowConfidence } from "../src/transcript-confidence";

const lp = (...pairs: Array<[string, number]>) => pairs.map(([token, logprob]) => ({ token, logprob, bytes: [] }));
const limits = { minLogprob: -1.5, avgLogprob: -0.5 };

describe("transcript confidence", () => {
  it("returns null when the model gave no probabilities", () => {
    expect(analyzeLogprobs(undefined)).toBeNull();
    expect(analyzeLogprobs(null)).toBeNull();
    expect(analyzeLogprobs([])).toBeNull();
    expect(analyzeLogprobs("nonsense")).toBeNull();
  });

  it("measures the weakest and the average word token", () => {
    const c = analyzeLogprobs(lp(["Ano", -0.04], [" prosím", -0.2]))!;
    expect(c.tokens).toBe(2);
    expect(c.minLogprob).toBeCloseTo(-0.2);
    expect(c.avgLogprob).toBeCloseTo(-0.12);
  });

  it("ignores punctuation and spaces: the full stop after a short word is often unsure on clean speech", () => {
    const c = analyzeLogprobs(lp(["Ok", -0.04], [".", -1.07]))!;
    expect(c.tokens).toBe(1);
    expect(c.minLogprob).toBeCloseTo(-0.04);
    expect(isLowConfidence(c, limits)).toBe(false);
  });

  it("returns null when there is only punctuation", () => {
    expect(analyzeLogprobs(lp([".", -2], ["?", -3]))).toBeNull();
  });

  it("flags clear speech as fine and an invented sentence from noise as low", () => {
    expect(isLowConfidence(analyzeLogprobs(lp(["Dobrý", -0.001], [" den", -0.0], [" chci", -0.01]))!, limits)).toBe(false);
    expect(isLowConfidence(analyzeLogprobs(lp(["Dobrý", -2.9], [" den", -0.1], [" jak", -0.2], [" se", -0.6], [" máte", -0.8]))!, limits)).toBe(true);
  });

  it("flags a transcript whose average is weak even if no single token is terrible", () => {
    const c = analyzeLogprobs(lp(["a", -1.0], [" b", -1.0], [" c", -1.1]))!;
    expect(isLowConfidence(c, limits)).toBe(true);
  });

  it("never flags a missing measurement", () => {
    expect(isLowConfidence(null, limits)).toBe(false);
  });
});
