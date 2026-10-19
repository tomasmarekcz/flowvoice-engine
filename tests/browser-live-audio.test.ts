import { describe, it, expect, vi } from "vitest";
import { makeTicket } from "./helpers-ticket";

// A test call on a project that uses the Live engine: the browser speaks 24 kHz, Live speaks 8 kHz phone audio.

const h = vi.hoisted(() => ({ callbacks: null as null | Record<string, (...a: unknown[]) => void>, live: null as null | Record<string, ReturnType<typeof vi.fn>> }));

vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ allowed: true, reason: null }) })));
process.env.ENGINE_INTERNAL_SECRET = "engine-secret";
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

vi.mock("../src/session-factory", () => ({
  startCallSession: vi.fn(async (_p: string, _c: string, _s: null, callbacks: Record<string, (...a: unknown[]) => void>) => {
    h.callbacks = callbacks;
    h.live = { handleClientAudio: vi.fn(), handleTwilioMark: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    return { audioFormat: "mulaw8", ...h.live };
  }),
}));

const { handleBrowserConnection } = await import("../src/handlers/browser");
const { pcm24kToBase64, base64ToPcm24k } = await import("../src/audio");

function connect() {
  const sent: Array<Record<string, unknown>> = [];
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const ws = {
    readyState: 1,
    send: (d: string) => sent.push(JSON.parse(d)),
    close: vi.fn(),
    on: (event: string, fn: (...a: unknown[]) => void) => { handlers[event] = fn; },
  } as unknown as import("ws").WebSocket;
  const request = { url: `/ws/browser?ticket=${makeTicket("engine-secret")}` } as unknown as import("http").IncomingMessage;
  return { ws, request, sent, handlers };
}

describe("test call with the Live engine", () => {
  it("tells the page the call is connected once Live is ready", async () => {
    const { ws, request, sent } = connect();
    await handleBrowserConnection(ws, request);
    expect(sent).toContainEqual({ type: "proxy.connected" });
  });

  it("converts the caller's 24 kHz audio to 8 kHz mu-law for Live", async () => {
    const { ws, request, handlers } = connect();
    await handleBrowserConnection(ws, request);
    const tone = new Float32Array(2400).fill(0.2);
    handlers["message"](Buffer.from(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24kToBase64(tone) })));
    const sentToLive = h.live!.handleClientAudio.mock.calls[0][0] as string;
    expect(Buffer.from(sentToLive, "base64").length).toBe(800); // 2400 samples at 24 kHz = 800 mu-law bytes at 8 kHz
  });

  it("converts Live's 8 kHz mu-law audio to 24 kHz for the page", async () => {
    const { ws, request, sent } = connect();
    await handleBrowserConnection(ws, request);
    h.callbacks!.sendAudio(Buffer.alloc(800, 0xff).toString("base64"), "mulaw8");
    const delta = sent.find((m) => m.type === "response.output_audio.delta")!.delta as string;
    expect(base64ToPcm24k(delta).length).toBe(2400);
  });

  it("confirms the end_call mark itself, since there is no Twilio stream to do it", async () => {
    vi.useFakeTimers();
    const { ws, request } = connect();
    await handleBrowserConnection(ws, request);
    h.callbacks!.sendMark("end-call-1");
    expect(h.live!.handleTwilioMark).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3100);
    expect(h.live!.handleTwilioMark).toHaveBeenCalledWith("end-call-1");
    vi.useRealTimers();
  });
});
