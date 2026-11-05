// LEA-166: the ElevenLabs voices an assistant can use in the Hybrid and Pipeline engines. A voice is picked by its name in
// assistant_settings.voice, like the OpenAI voices; a name that is in this list is read by ElevenLabs, any other by OpenAI.
// One list on purpose: the dashboard's voice-engines.ts has the same names (ELEVEN_VOICES), correct both together.
// Every voice speaks Czech and English (the model decides from the text).
export type Gender = "female" | "male";

export interface ElevenVoice {
  /** The ElevenLabs voice id. */
  voiceId: string;
  gender: Gender;
  label: string;
}

export const ELEVEN_VOICES: Record<string, ElevenVoice> = {
  "el-adam": { voiceId: "uYFJyGaibp4N2VwYQshk", gender: "male", label: "Adam" },
  "el-jarnathan": { voiceId: "c6SfcYrb2t09NHXiT80T", gender: "male", label: "Jarnathan" },
  "el-hope": { voiceId: "tnSpp4vdxKPjI9w0GnoV", gender: "female", label: "Hope" },
  "el-jana": { voiceId: "bF7C2fCv7Zf30iT84wZ1", gender: "female", label: "Jana" },
};

export function isElevenVoice(name: string | null | undefined): boolean {
  return !!name && Object.prototype.hasOwnProperty.call(ELEVEN_VOICES, name);
}
