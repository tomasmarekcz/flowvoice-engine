import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import type { WebSocket as WS } from "ws";

const h = vi.hoisted(() => ({ startCallSession: vi.fn() }));

vi.mock("../src/session-factory", () => ({ startCallSession: h.startCallSession }));

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { handleTwilioConnection } = await import("../src/handlers/twilio");
const { linearToMulaw } = await import("../src/audio");

class FakeTwilioSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit("close"); }
  says(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}

function fakeSession(audioFormat: "pcm24" | "mulaw8") {
  return {
    audioFormat,
    start: vi.fn(),
    handleClientAudio: vi.fn(),
    handleTwilioMark: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

async function connect(audioFormat: "pcm24" | "mulaw8") {
  const socket = new FakeTwilioSocket();
  const session = fakeSession(audioFormat);
  h.startCallSession.mockResolvedValue(session);

  await handleTwilioConnection(socket as unknown as WS, {} as IncomingMessage);
  socket.says({
    event: "start",
    streamSid: "MZ1",
    start: { customParameters: { project_id: "proj-1", caller_phone: "+420111", call_sid: "CA1" } },
  });
  await vi.waitFor(() => expect(h.startCallSession).toHaveBeenCalledOnce());
  // Let the awaited start finish so the handler stores the session.
  await new Promise((r) => setImmediate(r));

  const callbacks = h.startCallSession.mock.calls[0][3] as {
    sendAudio: (audio: string, format?: "pcm24" | "mulaw8") => void;
    sendMark: (name: string) => void;
  };
  return { socket, session, callbacks };
}

// 160 mu-law bytes (20 ms) of a simple tone, as Twilio would send them.
const mulawPayload = Buffer.from(
  Array.from({ length: 160 }, (_, i) => linearToMulaw(Math.round(Math.sin(i / 5) * 8000)))
).toString("base64");

beforeEach(() => h.startCallSession.mockReset());

describe("Twilio handler session wiring", () => {
  it("starts the session with the stream's project, caller and call sid", async () => {
    await connect("pcm24");
    const [projectId, callerPhone, callSid] = h.startCallSession.mock.calls[0];
    expect([projectId, callerPhone, callSid]).toEqual(["proj-1", "+420111", "CA1"]);
  });

  it("passes Twilio mu-law to a mulaw8 session untouched", async () => {
    const { socket, session } = await connect("mulaw8");
    socket.says({ event: "media", media: { payload: mulawPayload } });
    expect(session.handleClientAudio).toHaveBeenCalledWith(mulawPayload);
  });

  it("transcodes Twilio audio to PCM 24 kHz for a pcm24 session", async () => {
    const { socket, session } = await connect("pcm24");
    socket.says({ event: "media", media: { payload: mulawPayload } });
    const sent = session.handleClientAudio.mock.calls[0][0] as string;
    expect(sent).not.toBe(mulawPayload);
    // 160 mu-law samples at 8 kHz become 480 PCM16 samples at 24 kHz = 960 bytes.
    expect(Buffer.from(sent, "base64")).toHaveLength(960);
  });

  it("sends mulaw8 session audio to Twilio unchanged", async () => {
    const { socket, callbacks } = await connect("mulaw8");
    callbacks.sendAudio("QUJD", "mulaw8");
    const media = socket.sent.find((m) => m["event"] === "media");
    expect((media?.["media"] as { payload: string }).payload).toBe("QUJD");
    expect(media?.["streamSid"]).toBe("MZ1");
  });

  it("converts PCM 24 kHz session audio to mu-law for Twilio", async () => {
    const { socket, callbacks } = await connect("pcm24");
    const pcm24 = Buffer.alloc(960).toString("base64");
    callbacks.sendAudio(pcm24);
    const media = socket.sent.find((m) => m["event"] === "media");
    const payload = (media?.["media"] as { payload: string }).payload;
    expect(Buffer.from(payload, "base64")).toHaveLength(160);
  });

  it("forwards Twilio marks to the session", async () => {
    const { socket, session } = await connect("mulaw8");
    socket.says({ event: "mark", mark: { name: "end-call-1" } });
    expect(session.handleTwilioMark).toHaveBeenCalledWith("end-call-1");
  });

  it("ends the session when the Twilio stream stops", async () => {
    const { socket, session } = await connect("mulaw8");
    socket.says({ event: "stop" });
    await vi.waitFor(() => expect(session.end).toHaveBeenCalled());
  });
});
