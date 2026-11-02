import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import type { AssistantSettings } from "../src/config";

// LEA-154: the sessions feed the quality tracker from the OpenAI events and write the totals at the end of the call.

const mocks = vi.hoisted(() => ({
  generateCallSummary: vi.fn(),
  sendSmsNotifications: vi.fn(),
  standard: { handlers: {} as Record<string, (arg?: unknown) => void> },
}));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    constructor(public url: string) {}
    on(event: string, fn: (arg?: unknown) => void) { mocks.standard.handlers[event] = fn; return this; }
    send() {}
    close() {}
  }
  return { WebSocket: FakeWS };
});
vi.mock("../src/call-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/call-logger")>();
  return { ...actual, generateCallSummary: mocks.generateCallSummary };
});
vi.mock("../src/sms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sms")>()),
  sendSmsNotifications: mocks.sendSmsNotifications,
}));

vi.stubGlobal("fetch", vi.fn());
process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { CallLogger } = await import("../src/call-logger");
const { CallSession } = await import("../src/session");
const { LiveCallSession } = await import("../src/live-session");

const callbacks = () => ({ sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() });
const settings = { project_id: "proj-1", capabilities: { end_call: true } } as unknown as AssistantSettings;
// 3 s of 24 kHz PCM16 (144 000 bytes) and 3 s of 8 kHz mu-law (24 000 bytes)
const THREE_SECONDS_PCM24 = Buffer.alloc(144_000).toString("base64");
const THREE_SECONDS_MULAW = Buffer.alloc(24_000).toString("base64");

let events: Array<[string, Record<string, unknown>]>;
let saved: Array<Record<string, unknown>>;

beforeEach(() => {
  events = [];
  saved = [];
  mocks.generateCallSummary.mockReset().mockResolvedValue({
    title: "T", summary: "S", ownerSms: null, callerSms: null, emailOwner: null,
    summaryInputTokens: 1, summaryOutputTokens: 2,
  });
  mocks.sendSmsNotifications.mockReset().mockResolvedValue({ ownerSent: false, callerSent: false });
  vi.spyOn(CallLogger.prototype, "logEvent").mockImplementation((type, _direction, payload) => {
    events.push([type, payload as Record<string, unknown>]);
  });
  vi.spyOn(CallLogger.prototype, "saveQuality").mockImplementation(async (stats) => { saved.push({ ...stats }); });
});

function openaiSays(msg: Record<string, unknown>) {
  mocks.standard.handlers["message"](Buffer.from(JSON.stringify(msg)));
}

describe("Standard session quality", () => {
  it("records a caller who speaks over the assistant and saves the totals when the call ends", async () => {
    const session = new CallSession("proj-1", null, null, callbacks(), settings);
    await session.start();

    openaiSays({ type: "response.output_audio.delta", delta: THREE_SECONDS_PCM24 });
    openaiSays({ type: "input_audio_buffer.speech_started" });
    openaiSays({ type: "input_audio_buffer.speech_stopped" });
    openaiSays({ type: "conversation.item.input_audio_transcription.completed", transcript: "Moment prosím" });
    await vi.waitFor(() => expect(events.map((e) => e[0])).toContain("quality.interruption"));

    await session.end();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ interruptions: 1, false_triggers: 0, fallback: false });
  });

  it("counts noise as a false trigger", async () => {
    const session = new CallSession("proj-1", null, null, callbacks(), settings);
    await session.start();

    openaiSays({ type: "input_audio_buffer.speech_started" });
    openaiSays({ type: "conversation.item.input_audio_transcription.completed", transcript: "" });
    await vi.waitFor(() => expect(events.map((e) => e[0])).toContain("quality.false_trigger"));

    await session.end();
    expect(saved[0]).toMatchObject({ interruptions: 0, false_triggers: 1 });
  });

  it("records a lost connection while the call is running, but not the normal close at the end", async () => {
    const session = new CallSession("proj-1", null, null, callbacks(), settings);
    await session.start();

    mocks.standard.handlers["close"](1006);
    expect(events).toContainEqual(["quality.disconnect", { code: 1006 }]);

    await session.end();
    mocks.standard.handlers["close"](1000);
    expect(events.filter((e) => e[0] === "quality.disconnect")).toHaveLength(1);
  });

  it("records that the call started on Standard because Live failed", async () => {
    const session = new CallSession("proj-1", null, null, callbacks(), settings, undefined, "live timed out");
    await session.start();

    expect(events).toContainEqual(["quality.engine_fallback", { reason: "live timed out" }]);
    await session.end();
    expect(saved[0]).toMatchObject({ fallback: true });
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; }
  serverSays(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}

describe("Live session quality", () => {
  async function startLive() {
    const socket = new FakeSocket();
    const session = new LiveCallSession(settings, "proj-1", null, "CA1", callbacks(), {
      connect: () => socket as unknown as WebSocket,
      executeTool: vi.fn(async () => ({ result: { error: "calendar down" }, embeddingTokens: 0 })),
    });
    const started = session.start();
    socket.emit("open");
    socket.serverSays({ type: "session.started" });
    await started;
    return { session, socket };
  }

  it("infers an interruption from the caller's transcript over the assistant's audio and saves the totals", async () => {
    const { session, socket } = await startLive();
    socket.serverSays({ type: "session.output_audio.delta", delta: THREE_SECONDS_MULAW });
    socket.serverSays({ type: "session.input_transcript.delta", delta: "Počkejte" });

    await vi.waitFor(() => expect(events.map((e) => e[0])).toContain("quality.interruption"));
    expect(events.find((e) => e[0] === "quality.interruption")![1]).toMatchObject({ inferred: true });

    await session.end();
    expect(saved[0]).toMatchObject({ interruptions: 1 });
  });

  it("records a tool that came back with an error", async () => {
    const { session, socket } = await startLive();
    socket.serverSays({
      type: "response.event",
      event: { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "create_calendar_event", arguments: "{}" } },
    });
    await vi.waitFor(() => expect(events.map((e) => e[0])).toContain("quality.tool_problem"));
    expect(events.find((e) => e[0] === "quality.tool_problem")![1]).toMatchObject({ tool: "create_calendar_event", kind: "error" });

    await session.end();
    expect(saved[0]).toMatchObject({ tool_problems: 1 });
  });
});
