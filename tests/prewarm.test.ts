import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssistantSettings } from "../src/config";

// LEA-162: the connection to OpenAI opened ahead of the call, and what happens to one nobody takes.

const h = vi.hoisted(() => ({ sockets: [] as Array<{ url: string; readyState: number; closed: boolean; headers: unknown }>, loadSettings: vi.fn() }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    closed = false;
    constructor(public url: string, public opts?: { headers?: unknown }) { h.sockets.push(this as never); }
    get headers() { return this.opts?.headers; }
    on() { return this; }
    close() { this.closed = true; this.readyState = 3; }
  }
  return { WebSocket: FakeWS };
});
vi.mock("../src/config", () => ({ loadAssistantSettings: h.loadSettings }));
vi.mock("../src/prompts/store", () => ({ getSnapshot: async () => ({ text: () => "", usedVersionIds: () => [] }) }));

const { prewarmCall, takePrewarmed, clearPrewarmed, PREWARM_TTL_MS } = await import("../src/prewarm");

const settings = (engine?: string) => ({ project_id: "p1", voice_engine: engine }) as unknown as AssistantSettings;

beforeEach(() => {
  delete process.env.PREWARM;
  process.env.OPENAI_API_KEY = "test-key";
  h.sockets.length = 0;
  h.loadSettings.mockReset().mockResolvedValue(settings("standard"));
  vi.useFakeTimers();
});
afterEach(() => { clearPrewarmed(); vi.useRealTimers(); process.env.PREWARM = "off"; });

describe("prewarm", () => {
  it("opens the Standard connection with the call's settings and hands it over once", async () => {
    prewarmCall({ callSid: "CA1", projectId: "p1", settings: settings("standard") });
    const taken = await takePrewarmed("CA1");
    expect(taken?.engine).toBe("standard");
    expect(taken?.socket).toBe(h.sockets[0]);
    expect(h.sockets[0].url).toContain("api.openai.com/v1/realtime?model=");
    expect(await takePrewarmed("CA1")).toBeNull(); // only once
  });

  it("loads the settings itself when the caller has none (after the owner did not answer)", async () => {
    prewarmCall({ callSid: "CA2", projectId: "p1" });
    const taken = await takePrewarmed("CA2");
    expect(h.loadSettings).toHaveBeenCalledWith("p1");
    expect(taken?.settings).toEqual(settings("standard"));
  });

  it("opens the Live address for Live and nothing for Pipeline", async () => {
    prewarmCall({ callSid: "CA3", projectId: "p1", settings: settings("live") });
    expect((await takePrewarmed("CA3"))?.socket).toBe(h.sockets[0]);
    expect(h.sockets[0].url).toContain("/v1/live/sessions");
    prewarmCall({ callSid: "CA4", projectId: "p1", settings: settings("pipeline") });
    expect((await takePrewarmed("CA4"))?.socket).toBeNull();
    expect(h.sockets).toHaveLength(1);
  });

  it("closes a connection nobody takes after the time limit", async () => {
    prewarmCall({ callSid: "CA5", projectId: "p1", settings: settings("standard") });
    await vi.advanceTimersByTimeAsync(PREWARM_TTL_MS + 10);
    expect(h.sockets[0].closed).toBe(true);
    expect(await takePrewarmed("CA5")).toBeNull();
  });

  it("a second webhook for the same call replaces the first and closes its connection", async () => {
    prewarmCall({ callSid: "CA6", projectId: "p1", settings: settings("standard") });
    await vi.advanceTimersByTimeAsync(1);
    prewarmCall({ callSid: "CA6", projectId: "p1", settings: settings("standard") });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets[0].closed).toBe(true);
    expect((await takePrewarmed("CA6"))?.socket).toBe(h.sockets[1]);
  });

  it("without an OpenAI key there is no connection, but the settings are still handed over", async () => {
    delete process.env.OPENAI_API_KEY;
    prewarmCall({ callSid: "CA7", projectId: "p1", settings: settings("standard") });
    const taken = await takePrewarmed("CA7");
    expect(taken?.socket).toBeNull();
    expect(taken?.settings).toEqual(settings("standard"));
  });

  it("does nothing when switched off, and nothing is taken for an unknown call", async () => {
    process.env.PREWARM = "off";
    prewarmCall({ callSid: "CA8", projectId: "p1", settings: settings("standard") });
    expect(await takePrewarmed("CA8")).toBeNull();
    expect(await takePrewarmed(null)).toBeNull();
    expect(h.sockets).toHaveLength(0);
  });

  it("a connection that has already closed is not handed over", async () => {
    prewarmCall({ callSid: "CA9", projectId: "p1", settings: settings("standard") });
    await vi.advanceTimersByTimeAsync(1);
    h.sockets[0].readyState = 3;
    expect((await takePrewarmed("CA9"))?.socket).toBeNull();
  });
});
