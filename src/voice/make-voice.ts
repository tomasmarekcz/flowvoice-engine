// LEA-166: picks the voice provider for a call by the voice name in the assistant's settings. An ElevenLabs voice is read by
// ElevenLabs with OpenAI Realtime as the spare; any other name is read by OpenAI Realtime.
import { logger } from "../logger";
import type { AssistantSettings } from "../config";
import type { PromptSnapshot } from "../prompts/core";
import { DEFAULT_VOICE_BY_GENDER, effectiveLanguage, personaGender } from "../persona";
import { ELEVEN_VOICES, isElevenVoice } from "./eleven-voices";
import { ElevenLabsVoice } from "./elevenlabs-voice";
import { FallbackVoice } from "./fallback-voice";
import { RealtimeVoice } from "./realtime-voice";
import type { VoiceProvider } from "./types";

export function makeVoice(voiceName: string, snapshot: PromptSnapshot, settings: AssistantSettings | null): VoiceProvider {
  if (!isElevenVoice(voiceName)) return new RealtimeVoice({ voice: voiceName, snapshot });
  const spareName = DEFAULT_VOICE_BY_GENDER[personaGender(settings)];
  const spare = () => new RealtimeVoice({ voice: spareName, snapshot });
  if (!process.env.ELEVENLABS_API_KEY) {
    logger.warn("ELEVENLABS_API_KEY is not set, reading with the OpenAI voice", { event: "voice.elevenlabs_no_key", voice: voiceName });
    return spare();
  }
  const language = effectiveLanguage(settings);
  return new FallbackVoice(
    new ElevenLabsVoice({ voiceId: ELEVEN_VOICES[voiceName].voiceId, language: language === "cs" || language === "en" ? language : null }),
    spare,
  );
}
