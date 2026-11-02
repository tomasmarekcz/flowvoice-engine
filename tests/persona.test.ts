import { describe, it, expect } from "vitest";
import { emptySnapshot } from "../src/prompts/core";
import { effectiveLanguage, personaBlock, personaGender, resolveVoice, DEFAULT_VOICE_BY_GENDER } from "../src/persona";

describe("persona", () => {
  it("defaults to a formal female Czech receptionist with the voice marin", () => {
    const s = {} as never;
    expect(personaGender(s)).toBe("female");
    expect(resolveVoice(s)).toBe(DEFAULT_VOICE_BY_GENDER.female);
  });

  it("uses a male default voice when the persona is male and no voice is chosen", () => {
    expect(resolveVoice({ persona_gender: "male" } as never)).toBe("cedar");
  });

  it("keeps a chosen voice and derives the gender from it when none is set", () => {
    expect(personaGender({ voice: "ash" } as never)).toBe("male");
    expect(resolveVoice({ voice: "coral" } as never)).toBe("coral");
  });

  it("renders the persona block with the address form and gender rules", () => {
    const snap = emptySnapshot();
    const informal = personaBlock({ language: "cs", address_form: "informal", persona_gender: "male" } as never, snap);
    const formal = personaBlock({ language: "cs" } as never, snap);
    expect(effectiveLanguage({ language: "cs" } as never)).toBe("cs");
    expect(informal).not.toBe(formal);
    expect(personaBlock({ language: "en" } as never, snap)).not.toBe(formal);
  });
});
