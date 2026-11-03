import { describe, it, expect } from "vitest";
import { nowInTimezone, validTimezone } from "../src/now";

describe("nowInTimezone (LEA-157)", () => {
  it("shows the time and offset of Prague in winter", () => {
    const r = nowInTimezone("Europe/Prague", new Date("2026-11-03T16:42:00Z"));
    expect(r).toEqual({ now: "Tuesday 3 November 2026, 17:42", timezone: "Europe/Prague", offset: "+01:00" });
  });

  it("follows summer time", () => {
    const r = nowInTimezone("Europe/Prague", new Date("2026-07-15T12:00:00Z"));
    expect(r.offset).toBe("+02:00");
    expect(r.now).toBe("Wednesday 15 July 2026, 14:00");
  });

  it("uses the project's timezone, not Prague (the date can differ)", () => {
    const r = nowInTimezone("America/New_York", new Date("2026-11-03T02:30:00Z"));
    expect(r.now).toBe("Monday 2 November 2026, 21:30");
    expect(r.offset).toBe("-05:00");
  });

  it("just after midnight local time is already the next day (the old UTC date was wrong here)", () => {
    const r = nowInTimezone("Europe/Prague", new Date("2026-11-02T23:30:00Z"));
    expect(r.now).toBe("Tuesday 3 November 2026, 00:30");
  });

  it("falls back to Prague for a missing or mistyped timezone", () => {
    expect(validTimezone(null)).toBe("Europe/Prague");
    expect(validTimezone("Mars/Olympus")).toBe("Europe/Prague");
    expect(nowInTimezone("Mars/Olympus", new Date("2026-11-03T16:42:00Z")).timezone).toBe("Europe/Prague");
  });

  it("UTC has a +00:00 offset", () => {
    expect(nowInTimezone("UTC", new Date("2026-11-03T16:42:00Z")).offset).toBe("+00:00");
  });
});
