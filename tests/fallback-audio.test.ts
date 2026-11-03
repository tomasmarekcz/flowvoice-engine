import { describe, it, expect } from "vitest";
import { fallbackClip } from "../src/fallback-audio";
import { VOICE_GENDER } from "../src/persona";
import { LIVE_VOICES } from "../src/live-protocol";

// A new voice needs all recorded sentences in that voice: run `npm run fallback-audio` (see src/fallback-audio.ts).
describe("recorded fallback sentences (LEA-160)", () => {
  it("exist for every assistant voice, language and sentence", () => {
    for (const voice of Object.keys(VOICE_GENDER)) {
      for (const language of ["cs", "en"] as const) {
        for (const kind of ["wait", "apology"] as const) {
          expect(fallbackClip(kind, language, voice), `${voice}/${language}/${kind}`).toBeTruthy();
        }
      }
    }
  });

  it("every Live voice is a known voice", () => {
    for (const voice of LIVE_VOICES) expect(VOICE_GENDER[voice], voice).toBeTruthy();
  });

  it("an unknown voice falls back to the default voice instead of silence", () => {
    expect(fallbackClip("wait", "cs", "some-new-voice")).toBeTruthy();
  });
});
