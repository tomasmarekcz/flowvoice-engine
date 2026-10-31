// LEA-132: an appointment the assistant wrote as already confirmed (the owner chose "book right away") must reach the
// caller as a confirmation. This module collects such bookings during the call and words them afterwards: for the
// caller SMS the AI writes after the call, or, when that SMS is off, for a short fixed SMS.

import { emptySnapshot, type PromptSnapshot } from "./prompts/core";
import { ENGINE_PROMPTS as P } from "./prompts/registry";

export interface ConfirmedBooking {
  startTime: string;
  endTime: string | null;
  title: string | null;
}

/** The booking, when the result of create_calendar_event says the server wrote it as confirmed. */
export function confirmedBookingFromResult(result: unknown): ConfirmedBooking | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  if ("error" in r || r["status"] !== "confirmed" || typeof r["start_time"] !== "string") return null;
  return {
    startTime: r["start_time"],
    endTime: typeof r["end_time"] === "string" ? r["end_time"] : null,
    title: typeof r["title"] === "string" ? r["title"] : null,
  };
}

type Lang = "cs" | "en";

function format(booking: ConfirmedBooking, timezone: string, lang: Lang): string {
  const at = new Date(booking.startTime);
  if (lang === "cs") {
    const day = new Intl.DateTimeFormat("cs-CZ", { timeZone: timezone, weekday: "long", day: "numeric", month: "numeric" }).format(at);
    const time = new Intl.DateTimeFormat("cs-CZ", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    return `${day} v ${time}`;
  }
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${day} at ${time}`;
}

export function formatBookingWhen(booking: ConfirmedBooking, timezone: string, lang: Lang): string {
  return format(booking, timezone, lang);
}

/** The confirmed appointments as lines for the after-call prompt (always English: the AI writes the SMS in the business's language). */
export function bookingsForSummary(bookings: ConfirmedBooking[], timezone: string): string {
  return bookings
    .map((b) => `- ${format(b, timezone, "en")}${b.title ? ` (${b.title})` : ""}`)
    .join("\n");
}

/**
 * The SMS the caller gets after the call: the one the AI wrote when the owner has that SMS on, otherwise (when something
 * was booked as confirmed) the short fixed confirmation, otherwise nothing. The caller always hears that a booking is confirmed.
 */
export function callerSmsWithConfirmation(
  aiCallerSms: string | null,
  bookings: ConfirmedBooking[],
  ctx: { business: string | null; timezone: string; language: string | null },
  snapshot: PromptSnapshot = emptySnapshot()
): string | null {
  if (aiCallerSms && aiCallerSms.trim()) return aiCallerSms;
  return standaloneBookingSms(bookings, ctx, snapshot);
}

/** A short fixed confirmation, or null when nothing was booked. Czech for a Czech business, otherwise English. */
export function standaloneBookingSms(
  bookings: ConfirmedBooking[],
  ctx: { business: string | null; timezone: string; language: string | null },
  snapshot: PromptSnapshot = emptySnapshot()
): string | null {
  if (bookings.length === 0) return null;
  const lang: Lang = ctx.language === "cs" ? "cs" : "en";
  const when = bookings.map((b) => format(b, ctx.timezone, lang)).join("; ");
  const def = lang === "cs" ? P.bookingConfirmedSmsCs : P.bookingConfirmedSmsEn;
  return snapshot.text(def, { when, business: ctx.business ?? "" }).trim();
}
