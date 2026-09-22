export type WorkingHoursMap = Record<string, { from: string; to: string } | null> | null | undefined;

const WEEKDAY_TO_KEY: Record<string, string> = {
  Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat",
};

// Reads the current weekday + time in the given IANA timezone via Intl, which
// handles DST correctly without pulling in a date library.
function partsInTimezone(date: Date, timezone: string): { dayKey: string; minutesSinceMidnight: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { dayKey: WEEKDAY_TO_KEY[weekday] ?? "mon", minutesSinceMidnight: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

// No working_hours configured is treated as "always within business hours" —
// the safer default, since it means calls keep trying the owner first
// instead of silently routing everything straight to the AI.
export function isWithinWorkingHours(
  workingHours: WorkingHoursMap,
  timezone: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!workingHours) return true;

  const { dayKey, minutesSinceMidnight } = partsInTimezone(now, timezone || "Europe/Prague");
  const today = workingHours[dayKey];
  if (!today) return false; // day marked as closed

  const from = toMinutes(today.from);
  const to = toMinutes(today.to);
  return minutesSinceMidnight >= from && minutesSinceMidnight < to;
}
