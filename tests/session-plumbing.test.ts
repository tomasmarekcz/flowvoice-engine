import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AssistantSettings } from "../src/config";

const h = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 0;
    constructor(public url: string) {}
    on() { return this; }
    send() {}
    close() {}
  }
  return { WebSocket: FakeWS };
});

vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return { ...actual, loadAssistantSettings: h.loadMock };
});

process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { CallSession } = await import("../src/session");

const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() };
const settings = { project_id: "proj-1", capabilities: {} } as unknown as AssistantSettings;

describe("CallSession plumbing", () => {
  beforeEach(() => h.loadMock.mockReset());

  it("reports PCM 24 kHz as its audio format", () => {
    const session = new CallSession("proj-1", null, null, callbacks);
    expect(session.audioFormat).toBe("pcm24");
  });

  it("loads settings itself when none are preloaded", async () => {
    h.loadMock.mockResolvedValue(settings);
    await new CallSession("proj-1", null, null, callbacks).start();
    expect(h.loadMock).toHaveBeenCalledWith("proj-1");
  });

  it("does not reload settings when they are preloaded", async () => {
    await new CallSession("proj-1", null, null, callbacks, settings).start();
    expect(h.loadMock).not.toHaveBeenCalled();
  });

  it("treats preloaded null as 'no settings' without reloading", async () => {
    await new CallSession("proj-1", null, null, callbacks, null).start();
    expect(h.loadMock).not.toHaveBeenCalled();
  });
});
