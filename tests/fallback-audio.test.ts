import { describe, it, expect } from "vitest";
import { fallbackClip, VOICES_WITHOUT_CLIPS_YET } from "../src/fallback-audio";
import { FALLBACK_CLIPS } from "../src/fallback-audio-data";
import { VOICE_GENDER } from "../src/persona";
import { LIVE_VOICES } from "../src/live-protocol";

// A new voice needs all recorded sentences in that voice: run `npm run fallback-audio` (see src/fallback-audio.ts).
describe("recorded fallback sentences (LEA-160)", () => {
  it("exist for every assistant voice, language and sentence", () => {
    for (const voice of Object.keys(VOICE_GENDER).filter((v) => !VOICES_WITHOUT_CLIPS_YET.includes(v))) {
      for (const language of ["cs", "en"] as const) {
        for (const kind of ["wait", "apology"] as const) {
          expect(FALLBACK_CLIPS[voice]?.[language]?.[kind], `${voice}/${language}/${kind}`).toBeTruthy();
        }
      }
    }
  });

  it("a voice that is waiting for its recordings is listed, and leaves the list as soon as it has them (LEA-166)", () => {
    for (const voice of VOICES_WITHOUT_CLIPS_YET) {
      expect(VOICE_GENDER[voice], `${voice} is not a known voice`).toBeTruthy();
      expect(FALLBACK_CLIPS[voice], `${voice} already has recordings: remove it from VOICES_WITHOUT_CLIPS_YET`).toBeUndefined();
    }
  });

  it("a voice without recordings plays the default voice of its own gender", () => {
    expect(fallbackClip("wait", "cs", "el-adam")).toBe(FALLBACK_CLIPS.cedar.cs.wait);
    expect(fallbackClip("wait", "cs", "el-jana")).toBe(FALLBACK_CLIPS.marin.cs.wait);
  });

  it("every Live voice is a known voice", () => {
    for (const voice of LIVE_VOICES) expect(VOICE_GENDER[voice], voice).toBeTruthy();
  });

  it("an unknown voice falls back to the default voice instead of silence", () => {
    expect(fallbackClip("wait", "cs", "some-new-voice")).toBeTruthy();
  });
});
