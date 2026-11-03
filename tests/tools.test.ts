import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
// The mocked answers carry only a body; the status a real answer has is added here (200 unless the test says otherwise).
vi.stubGlobal("fetch", (...args: unknown[]) => Promise.resolve(mockFetch(...args)).then((r) => ({ ok: true, status: 200, ...r })));

beforeEach(() => {
  process.env.FRONTEND_API_URL = "http://localhost:3000";
  mockFetch.mockReset();
});

const { executeTool } = await import("../src/tools");

describe("executeTool", () => {
  it("calls /api/enquiries for create_enquiry", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => ({ id: "enq-1" }) });

    const { result } = await executeTool(
      "create_enquiry",
      { title: "Quote request", customer_phone: "+420123456789" },
      "proj-1",
      "admin-test"
    );

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/enquiries");
    expect(opts.method).toBe("POST");
    expect(result).toEqual({ id: "enq-1" });
  });

  it("returns error object for unknown tool", async () => {
    const { result } = await executeTool("unknown_tool", {}, "proj-1", "admin-test");
    expect((result as { error: string }).error).toMatch(/Unknown tool/);
  });

  it("returns embeddingTokens 0 for non-knowledge tools", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => ({ services: [] }) });
    const { embeddingTokens } = await executeTool("get_services", {}, "proj-1", "admin-test");
    expect(embeddingTokens).toBe(0);
  });

  it("no longer knows get_available_slots (removed in LEA-159)", async () => {
    const { result } = await executeTool("get_available_slots", {}, "proj-1", "admin-test");
    expect((result as { error: string }).error).toMatch(/Unknown tool/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls /api/calendar/windows for get_day_availability", async () => {
    const windowsResponse = {
      slot_interval_minutes: 15,
      appointment_duration_minutes: 60,
      days: [{ date: "2026-06-30", day_label: "Monday, 30 June", windows: [] }],
    };
    mockFetch.mockResolvedValueOnce({ json: async () => windowsResponse });

    const { result } = await executeTool(
      "get_day_availability",
      { from_date: "2026-06-30", days: 1 },
      "proj-1",
      "admin-test"
    );

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain("/api/calendar/windows");
    expect(url).toContain("project_id=admin-test");
    expect(url).toContain("from=2026-06-30");
    expect(url).toContain("days=1");
    expect(result).toEqual(windowsResponse);
  });

  it("defaults to days=7 when get_day_availability called without days param", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => ({ days: [] }) });

    await executeTool("get_day_availability", { from_date: "2026-06-30" }, "proj-1", "admin-test");

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain("days=7");
  });
});
