import { describe, it, expect } from "vitest";
import { isWithinWorkingHours } from "../src/working-hours";

const HOURS = {
  mon: { from: "08:00", to: "18:00" },
  tue: { from: "08:00", to: "18:00" },
  wed: { from: "08:00", to: "18:00" },
  thu: { from: "08:00", to: "18:00" },
  fri: { from: "08:00", to: "16:00" },
  sat: null,
  sun: null,
};

describe("isWithinWorkingHours", () => {
  it("returns true when no working_hours configured (safe default)", () => {
    // 2026-09-22 is a Tuesday
    expect(isWithinWorkingHours(null, "Europe/Prague", new Date("2026-09-22T10:00:00Z"))).toBe(true);
    expect(isWithinWorkingHours(undefined, "Europe/Prague", new Date("2026-09-22T10:00:00Z"))).toBe(true);
  });

  it("returns true during a configured weekday window", () => {
    // Tuesday 2026-09-22, 10:00 UTC = 12:00 Europe/Prague (CEST, UTC+2)
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-22T10:00:00Z"))).toBe(true);
  });

  it("returns false before opening time", () => {
    // 05:00 UTC = 07:00 Europe/Prague — before the 08:00 open
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-22T05:00:00Z"))).toBe(false);
  });

  it("returns false after closing time", () => {
    // 17:00 UTC = 19:00 Europe/Prague — after the 18:00 close
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-22T17:00:00Z"))).toBe(false);
  });

  it("returns false on a day marked closed", () => {
    // 2026-09-19 is a Saturday, marked null (closed) in HOURS
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-19T10:00:00Z"))).toBe(false);
  });

  it("respects a different timezone", () => {
    // Tuesday 2026-09-22, 10:00 UTC = 06:00 America/New_York — before the 08:00 open there
    expect(isWithinWorkingHours(HOURS, "America/New_York", new Date("2026-09-22T10:00:00Z"))).toBe(false);
    // 13:00 UTC = 09:00 America/New_York — within hours
    expect(isWithinWorkingHours(HOURS, "America/New_York", new Date("2026-09-22T13:00:00Z"))).toBe(true);
  });

  it("respects the exact boundary (inclusive open, exclusive close)", () => {
    // 06:00 UTC = 08:00 Europe/Prague exactly — open
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-22T06:00:00Z"))).toBe(true);
    // 16:00 UTC = 18:00 Europe/Prague exactly — closed
    expect(isWithinWorkingHours(HOURS, "Europe/Prague", new Date("2026-09-22T16:00:00Z"))).toBe(false);
  });
});
