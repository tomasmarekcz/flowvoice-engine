import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshExternalCalendars } from "../src/ical-refresh";

afterEach(() => vi.restoreAllMocks());

describe("refreshExternalCalendars (LEA-139)", () => {
  it("asks the dashboard to refresh the project's calendars, with the internal secret, and does not wait", () => {
    process.env.FRONTEND_API_URL = "http://dash.test";
    process.env.ENGINE_INTERNAL_SECRET = "s3cret";
    const fetchMock = vi.fn(() => new Promise<Response>(() => {})); // never answers: the call must not depend on it
    vi.stubGlobal("fetch", fetchMock);
    expect(refreshExternalCalendars("p-1")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://dash.test/api/calendar/ical-refresh?project_id=p-1");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3cret");
    vi.unstubAllGlobals();
  });

  it("does nothing without a project and never throws when the dashboard is down", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("down")));
    vi.stubGlobal("fetch", fetchMock);
    refreshExternalCalendars(null);
    expect(fetchMock).not.toHaveBeenCalled();
    refreshExternalCalendars("p-2");
    await Promise.resolve();
    vi.unstubAllGlobals();
  });
});
