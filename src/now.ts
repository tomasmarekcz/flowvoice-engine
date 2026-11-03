// LEA-157: the current date and time in the project's timezone, as the assistant is told it.
export const DEFAULT_TIMEZONE = "Europe/Prague";

/** A timezone name Intl accepts, else the default (a mistyped value in the database must not break a call). */
export function validTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export interface NowParts {
  /** For example "Tuesday 3 November 2026, 17:42". */
  now: string;
  timezone: string;
  /** For example "+01:00". */
  offset: string;
}

export function nowInTimezone(tz: string | null | undefined, date: Date = new Date()): NowParts {
  const timezone = validTimezone(tz);
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", ...opts }).format(date);
  const now = `${f({ weekday: "long" })} ${f({ day: "numeric" })} ${f({ month: "long" })} ${f({ year: "numeric" })}, ${f({ hour: "2-digit", minute: "2-digit" })}`;
  const raw = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = raw === "GMT" ? "+00:00" : raw.replace("GMT", "");
  return { now, timezone, offset };
}
