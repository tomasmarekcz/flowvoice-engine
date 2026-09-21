import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  liveCtor: vi.fn(), liveStart: vi.fn(), liveAbort: vi.fn(),
  stdCtor: vi.fn(), stdStart: vi.fn(),
}));

vi.mock("../src/config", () => ({ loadAssistantSettings: h.loadSettings }));
vi.mock("../src/live-session", () => ({
  LiveCallSession: class {
    audioFormat = "mulaw8";
    start = h.liveStart;
    abort = h.liveAbort;
    constructor(...args: unknown[]) { h.liveCtor(...args); }
  },
}));
vi.mock("../src/session", () => ({
  CallSession: class {
    audioFormat = "pcm24";
    start = h.stdStart;
    constructor(...args: unknown[]) { h.stdCtor(...args); }
  },
}));

const { startCallSession } = await import("../src/session-factory");

const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() };

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  h.liveStart.mockResolvedValue(undefined);
  h.liveAbort.mockResolvedValue(undefined);
  h.stdStart.mockResolvedValue(undefined);
});

describe("startCallSession", () => {
  it("uses Standard by default and passes the loaded settings along", async () => {
    const settings = { voice_engine: "standard" };
    h.loadSettings.mockResolvedValue(settings);

    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks);

    expect(session.audioFormat).toBe("pcm24");
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, settings);
    expect(h.stdStart).toHaveBeenCalledOnce();
    expect(h.liveCtor).not.toHaveBeenCalled();
  });

  it("uses Standard when no settings exist", async () => {
    h.loadSettings.mockResolvedValue(null);
    const session = await startCallSession("proj-1", null, null, callbacks);
    expect(session.audioFormat).toBe("pcm24");
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", null, null, callbacks, null);
  });

  it("uses Live when the assistant is set to live", async () => {
    const settings = { voice_engine: "live" };
    h.loadSettings.mockResolvedValue(settings);

    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks);

    expect(session.audioFormat).toBe("mulaw8");
    expect(h.liveCtor).toHaveBeenCalledWith(settings, "proj-1", "+420111", "CA1", callbacks);
    expect(h.stdCtor).not.toHaveBeenCalled();
  });

  it("falls back to Standard when Live fails to start", async () => {
    const settings = { voice_engine: "live" };
    h.loadSettings.mockResolvedValue(settings);
    h.liveStart.mockRejectedValue(new Error("model not available"));

    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks);

    expect(h.liveAbort).toHaveBeenCalledOnce();
    expect(session.audioFormat).toBe("pcm24");
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, settings);
    expect(h.stdStart).toHaveBeenCalledOnce();
  });
});
