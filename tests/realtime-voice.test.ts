import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { RealtimeVoice } from "../src/voice/realtime-voice";

// LEA-209: the voice gets the sentence inside the instruction of the response, not as a message from the caller.
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { /* nothing */ }
}

describe("RealtimeVoice", () => {
  it("reads a sentence from the response instruction and adds nothing to the conversation", async () => {
    const ws = new FakeWs();
    const voice = new RealtimeVoice({ voice: "marin", apiKey: "test", connect: () => ws as unknown as WebSocket });
    const started = voice.start({ onAudio: () => {}, onSentenceDone: () => {}, onError: () => {} });
    ws.emit("open");
    ws.emit("message", JSON.stringify({ type: "session.updated" }));
    await started;
    voice.speak(1, "Dobrý den, jak vám mohu pomoci?");

    expect(ws.sent.some((m) => m["type"] === "conversation.item.create")).toBe(false);
    const create = ws.sent.find((m) => m["type"] === "response.create") as { response: { conversation: string; input: unknown[]; instructions: string } };
    expect(create.response.conversation).toBe("none");
    expect(create.response.input).toEqual([]);
    expect(create.response.instructions).toContain('"Dobrý den, jak vám mohu pomoci?"');
  });
});
