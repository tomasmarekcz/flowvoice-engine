import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  process.env.FRONTEND_API_URL = "http://localhost:3000";
  mockFetch.mockReset();
});

const { executeTool } = await import("../src/tools");

describe("executeTool", () => {
  it("calls /api/calendar/slots for get_available_slots", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => ({ slots: ["2026-06-23T09:00:00Z"] }) });

    const result = await executeTool("get_available_slots", { from_date: "2026-06-23" }, "proj-1", "admin-test");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain("/api/calendar/slots");
    expect(url).toContain("from=");
    expect(result).toEqual({ slots: ["2026-06-23T09:00:00Z"] });
  });

  it("calls /api/enquiries for create_enquiry", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => ({ id: "enq-1" }) });

    const result = await executeTool(
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
    const result = await executeTool("unknown_tool", {}, "proj-1", "admin-test");
    expect((result as { error: string }).error).toMatch(/Unknown tool/);
  });

  it("calls /api/calendar/windows for get_day_availability", async () => {
    const windowsResponse = {
      slot_interval_minutes: 15,
      appointment_duration_minutes: 60,
      days: [{ date: "2026-06-30", day_label: "Monday, 30 June", windows: [] }],
    };
    mockFetch.mockResolvedValueOnce({ json: async () => windowsResponse });

    const result = await executeTool(
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
