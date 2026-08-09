import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const mockStart = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/session", () => ({
  CallSession: vi.fn().mockImplementation(() => ({ start: mockStart })),
}));

const { handleBrowserConnection } = await import("../src/handlers/browser");

function makeWsAndRequest(projectId: string) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as import("ws").WebSocket;
  const request = { url: `/ws/browser?project_id=${projectId}` } as unknown as import("http").IncomingMessage;
  return { ws, request, sent };
}

describe("handleBrowserConnection billing eligibility", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStart.mockClear();
  });

  it("starts the session when the call is eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, reason: null }) });
    const { ws, request } = makeWsAndRequest("proj-1");

    await handleBrowserConnection(ws, request);

    expect(mockStart).toHaveBeenCalled();
  });

  it("closes the socket with an error frame when not eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: false, reason: "demo_minutes_exhausted" }) });
    const { ws, request, sent } = makeWsAndRequest("proj-1");

    await handleBrowserConnection(ws, request);

    expect(mockStart).not.toHaveBeenCalled();
    expect(sent.some((s) => JSON.parse(s).type === "error")).toBe(true);
    expect(ws.close).toHaveBeenCalled();
  });
});
