import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import type { AssistantSettings } from "../src/config";

const mocks = vi.hoisted(() => ({
  generateCallSummary: vi.fn(),
  sendSmsNotifications: vi.fn(),
}));

vi.mock("../src/call-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/call-logger")>();
  return { ...actual, generateCallSummary: mocks.generateCallSummary };
});
vi.mock("../src/sms", () => ({ sendSmsNotifications: mocks.sendSmsNotifications }));

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
  serverSays(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
  sentOfType(type: string) { return this.sent.filter((m) => m["type"] === type); }
}

function baseSettings(overrides: Record<string, unknown> = {}): AssistantSettings {
  return {
    project_id: "proj-1",
    system_prompt: "Be kind.",
    voice: "marin",
    capabilities: { enquiries: true, end_call: true, calendar: true },
    greeting_enabled: false,
    greeting_message: null,
    _calendar_project_id: "cal-1",
    knowledge_top_n: 5,
    ...overrides,
  } as unknown as AssistantSettings;
}

function functionCallEvent(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: "response.event",
    delegation_id: "d1",
    event: {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
    },
  };
}

function makeSession(settings: AssistantSettings | null = baseSettings()) {
  const socket = new FakeSocket();
  const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() };
  const runTool = vi.fn(async () => ({ result: { ok: true }, embeddingTokens: 2 }));
  const session = new LiveCallSession(settings, "proj-1", "+420111222333", "CA1", callbacks, {
    connect: () => socket as unknown as WebSocket,
    executeTool: runTool,
  });
  return { session, socket, callbacks, runTool };
}

async function startSession(settings: AssistantSettings | null = baseSettings()) {
  const parts = makeSession(settings);
  const started = parts.session.start();
  parts.socket.emit("open");
  parts.socket.serverSays({ type: "session.started" });
  await started;
  return parts;
}

beforeEach(() => {
  mocks.generateCallSummary.mockReset().mockResolvedValue({
    title: "T", summary: "S", ownerSms: null, callerSms: null, emailOwner: null,
    summaryInputTokens: 1, summaryOutputTokens: 2,
  });
  mocks.sendSmsNotifications.mockReset().mockResolvedValue({ ownerSent: false, callerSent: false });
});

afterEach(() => vi.useRealTimers());

describe("LiveCallSession start", () => {
  it("sends session.start on open and reports mu-law audio", async () => {
    const { session, socket } = await startSession();
    const [start] = socket.sentOfType("session.start");
    expect((start["session"] as { model: string }).model).toBe("gpt-live-1");
    expect(session.audioFormat).toBe("mulaw8");
  });

  it("rejects when the socket errors before session.started", async () => {
    const { session, socket } = makeSession();
    const started = session.start();
    socket.emit("error", new Error("boom"));
    await expect(started).rejects.toThrow("boom");
  });

  it("rejects when the socket closes before session.started", async () => {
    const { session, socket } = makeSession();
    const started = session.start();
    socket.emit("close", 1006);
    await expect(started).rejects.toThrow("closed before start");
  });

  it("rejects after the start timeout", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const started = session.start();
    const assertion = expect(started).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
  });

  it("speaks the greeting once the session has started", async () => {
    const { socket } = await startSession(
      baseSettings({ greeting_enabled: true, greeting_message: "Hello from Acme" })
    );
    const [greeting] = socket.sentOfType("session.instructions.append");
    expect(greeting["content"]).toContain("Hello from Acme");
    expect(greeting["delegation_id"]).toBeNull();
  });

  it("does not wait for the database write before greeting the caller", async () => {
    const { CallLogger } = await import("../src/call-logger");
    const createCall = vi.spyOn(CallLogger.prototype, "createCall").mockReturnValue(new Promise(() => {}));
    const { session, socket } = makeSession(
      baseSettings({ greeting_enabled: true, greeting_message: "Hello from Acme" })
    );
    void session.start();
    socket.emit("open");
    socket.serverSays({ type: "session.started" });
    await vi.waitFor(() => expect(socket.sentOfType("session.instructions.append")).toHaveLength(1));
    expect(createCall).toHaveBeenCalled();
    createCall.mockRestore();
  });
});

describe("LiveCallSession audio", () => {
  it("drops caller audio until the session has started, then forwards it", async () => {
    const { session, socket } = makeSession();
    const started = session.start();
    socket.emit("open");
    session.handleClientAudio("AAAA");
    expect(socket.sentOfType("session.input_audio.append")).toHaveLength(0);

    socket.serverSays({ type: "session.started" });
    await started;
    session.handleClientAudio("BBBB");
    expect(socket.sentOfType("session.input_audio.append")).toEqual([
      { type: "session.input_audio.append", audio: "BBBB" },
    ]);
  });

  it("passes output audio to Twilio unchanged, tagged as mu-law", async () => {
    const { socket, callbacks } = await startSession();
    socket.serverSays({ type: "session.output_audio.delta", delta: "QUJD" });
    expect(callbacks.sendAudio).toHaveBeenCalledWith("QUJD", "mulaw8");
  });
});

describe("LiveCallSession tools", () => {
  it("runs a tool and returns the result, then asks the backend to continue", async () => {
    const { socket, runTool } = await startSession();
    socket.serverSays(functionCallEvent("call_1", "get_services", {}));

    await vi.waitFor(() => expect(socket.sentOfType("response.create")).toHaveLength(1));
    expect(runTool.mock.calls[0][0]).toBe("get_services");
    const [out] = socket.sentOfType("response.item.create");
    expect(out["item"]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ ok: true }),
    });
  });
});

describe("LiveCallSession end_call", () => {
  it("returns the result without continuing and hangs up once the goodbye audio is quiet", async () => {
    vi.useFakeTimers();
    const { session, socket, callbacks } = await startSession();

    socket.serverSays(functionCallEvent("call_9", "end_call", { reason: "done" }));
    expect(socket.sentOfType("response.item.create")).toHaveLength(1);
    expect(socket.sentOfType("response.create")).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    socket.serverSays({ type: "session.output_audio.delta", delta: "AAA=" });
    vi.advanceTimersByTime(1000);
    expect(callbacks.sendMark).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(callbacks.sendMark).toHaveBeenCalledOnce();

    session.handleTwilioMark(callbacks.sendMark.mock.calls[0][0] as string);
    expect(callbacks.endCall).toHaveBeenCalledOnce();
  });

  it("hangs up anyway if Twilio never echoes the mark", async () => {
    vi.useFakeTimers();
    const { socket, callbacks } = await startSession();

    socket.serverSays(functionCallEvent("call_9", "end_call", { reason: "done" }));
    vi.advanceTimersByTime(1200);
    expect(callbacks.sendMark).toHaveBeenCalledOnce();
    expect(callbacks.endCall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15000);
    expect(callbacks.endCall).toHaveBeenCalledOnce();
  });

  it("ignores a mark that is not the hang-up mark", async () => {
    vi.useFakeTimers();
    const { session, socket, callbacks } = await startSession();
    socket.serverSays(functionCallEvent("call_9", "end_call", { reason: "done" }));
    vi.advanceTimersByTime(1200);
    session.handleTwilioMark("something-else");
    expect(callbacks.endCall).not.toHaveBeenCalled();
  });
});

describe("LiveCallSession end", () => {
  it("hands the accumulated transcript to the summary step", async () => {
    const { session, socket } = await startSession();
    socket.serverSays({ type: "session.input_transcript.delta", delta: "Hi, I need " });
    socket.serverSays({ type: "session.input_transcript.delta", delta: "a plumber." });
    socket.serverSays({ type: "session.output_transcript.delta", delta: "Sure, " });
    socket.serverSays({ type: "session.output_transcript.delta", delta: "what is your address?" });

    await session.end();

    const transcript = mocks.generateCallSummary.mock.calls[0][1];
    expect(transcript).toEqual([
      expect.objectContaining({ role: "user", text: "Hi, I need a plumber." }),
      expect.objectContaining({ role: "assistant", text: "Sure, what is your address?" }),
    ]);
  });

  it("finalizes only once even if end() is called after end_call", async () => {
    const { session, socket } = await startSession();
    socket.serverSays(functionCallEvent("call_9", "end_call", { reason: "done" }));
    await session.end();
    await session.end();
    expect(mocks.generateCallSummary).toHaveBeenCalledOnce();
  });

  it("abort closes the socket without generating a summary", async () => {
    const { session, socket } = await startSession();
    await session.abort();
    expect(socket.readyState).toBe(3);
    expect(mocks.generateCallSummary).not.toHaveBeenCalled();
  });
});
