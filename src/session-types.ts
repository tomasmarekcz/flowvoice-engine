export type AudioFormat = "pcm24" | "mulaw8";

export interface SessionCallbacks {
  // `format` describes the audio being sent; omitted means PCM 24 kHz (Standard).
  sendAudio: (audio: string, format?: AudioFormat) => void;
  sendJson: (obj: unknown) => void;
  sendMark: (name: string) => void;
  endCall: () => void;
  // Empty the phone line's queue of audio not played yet (a Twilio "clear"). Absent where the client does it itself.
  clearAudio?: () => void;
}

export interface VoiceSession {
  // Format of the audio this session expects from handleClientAudio.
  readonly audioFormat: AudioFormat;
  start(): Promise<void>;
  handleClientAudio(audio: string): void;
  handleTwilioMark(name: string): void;
  // Other client messages (browser test call only); the Live session has none.
  handleClientEvent?(msg: Record<string, unknown>): void;
  // The line's own clock (Twilio's media timestamp, ms) and loudness of one inbound frame, for the line-quality numbers.
  noteInboundFrame?(timestampMs: number, levelDbfs: number): void;
  end(): Promise<void>;
}
