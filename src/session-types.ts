export type AudioFormat = "pcm24" | "mulaw8";

export interface SessionCallbacks {
  // `format` describes the audio being sent; omitted means PCM 24 kHz (Standard).
  sendAudio: (audio: string, format?: AudioFormat) => void;
  sendJson: (obj: unknown) => void;
  sendMark: (name: string) => void;
  endCall: () => void;
}

export interface VoiceSession {
  // Format of the audio this session expects from handleClientAudio.
  readonly audioFormat: AudioFormat;
  start(): Promise<void>;
  handleClientAudio(audio: string): void;
  handleTwilioMark(name: string): void;
  // Other client messages (browser test call only); the Live session has none.
  handleClientEvent?(msg: Record<string, unknown>): void;
  end(): Promise<void>;
}
