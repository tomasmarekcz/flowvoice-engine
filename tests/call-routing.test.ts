import { describe, it, expect } from "vitest";
import { decideCallRouting } from "../src/call-routing";

const WITHIN_HOURS_NOW = new Date("2026-09-22T10:00:00Z"); // Tue 12:00 Europe/Prague
const OUTSIDE_HOURS_NOW = new Date("2026-09-22T20:00:00Z"); // Tue 22:00 Europe/Prague
const HOURS = { mon: { from: "08:00", to: "18:00" }, tue: { from: "08:00", to: "18:00" } };

describe("decideCallRouting", () => {
  it("is_active = false is declined outright, regardless of answer_mode, hours, or owner phone", () => {
    expect(decideCallRouting({
      isActive: false, answerMode: "always", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "declined" });
    expect(decideCallRouting({
      isActive: false, answerMode: "outside_hours", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "declined" });
    expect(decideCallRouting({
      isActive: false, answerMode: undefined, workingHours: null, timezone: undefined,
      hasOwnerPhone: false, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "declined" });
  });

  it("always mode goes straight to AI, regardless of hours or owner phone", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "always", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("missed_calls mode goes straight to AI (owner's carrier already filtered it)", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "missed_calls", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("defaults to missed_calls behavior (AI) when answer_mode is unset", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: undefined, workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("outside_hours mode dials the owner with no AI fallback during working hours", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "outside_hours", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "dial", withAiFallback: false });
  });

  it("outside_hours mode goes straight to AI outside working hours", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "outside_hours", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: OUTSIDE_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("missed_and_outside mode dials the owner WITH AI fallback during working hours", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "missed_and_outside", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "dial", withAiFallback: true });
  });

  it("missed_and_outside mode goes straight to AI outside working hours", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "missed_and_outside", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: true, now: OUTSIDE_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("falls back to AI for outside_hours/missed_and_outside when there is no owner phone on file", () => {
    expect(decideCallRouting({
      isActive: true, answerMode: "outside_hours", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: false, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "ai" });
    expect(decideCallRouting({
      isActive: true, answerMode: "missed_and_outside", workingHours: HOURS, timezone: "Europe/Prague",
      hasOwnerPhone: false, now: WITHIN_HOURS_NOW,
    })).toEqual({ kind: "ai" });
  });

  it("goes to AI in dial modes when no working hours are stored", () => {
    for (const answerMode of ["outside_hours", "missed_and_outside"] as const) {
      expect(decideCallRouting({
        isActive: true, answerMode, workingHours: null, timezone: "Europe/Prague",
        hasOwnerPhone: true, now: WITHIN_HOURS_NOW,
      })).toEqual({ kind: "ai" });
    }
  });
});
