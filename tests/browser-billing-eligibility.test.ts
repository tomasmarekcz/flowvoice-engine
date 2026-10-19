import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeTicket } from "./helpers-ticket";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENGINE_INTERNAL_SECRET = "engine-secret";

const mockStart = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/session-factory", () => ({
  startCallSession: vi.fn(async () => {
    await mockStart();
    return { audioFormat: "pcm24", handleClientAudio: vi.fn(), handleTwilioMark: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const { startCallSession } = await import("../src/session-factory");
const { handleBrowserConnection } = await import("../src/handlers/browser");

function makeWsAndRequest(url: string) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as import("ws").WebSocket;
  const request = { url } as unknown as import("http").IncomingMessage;
  return { ws, request, sent };
}

describe("handleBrowserConnection billing eligibility", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStart.mockClear();
  });

  it("starts the session when the call is eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, reason: null }) });
    const { ws, request } = makeWsAndRequest(`/ws/browser?ticket=${makeTicket("engine-secret")}`);

    await handleBrowserConnection(ws, request);

    expect(mockStart).toHaveBeenCalled();
  });

  it("closes the socket with an error frame when not eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: false, reason: "demo_minutes_exhausted" }) });
    const { ws, request, sent } = makeWsAndRequest(`/ws/browser?ticket=${makeTicket("engine-secret")}`);

    await handleBrowserConnection(ws, request);

    expect(mockStart).not.toHaveBeenCalled();
    expect(sent.some((s) => JSON.parse(s).type === "error")).toBe(true);
    expect(ws.close).toHaveBeenCalled();
  });

  it("hands the project and the typed phone number from the ticket to the session", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, reason: null }) });
    const { ws, request } = makeWsAndRequest(`/ws/browser?ticket=${makeTicket("engine-secret", { p: "proj-9", ph: "+4915112345678" })}`);

    await handleBrowserConnection(ws, request);

    expect(vi.mocked(startCallSession).mock.calls.at(-1)?.slice(0, 3)).toEqual(["proj-9", "+4915112345678", null]);
  });

  it("refuses a connection without a valid ticket, and the old project_id link no longer works", async () => {
    const { ws, request, sent } = makeWsAndRequest("/ws/browser?project_id=proj-1");

    await handleBrowserConnection(ws, request);

    expect(mockStart).not.toHaveBeenCalled();
    expect(JSON.parse(sent[0])).toMatchObject({ type: "error", code: "ticket_invalid" });
    expect(ws.close).toHaveBeenCalled();
  });
});
