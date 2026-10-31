import { describe, it, expect } from "vitest";
import {
  confirmedBookingFromResult, bookingsForSummary, standaloneBookingSms, formatBookingWhen, callerSmsWithConfirmation,
} from "../src/booking-confirmation";

// 2026-10-30T13:00:00Z is 14:00 in Prague (winter time started on 25 October 2026).
const FRIDAY = { startTime: "2026-10-30T13:00:00.000Z", endTime: "2026-10-30T14:00:00.000Z", title: "Střih" };

describe("confirmedBookingFromResult (LEA-132)", () => {
  it("returns the booking when the server wrote it as confirmed", () => {
    expect(confirmedBookingFromResult({ id: "e1", status: "confirmed", start_time: FRIDAY.startTime, end_time: FRIDAY.endTime, title: "Střih" }))
      .toEqual(FRIDAY);
  });

  it("returns null for a booking that waits for the owner, for errors and for anything else", () => {
    expect(confirmedBookingFromResult({ id: "e1", status: "pending_review", start_time: FRIDAY.startTime })).toBeNull();
    expect(confirmedBookingFromResult({ error: "This time slot is no longer available." })).toBeNull();
    expect(confirmedBookingFromResult({ status: "confirmed" })).toBeNull();
    expect(confirmedBookingFromResult(null)).toBeNull();
    expect(confirmedBookingFromResult("nope")).toBeNull();
  });
});

describe("formatBookingWhen", () => {
  it("writes day and time in the business's timezone, in the business's language", () => {
    expect(formatBookingWhen(FRIDAY, "Europe/Prague", "cs")).toBe("pátek 30. 10. v 14:00");
    expect(formatBookingWhen(FRIDAY, "Europe/Prague", "en")).toBe("Friday 30 October at 14:00");
  });
});

describe("bookingsForSummary", () => {
  it("lists every confirmed booking for the after-call prompt", () => {
    const text = bookingsForSummary([FRIDAY], "Europe/Prague");
    expect(text).toContain("Friday 30 October at 14:00");
    expect(text).toContain("Střih");
  });
});

describe("callerSmsWithConfirmation", () => {
  const ctx = { business: "Salon Aurora", timezone: "Europe/Prague", language: "cs" };

  it("keeps the SMS the AI wrote when the owner has the caller SMS on", () => {
    expect(callerSmsWithConfirmation("Děkujeme, termín pátek 14:00 je potvrzen.", [FRIDAY], ctx)).toBe("Děkujeme, termín pátek 14:00 je potvrzen.");
  });

  it("falls back to the fixed confirmation when there is no AI SMS but a confirmed booking", () => {
    expect(callerSmsWithConfirmation(null, [FRIDAY], ctx)).toContain("je potvrzen");
    expect(callerSmsWithConfirmation("  ", [FRIDAY], ctx)).toContain("je potvrzen");
  });

  it("sends nothing when there is neither", () => {
    expect(callerSmsWithConfirmation(null, [], ctx)).toBeNull();
  });
});

describe("standaloneBookingSms (sent when the caller SMS after the call is off)", () => {
  it("is a short confirmation in Czech, with the business name", () => {
    const sms = standaloneBookingSms([FRIDAY], { business: "Salon Aurora", timezone: "Europe/Prague", language: "cs" });
    expect(sms).toBe("Dobrý den, váš termín pátek 30. 10. v 14:00 je potvrzen. Salon Aurora");
  });

  it("is in English for an English business and works without a business name", () => {
    expect(standaloneBookingSms([FRIDAY], { business: null, timezone: "Europe/Prague", language: "en" }))
      .toBe("Your appointment on Friday 30 October at 14:00 is confirmed.");
  });

  it("covers several bookings in one message", () => {
    const sms = standaloneBookingSms(
      [FRIDAY, { ...FRIDAY, startTime: "2026-11-02T08:30:00.000Z", endTime: null, title: null }],
      { business: null, timezone: "Europe/Prague", language: "cs" }
    );
    expect(sms).toContain("pátek 30. 10. v 14:00");
    expect(sms).toContain("pondělí 2. 11. v 09:30");
  });

  it("sends nothing when there is no confirmed booking", () => {
    expect(standaloneBookingSms([], { business: "X", timezone: "Europe/Prague", language: "cs" })).toBeNull();
  });
});
