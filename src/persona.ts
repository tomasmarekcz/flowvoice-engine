// LEA-163: the assistant's persona: which language it speaks, how it addresses the caller, and its gender. The same block is
// put at the start of the instructions of every voice engine, so the grammar ("jsem ráda" / "jsem rád") never switches
// mid-call, and the voice is chosen to match the gender.
import type { AssistantSettings } from "./config";
import { ELEVEN_VOICES } from "./voice/eleven-voices";
import type { PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";

export type PersonaLanguage = "cs" | "en" | "auto";
export type Gender = "female" | "male";

/** The assistant's own setting, else the project's language, else Czech. Older projects store a word instead of a code. */
export function effectiveLanguage(settings: AssistantSettings | null): PersonaLanguage {
  const own = settings?.language;
  if (own === "cs" || own === "en" || own === "auto") return own;
  const project = (settings?._project_language ?? "").toLowerCase();
  if (project.startsWith("en")) return "en";
  if (project.startsWith("cs") || project.startsWith("cz")) return "cs";
  return "cs";
}

export function personaBlock(settings: AssistantSettings | null, snapshot: PromptSnapshot): string {
  const language = effectiveLanguage(settings);
  const def = language === "en" ? P.personaEn : language === "auto" ? P.personaAuto : P.personaCs;
  return snapshot.text(def, {
    address_rule: snapshot.text(settings?.address_form === "informal" ? P.personaInformal : P.personaFormal),
    gender_rule: snapshot.text(personaGender(settings) === "male" ? P.personaMale : P.personaFemale),
  });
}

// Gender of each OpenAI voice, by measured pitch of the Czech samples (LEA-163): ash 119 Hz, cedar 145, echo 145, verse 157 lower;
// marin 195, coral 205, ballad 211, sage 216 higher. alloy (154) and shimmer (160) sit in between and are treated as female.
// One list on purpose: correct a voice here and in the dashboard's voice-engines.ts.
export const VOICE_GENDER: Record<string, Gender> = {
  alloy: "female", ash: "male", ballad: "female", cedar: "male", coral: "female",
  echo: "male", marin: "female", sage: "female", shimmer: "female", verse: "male",
  // ElevenLabs voices (Hybrid and Pipeline only, LEA-166); the list with their ids is voice/eleven-voices.ts.
  ...Object.fromEntries(Object.entries(ELEVEN_VOICES).map(([name, v]) => [name, v.gender])),
};
export const DEFAULT_VOICE_BY_GENDER: Record<Gender, string> = { female: "marin", male: "cedar" };

export function personaGender(settings: AssistantSettings | null): Gender {
  if (settings?.persona_gender === "male" || settings?.persona_gender === "female") return settings.persona_gender;
  // Projects without the setting keep the gender of the voice they already use.
  const voice = settings?.voice ?? "";
  return VOICE_GENDER[voice] ?? "female";
}

/** The voice to use: the chosen one when it matches the assistant's gender, otherwise the default voice of that gender. */
export function resolveVoice(settings: AssistantSettings | null): string {
  const gender = personaGender(settings);
  const chosen = settings?.voice ?? "";
  return VOICE_GENDER[chosen] === gender ? chosen : DEFAULT_VOICE_BY_GENDER[gender];
}
