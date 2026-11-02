import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssistantSettings } from "../src/config";

// LEA-155: what happens on the Standard session when the caller talks over the assistant, and how audio is exchanged.

const h = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>>, handlers: {} as Record<string, (arg?: unknown) => void> }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    constructor(public url: string) {}
    on(event: string, fn: (arg?: unknown) => void) { h.handlers[event] = fn; return this; }
    send(data: string) { h.sent.push(JSON.parse(data)); }
    close() {}
  }
  return { WebSocket: FakeWS };
});

process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { CallSession } = await import("../src/session");

const settings = { project_id: "proj-1", capabilities: {} } as unknown as AssistantSettings;
const MS_8000_MULAW = Buffer.alloc(64_000).toString("base64"); // 8 s of 8 kHz mu-law

function makeCallbacks() {
  return { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn(), clearAudio: vi.fn() };
}

async function startSession(audio?: "pcmu" | "pcm24") {
  const callbacks = makeCallbacks();
  const session = new CallSession("proj-1", null, null, callbacks, settings, undefined, audio ? { audio } : {});
  await session.start();
  h.handlers["open"]();
  const says = (msg: Record<string, unknown>) => h.handlers["message"](Buffer.from(JSON.stringify(msg)));
  return { session, callbacks, says };
}
const sentOfType = (type: string) => h.sent.filter((m) => m["type"] === type);

beforeEach(() => {
  h.sent = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("audio format with OpenAI", () => {
  it("speaks PCM 24 kHz by default", async () => {
    const { session } = await startSession();
    const update = sentOfType("session.update")[0] as { session: { audio: { input: { format: unknown }; output: { format: unknown } } } };
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(update.session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(session.audioFormat).toBe("pcm24");
  });

  it("speaks the phone line's own format (mu-law) when asked, and passes the assistant's audio on as mu-law", async () => {
    const { session, callbacks, says } = await startSession("pcmu");
    const update = sentOfType("session.update")[0] as { session: { audio: { input: { format: unknown }; output: { format: unknown } } } };
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.output.format).toEqual({ type: "audio/pcmu" });
    expect(session.audioFormat).toBe("mulaw8");

    says({ type: "response.output_audio.delta", item_id: "item_1", delta: "QUJD" });
    expect(callbacks.sendAudio).toHaveBeenCalledWith("QUJD", "mulaw8");
  });

  it("tells the client the engine stops the assistant on an interruption", async () => {
    const { callbacks } = await startSession();
    await vi.waitFor(() => expect(callbacks.sendJson).toHaveBeenCalledWith(expect.objectContaining({ type: "proxy.connected", barge_in: "engine" })));
  });
});

describe("the caller's first words", () => {
  it("are kept until OpenAI has accepted the session settings, then sent in order", async () => {
    const { session, says } = await startSession("pcmu");
    session.handleClientAudio("AAAA");
    session.handleClientAudio("BBBB");
    expect(sentOfType("input_audio_buffer.append")).toHaveLength(0);

    says({ type: "session.updated" });
    expect(sentOfType("input_audio_buffer.append").map((m) => m["audio"])).toEqual(["AAAA", "BBBB"]);

    session.handleClientAudio("CCCC");
    expect(sentOfType("input_audio_buffer.append").map((m) => m["audio"])).toEqual(["AAAA", "BBBB", "CCCC"]);
  });
});

describe("the caller interrupts the assistant", () => {
  it("empties the phone line and tells OpenAI how much of the answer was heard", async () => {
    const { callbacks, says } = await startSession("pcmu");
    says({ type: "session.updated" });
    says({ type: "response.created" });
    says({ type: "response.output_audio.delta", item_id: "item_1", delta: MS_8000_MULAW }); // 8 s queued at once

    vi.setSystemTime(1_000_000 + 2000); // the caller has heard 2 s
    says({ type: "input_audio_buffer.speech_started" });

    expect(callbacks.clearAudio).toHaveBeenCalledOnce();
    expect(callbacks.sendJson).toHaveBeenCalledWith({ type: "engine.clear_audio" });
    expect(sentOfType("conversation.item.truncate")).toEqual([
      { type: "conversation.item.truncate", item_id: "item_1", content_index: 0, audio_end_ms: 2000 },
    ]);
  });

  it("drops the rest of the cancelled answer that is still on its way, until the next answer starts", async () => {
    const { callbacks, says } = await startSession("pcmu");
    says({ type: "session.updated" });
    says({ type: "response.created" });
    says({ type: "response.output_audio.delta", item_id: "item_1", delta: MS_8000_MULAW });
    callbacks.sendAudio.mockClear();

    vi.setSystemTime(1_000_000 + 1000);
    says({ type: "input_audio_buffer.speech_started" });
    says({ type: "response.output_audio.delta", item_id: "item_1", delta: "QUJD" });
    expect(callbacks.sendAudio).not.toHaveBeenCalled();

    says({ type: "response.created" });
    says({ type: "response.output_audio.delta", item_id: "item_2", delta: "REVG" });
    expect(callbacks.sendAudio).toHaveBeenCalledWith("REVG", "mulaw8");
  });

  it("does nothing when the assistant has already finished playing", async () => {
    const { callbacks, says } = await startSession("pcmu");
    says({ type: "session.updated" });
    says({ type: "response.output_audio.delta", item_id: "item_1", delta: Buffer.alloc(8000).toString("base64") }); // 1 s
    vi.setSystemTime(1_000_000 + 3000);
    says({ type: "input_audio_buffer.speech_started" });

    expect(callbacks.clearAudio).not.toHaveBeenCalled();
    expect(sentOfType("conversation.item.truncate")).toHaveLength(0);
  });

  it("measures an answer that arrives behind another one from where it actually starts to play", async () => {
    const { says } = await startSession("pcmu");
    says({ type: "session.updated" });
    says({ type: "response.output_audio.delta", item_id: "item_1", delta: Buffer.alloc(24_000).toString("base64") }); // 3 s
    says({ type: "response.output_audio.delta", item_id: "item_2", delta: Buffer.alloc(24_000).toString("base64") }); // 3 s behind it

    vi.setSystemTime(1_000_000 + 4000); // 1 s into the second item
    says({ type: "input_audio_buffer.speech_started" });
    expect(sentOfType("conversation.item.truncate")[0]).toMatchObject({ item_id: "item_2", audio_end_ms: 1000 });
  });
});
