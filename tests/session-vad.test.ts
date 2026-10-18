import { describe, it, expect, vi } from "vitest";
import type { AssistantSettings } from "../src/config";

const h = vi.hoisted(() => ({ sent: [] as string[], handlers: {} as Record<string, () => void> }));

vi.mock("ws", () => {
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    constructor(public url: string) {}
    on(event: string, fn: () => void) { h.handlers[event] = fn; return this; }
    send(data: string) { h.sent.push(data); }
    close() {}
  }
  return { WebSocket: FakeWS };
});

process.env.OPENAI_API_KEY = "test-key";
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { CallSession } = await import("../src/session");

const callbacks = { sendAudio: vi.fn(), sendJson: vi.fn(), sendMark: vi.fn(), endCall: vi.fn() };
const settings = { project_id: "proj-1", capabilities: {} } as unknown as AssistantSettings;

describe("what the assistant hears", () => {
  it("filters background noise and waits 400 ms of silence before it answers", async () => {
    await new CallSession("proj-1", null, null, callbacks, settings).start();
    h.handlers["open"]();

    const update = JSON.parse(h.sent.find((s) => JSON.parse(s).type === "session.update")!);
    const input = update.session.audio.input;
    expect(input.noise_reduction).toEqual({ type: "near_field" });
    expect(input.turn_detection).toMatchObject({ type: "server_vad", silence_duration_ms: 400 });
  });
});
