// LEA-164: a "voice" is the thing that turns text into speech for an engine whose thinking is done elsewhere (Hybrid, Pipeline).
// The engine hands it one sentence at a time; audio comes back through the events. Providers are interchangeable
// (OpenAI Realtime today; ElevenLabs and Cartesia are LEA-166).

export interface VoiceUsage {
  /** Audio tokens the voice generated (Realtime pricing). */
  audioOutputTokens: number;
  /** Text tokens it was given. */
  textInputTokens: number;
  /** Characters spoken (for providers that bill per character). */
  characters: number;
}

export interface VoiceEvents {
  /** A chunk of speech for sentence `sentenceId`, base64 in the provider's `format`. */
  onAudio(audio: string, sentenceId: number): void;
  /** All audio of the sentence has been produced (it may still be playing at the caller). */
  onSentenceDone(sentenceId: number): void;
  onUsage?(usage: VoiceUsage): void;
  onError(error: Error): void;
}

export interface VoiceProvider {
  /** Audio format of the chunks: the phone line's own mu-law 8 kHz or PCM 24 kHz. */
  readonly format: "mulaw8" | "pcm24";
  readonly name: string;
  readonly model: string;
  start(events: VoiceEvents): Promise<void>;
  /** Queue one sentence. Sentences are spoken in the order they were given. */
  speak(sentenceId: number, text: string): void;
  /** Forget everything queued and stop what is being generated; audio of the cancelled sentences is dropped. */
  cancel(): void;
  close(): void;
}
