import { describe, it, expect } from "vitest";
import { isTestCall, notificationPlan } from "../src/test-call";

describe("test calls from the dashboard", () => {
  it("recognises a browser call (no caller number, no Twilio call)", () => {
    expect(isTestCall(null, null)).toBe(true);
    expect(isTestCall("+420777111222", "CA1")).toBe(false);
    expect(isTestCall(null, "CA1")).toBe(false);
  });

  it("sends the owner's SMS and email only on the first test call, even when they are still switched off", () => {
    expect(notificationPlan(true, true)).toEqual({ forceGenerate: true, send: true });
  });

  it("later test calls write the texts into the call detail but send nothing", () => {
    expect(notificationPlan(true, false)).toEqual({ forceGenerate: true, send: false });
  });

  it("leaves real calls exactly as they were", () => {
    expect(notificationPlan(false, false)).toEqual({ forceGenerate: false, send: true });
  });
});
