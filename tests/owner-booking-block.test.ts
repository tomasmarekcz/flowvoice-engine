import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOwnerBookingBlock } from "../src/owner-booking-block";
import { formatOwnerSms } from "../src/session";

afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchOwnerBookingBlock (LEA-149)", () => {
  it("asks the dashboard with the engine secret and returns heading and lines", async () => {
    process.env.ENGINE_INTERNAL_SECRET = "s3";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ heading: "Nový hovor s rezervací", lines: ["📅 Rezervace: …", "Detail: https://x"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const block = await fetchOwnerBookingBlock("call-1", "p1");
    expect(block).toEqual({ heading: "Nový hovor s rezervací", lines: ["📅 Rezervace: …", "Detail: https://x"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/notify/booking-block");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3");
    expect(JSON.parse(init.body as string)).toEqual({ call_id: "call-1", project_id: "p1" });
  });

  it("is null when the call made no booking, the dashboard fails or cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await fetchOwnerBookingBlock("c", "p")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await fetchOwnerBookingBlock("c", "p")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await fetchOwnerBookingBlock("c", "p")).toBeNull();
    expect(await fetchOwnerBookingBlock(null, "p")).toBeNull();
  });
});

describe("formatOwnerSms with a booking (LEA-149)", () => {
  const base = { callerPhone: "+420777", startMs: Date.parse("2026-11-02T12:00:00Z"), callId: "call-1", lang: "cs" };

  it("one text: heading, summary, the booking and the conversation link", () => {
    const sms = formatOwnerSms("Chce střih v pátek.", { ...base, booking: { heading: "Nový hovor s rezervací", lines: ["📅 Rezervace: Střih – potvrzeno.", "Detail: https://x/calendar?event=1"] } });
    const lines = sms.split("\n");
    expect(lines[0]).toBe("🆕 Nový hovor s rezervací");
    expect(lines).toContain("Chce střih v pátek.");
    expect(lines.indexOf("Detail: https://x/calendar?event=1")).toBeGreaterThan(lines.indexOf("Chce střih v pátek."));
    expect(lines[lines.length - 1]).toContain("/conversations/call-1");
  });

  it("is the text it always was without a booking", () => {
    expect(formatOwnerSms("Shrnutí", base).split("\n")[0]).toBe("🆕 Nová konverzace");
    expect(formatOwnerSms("Summary", { ...base, lang: "en" }).split("\n")[0]).toBe("🆕 New conversation");
  });
});
