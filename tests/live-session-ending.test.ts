import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import type { AssistantSettings } from "../src/config";

const mocks = vi.hoisted(() => ({ generateCallSummary: vi.fn(), sendSmsNotifications: vi.fn() }));
vi.mock("../src/call-logger", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/call-logger")>()), generateCallSummary: mocks.generateCallSummary }));
vi.mock("../src/sms", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/sms")>()), sendSmsNotifications: mocks.sendSmsNotifications }));
vi.stubGlobal("fetch", vi.fn());
process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { LiveCallSession } = await import("../src/live-session");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit("close", 1000); }
  drop() { this.readyState = 3; this.emit("close", 1006); }
  serverSays(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
  ofType(type: string) { return this.sent.filter((m) => m["type"] === type); }
}

const settings = (extra: Record<string, unknown> = {}) => ({
  project_id: "proj-1", system_prompt: "Be kind.", voice: "marin", language: "cs",
  capabilities: { end_call: true }, greeting_enabled: false, greeting_message: null, _calendar_project_id: "cal-1", knowledge_top_n: 5, ...extra,
}) as unknown as AssistantSettings;

async function startSession(s = settings(), sid: string | null = "CA1") {
  const sockets: FakeSocket[] = [];
  const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() };
  const session = new LiveCallSession(s, "proj-1", "+420111222333", sid, callbacks, {
    connect: () => { const sock = new FakeSocket(); sockets.push(sock); return sock as unknown as WebSocket; },
    executeTool: vi.fn(async () => ({ result: { ok: true }, embeddingTokens: 0 })),
  });
  const started = session.start();
  sockets[0].emit("open");
  sockets[0].serverSays({ type: "session.started" });
  await started;
  return { session, sockets, callbacks };
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const spoken = (sock: FakeSocket) => sock.ofType("session.instructions.append").map((m) => String(m["content"])).join("\n");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.generateCallSummary.mockReset().mockResolvedValue({ title: "T", summary: "S", ownerSms: null, callerSms: null, emailOwner: null, summaryInputTokens: 1, summaryOutputTokens: 1 });
  mocks.sendSmsNotifications.mockReset().mockResolvedValue({ ownerSent: false, callerSent: false });
});
afterEach(() => vi.useRealTimers());

describe("Live: silence and call length (LEA-160)", () => {
  it("asks 'Jste tam ještě?' after 6 s of silence, then says goodbye and hangs up after 6 s more", async () => {
    const { sockets, callbacks } = await startSession();
    await vi.advanceTimersByTimeAsync(6000);
    expect(spoken(sockets[0])).toContain("Jste tam ještě?");
    await vi.advanceTimersByTimeAsync(6000);
    expect(spoken(sockets[0])).toContain("hovor ukončím");
    // the goodbye is spoken, then the line closes on the mark
    sockets[0].serverSays({ type: "session.output_audio.delta", delta: Buffer.alloc(800, 0x10).toString("base64") });
    await vi.advanceTimersByTimeAsync(1300);
    expect(callbacks.sendMark).toHaveBeenCalledTimes(1);
  });

  it("the caller's words keep the call going", async () => {
    const { sockets } = await startSession();
    await vi.advanceTimersByTimeAsync(5000);
    sockets[0].serverSays({ type: "session.input_transcript.delta", delta: "dobrý den" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(spoken(sockets[0])).not.toContain("Jste tam");
  });

  it("a test call (no phone call id) has no length limit of its own", async () => {
    const { sockets, callbacks } = await startSession(settings({ max_call_minutes: 2 }), null);
    for (let i = 0; i < 20; i++) { sockets[0].serverSays({ type: "session.input_transcript.delta", delta: "a" }); await vi.advanceTimersByTimeAsync(5000); }
    expect(callbacks.sendMark).not.toHaveBeenCalled();
  });

  it("a phone call is warned a minute before the limit and ends at it", async () => {
    const { sockets, callbacks } = await startSession(settings({ max_call_minutes: 2 }));
    for (let i = 0; i < 12; i++) { sockets[0].serverSays({ type: "session.input_transcript.delta", delta: "a" }); await vi.advanceTimersByTimeAsync(5000); }
    expect(spoken(sockets[0])).toContain("za minutu automaticky ukončí");
    for (let i = 0; i < 12; i++) { sockets[0].serverSays({ type: "session.input_transcript.delta", delta: "a" }); await vi.advanceTimersByTimeAsync(5000); }
    expect(spoken(sockets[0])).toContain("došel čas hovoru");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(callbacks.sendMark).toHaveBeenCalled();
  });
});

describe("Live: lost connection (LEA-160)", () => {
  it("makes the connection again, tells the new session what was said and does not greet again", async () => {
    const { sockets, callbacks } = await startSession(settings({ greeting_enabled: true, greeting_message: "Dobrý den" }));
    sockets[0].serverSays({ type: "session.input_transcript.delta", delta: "Chci se objednat" });
    sockets[0].drop();
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].emit("open");
    const resumeStart = sockets[1].ofType("session.start")[0] as { session: { instructions: string } };
    expect(resumeStart.session.instructions).toContain("CALL IN PROGRESS");
    sockets[1].serverSays({ type: "session.started" });
    await flush();
    expect(spoken(sockets[1])).toContain("Omlouvám se za chvilkový výpadek");
    expect(spoken(sockets[1])).not.toContain("Dobrý den"); // no second greeting
    expect(callbacks.endCall).not.toHaveBeenCalled();
  });

  it("apologises and ends the call when it cannot be made again", async () => {
    const { sockets, callbacks, session } = await startSession();
    sockets[0].drop();
    await flush();
    sockets[1].emit("open");
    sockets[1].drop();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    sockets[2].emit("open");
    sockets[2].drop();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(callbacks.sendMark).toHaveBeenCalledTimes(1);
    const mark = callbacks.sendMark.mock.calls[0][0] as string;
    session.handleTwilioMark(mark);
    expect(callbacks.endCall).toHaveBeenCalled();
  });
});
