import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  liveCtor: vi.fn(), liveStart: vi.fn(), liveAbort: vi.fn(),
  stdCtor: vi.fn(), stdStart: vi.fn(),
  hybridCtor: vi.fn(), hybridStart: vi.fn(), hybridAbort: vi.fn(),
  pipelineCtor: vi.fn(), pipelineStart: vi.fn(), pipelineAbort: vi.fn(),
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
// The Standard session class also serves as the Hybrid engine (it gets a voice); the options tell them apart.
vi.mock("../src/session", () => ({
  CallSession: class {
    audioFormat = "pcm24";
    start: () => Promise<void>;
    abort = h.hybridAbort;
    constructor(...args: unknown[]) {
      const options = args[6] as { voice?: unknown } | undefined;
      if (options?.voice) { h.hybridCtor(...args); this.start = h.hybridStart; }
      else { h.stdCtor(...args); this.start = h.stdStart; }
    }
  },
}));
vi.mock("../src/pipeline-session", () => ({
  PipelineCallSession: class {
    audioFormat = "mulaw8";
    start = h.pipelineStart;
    abort = h.pipelineAbort;
    constructor(...args: unknown[]) { h.pipelineCtor(...args); }
  },
}));
vi.mock("../src/voice/realtime-voice", () => ({ RealtimeVoice: class { constructor(public options: unknown) {} } }));

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
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, settings, expect.anything(), { audio: "pcm24" });
    expect(h.stdStart).toHaveBeenCalledOnce();
    expect(h.liveCtor).not.toHaveBeenCalled();
  });

  it("uses Standard when no settings exist", async () => {
    h.loadSettings.mockResolvedValue(null);
    const session = await startCallSession("proj-1", null, null, callbacks);
    expect(session.audioFormat).toBe("pcm24");
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", null, null, callbacks, null, expect.anything(), { audio: "pcm24" });
  });

  it("uses Live when the assistant is set to live", async () => {
    const settings = { voice_engine: "live" };
    h.loadSettings.mockResolvedValue(settings);

    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks);

    expect(session.audioFormat).toBe("mulaw8");
    expect(h.liveCtor).toHaveBeenCalledWith(settings, "proj-1", "+420111", "CA1", callbacks, { promptSnapshot: expect.anything() });
    expect(h.stdCtor).not.toHaveBeenCalled();
  });

  it("tries Live once more when it fails quickly, then falls back to Standard", async () => {
    const settings = { voice_engine: "live" };
    h.loadSettings.mockResolvedValue(settings);
    h.liveStart.mockRejectedValue(new Error("connection refused"));

    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks);

    expect(h.liveCtor).toHaveBeenCalledTimes(2);
    expect(h.liveAbort).toHaveBeenCalledTimes(2);
    expect(session.audioFormat).toBe("pcm24");
    // The reason travels with the call so the quality measurement can record the fallback (LEA-154).
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, settings, expect.anything(), {
      audio: "pcm24",
      fallbackReason: "connection refused",
    });
    expect(h.stdStart).toHaveBeenCalledOnce();
  });

  it("does not wait for a second Live attempt when the first one was slow", async () => {
    vi.useFakeTimers();
    try {
      h.loadSettings.mockResolvedValue({ voice_engine: "live" });
      h.liveStart.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI Live session start timed out")), 6000)));

      const started = startCallSession("proj-1", "+420111", "CA1", callbacks);
      await vi.advanceTimersByTimeAsync(6100);
      await started;

      expect(h.liveCtor).toHaveBeenCalledTimes(1);
      expect(h.stdStart).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers with Hybrid when the project is set to hybrid, and falls back to Standard when it cannot start", async () => {
    h.loadSettings.mockResolvedValue({ voice_engine: "hybrid" });
    h.hybridStart.mockResolvedValue(undefined);
    const ok = await startCallSession("proj-1", "+420111", "CA1", callbacks, "twilio");
    expect(h.hybridCtor).toHaveBeenCalledOnce();
    expect(h.hybridCtor.mock.calls[0][6]).toMatchObject({ audio: "pcmu" });
    expect(ok.audioFormat).toBe("pcm24"); // the mocked class
    expect(h.stdCtor).not.toHaveBeenCalled();

    h.hybridCtor.mockClear();
    h.hybridStart.mockRejectedValue(new Error("voice session start timed out"));
    await startCallSession("proj-1", "+420111", "CA2", callbacks, "twilio");
    expect(h.hybridAbort).toHaveBeenCalledOnce();
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA2", callbacks, expect.anything(), expect.anything(), expect.objectContaining({ fallbackReason: "hybrid: voice session start timed out" }));
  });

  it("answers with the own chain when the project is set to pipeline, and falls back to Standard when it cannot start", async () => {
    h.loadSettings.mockResolvedValue({ voice_engine: "pipeline" });
    h.pipelineStart.mockResolvedValue(undefined);
    await startCallSession("proj-1", "+420111", "CA1", callbacks, "twilio");
    expect(h.pipelineCtor).toHaveBeenCalledOnce();
    expect(h.stdCtor).not.toHaveBeenCalled();

    h.pipelineStart.mockRejectedValue(new Error("speech recognition start timed out"));
    await startCallSession("proj-1", "+420111", "CA2", callbacks, "twilio");
    expect(h.pipelineAbort).toHaveBeenCalledOnce();
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA2", callbacks, expect.anything(), expect.anything(), expect.objectContaining({ fallbackReason: "pipeline: speech recognition start timed out" }));
  });

  it("talks to OpenAI in the phone line's own format on a Twilio call, so no audio is converted (LEA-155)", async () => {
    h.loadSettings.mockResolvedValue({ voice_engine: "standard" });
    const session = await startCallSession("proj-1", "+420111", "CA1", callbacks, "twilio");
    expect(session.audioFormat).toBe("pcm24"); // the mocked session; the real one reports mulaw8 for pcmu
    expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, expect.anything(), expect.anything(), { audio: "pcmu" });
  });

  it("keeps converting on a Twilio call when TWILIO_STANDARD_AUDIO=pcm24 says so", async () => {
    process.env.TWILIO_STANDARD_AUDIO = "pcm24";
    try {
      h.loadSettings.mockResolvedValue({ voice_engine: "standard" });
      await startCallSession("proj-1", "+420111", "CA1", callbacks, "twilio");
      expect(h.stdCtor).toHaveBeenCalledWith("proj-1", "+420111", "CA1", callbacks, expect.anything(), expect.anything(), { audio: "pcm24" });
    } finally {
      delete process.env.TWILIO_STANDARD_AUDIO;
    }
  });
});
