import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssistantSettings } from "../src/config";

// LEA-158/160 on the Standard session: taking a hang-up back, the silence question, a lost connection.

type Handlers = Record<string, (arg?: unknown) => void>;
const h = vi.hoisted(() => ({ sockets: [] as Array<{ sent: Array<Record<string, unknown>>; handlers: Record<string, (arg?: unknown) => void> }> }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    handlers: Handlers = {};
    constructor(public url: string) { h.sockets.push(this); }
    on(event: string, fn: (arg?: unknown) => void) { this.handlers[event] = fn; return this; }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  return { WebSocket: FakeWS };
});

process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { CallSession } = await import("../src/session");

const settings = { project_id: "proj-1", language: "cs", capabilities: {}, greeting_enabled: true, greeting_message: "Dobrý den" } as unknown as AssistantSettings;

async function startSession(sid: string | null = "CA1") {
  const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn(), clearAudio: vi.fn() };
  const session = new CallSession("proj-1", null, sid, callbacks, settings, undefined, { audio: "pcmu" });
  await session.start();
  const sock = () => h.sockets[h.sockets.length - 1];
  sock().handlers["open"]();
  const says = (msg: Record<string, unknown>) => sock().handlers["message"](Buffer.from(JSON.stringify(msg)));
  says({ type: "session.updated" });
  return { session, callbacks, says, sock };
}
const endCallCall = { type: "response.function_call_arguments.done", name: "end_call", call_id: "c1", arguments: JSON.stringify({ reason: "done" }) };
const instructionsOf = (sock: { sent: Array<Record<string, unknown>> }) => sock.sent.filter((m) => m["type"] === "response.create").map((m) => JSON.stringify(m)).join("\n");

beforeEach(() => { h.sockets.length = 0; vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

describe("Standard: end_call (LEA-158)", () => {
  it("hangs up on the mark and ends the call only then", async () => {
    const { callbacks, says, session } = await startSession();
    says(endCallCall);
    await vi.advanceTimersByTimeAsync(10);
    expect(callbacks.sendMark).toHaveBeenCalledTimes(1);
    expect(callbacks.endCall).not.toHaveBeenCalled();
    session.handleTwilioMark(callbacks.sendMark.mock.calls[0][0] as string);
    expect(callbacks.endCall).toHaveBeenCalledTimes(1);
  });

  it("keeps the call open when the caller speaks after the goodbye (the old mark is ignored)", async () => {
    const { callbacks, says, session } = await startSession();
    says(endCallCall);
    await vi.advanceTimersByTimeAsync(2000);
    says({ type: "input_audio_buffer.speech_started" });
    session.handleTwilioMark(callbacks.sendMark.mock.calls[0][0] as string);
    expect(callbacks.endCall).not.toHaveBeenCalled();
  });

  it("does not take the hang-up back for the caller's own goodbye right after end_call", async () => {
    const { callbacks, says, session } = await startSession();
    says(endCallCall);
    await vi.advanceTimersByTimeAsync(500);
    says({ type: "input_audio_buffer.speech_started" });
    session.handleTwilioMark(callbacks.sendMark.mock.calls[0][0] as string);
    expect(callbacks.endCall).toHaveBeenCalledTimes(1);
  });
});

describe("Standard: silence and lost connection (LEA-160)", () => {
  it("asks 'Jste tam ještě?' after 6 s of silence", async () => {
    const { sock } = await startSession();
    await vi.advanceTimersByTimeAsync(6000);
    expect(instructionsOf(sock())).toContain("Jste tam ještě?");
  });

  it("does not ask while the model is still answering", async () => {
    const { sock, says } = await startSession();
    says({ type: "response.created" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(instructionsOf(sock())).not.toContain("Jste tam");
  });

  it("makes the connection again after a drop, without a second greeting", async () => {
    const { callbacks, says, sock } = await startSession();
    const first = sock();
    first.handlers["close"](1006);
    await vi.advanceTimersByTimeAsync(5);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].handlers["open"]();
    const update = h.sockets[1].sent.find((m) => m["type"] === "session.update") as { session: { instructions: string } };
    expect(update.session.instructions).toContain("CALL IN PROGRESS");
    says({ type: "session.updated" });
    await vi.advanceTimersByTimeAsync(5);
    expect(JSON.stringify(h.sockets[1].sent)).toContain("Omlouvám se za chvilkový výpadek");
    expect(h.sockets[1].sent.some((m) => m["type"] === "response.create" && !JSON.stringify(m).includes("Omlouvám"))).toBe(false); // no greeting
    expect(callbacks.endCall).not.toHaveBeenCalled();
  });

  it("ends the call after two failed attempts", async () => {
    const { callbacks, session } = await startSession();
    h.sockets[0].handlers["close"](1006);
    await vi.advanceTimersByTimeAsync(5);
    h.sockets[1].handlers["close"](1006);
    await vi.advanceTimersByTimeAsync(5);
    h.sockets[2].handlers["close"](1006);
    await vi.advanceTimersByTimeAsync(5);
    expect(callbacks.sendMark).toHaveBeenCalledTimes(1);
    session.handleTwilioMark(callbacks.sendMark.mock.calls[0][0] as string);
    expect(callbacks.endCall).toHaveBeenCalled();
  });
});
