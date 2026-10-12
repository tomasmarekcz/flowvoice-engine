import { describe, it, expect } from "vitest";
import { fitEvent, maskPhone, MAX_EVENT_BYTES, MAX_STRING, redactContext, redactText } from "../../src/log/redact";

describe("maskPhone", () => {
  it("keeps country prefix and last three digits", () => {
    expect(maskPhone("+420721071534")).toBe("+420 *** *** 534");
  });
  it("leaves short numbers alone", () => {
    expect(maskPhone("123")).toBe("123");
  });
});

describe("redactContext", () => {
  it("masks phone-like keys but not dates under from/to", () => {
    const out = redactContext({ caller: "+420721071534", from: "2026-10-12T08:00:00.000Z", to: "+420 721 071 534" });
    expect(out.caller).toBe("+420 *** *** 534");
    expect(out.from).toBe("2026-10-12T08:00:00.000Z");
    expect(out.to).toBe("+420 *** *** 534");
  });

  it("masks phone numbers inside free text and SIP URIs", () => {
    expect(redactText("incoming sip:+420721071534@sip.zadarma.com now")).toBe(
      "incoming sip:+420 *** *** 534@sip.zadarma.com now"
    );
  });

  it("redacts secrets, including nested headers, but not numeric token counters", () => {
    const out = redactContext({
      api_key: "sk-123",
      headers: { Authorization: "Bearer abc", "content-type": "json" },
      input_tokens: 42,
    });
    expect(out.api_key).toBe("[redacted]");
    expect(out.headers).toEqual({ Authorization: "[redacted]", "content-type": "json" });
    expect(out.input_tokens).toBe(42);
  });

  it("turns err/error into flat error + stack strings", () => {
    const out = redactContext({ err: new Error("boom +420721071534") });
    expect(out.error).toBe("boom +420 *** *** 534");
    expect(typeof out.stack).toBe("string");
    expect("err" in out).toBe(false);
  });

  it("truncates long strings and survives circular structures", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    const out = redactContext({ big: "x".repeat(MAX_STRING + 500), circular });
    expect((out.big as string).length).toBeLessThanOrEqual(MAX_STRING + 20);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("fitEvent", () => {
  it("returns small events untouched", () => {
    const e = { ts: "t", level: "info", service: "engine", message: "hi" };
    expect(fitEvent(e)).toBe(e);
  });

  it("slims an oversized event but keeps identifying fields", () => {
    const e = {
      ts: "t", level: "error", service: "engine", message: "big", call_id: "c1",
      data: Array.from({ length: 40 }, () => "y".repeat(1900)),
    };
    const fitted = fitEvent(e);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(fitted.call_id).toBe("c1");
    expect(fitted.truncated).toBe(true);
    expect("data" in fitted).toBe(false);
  });
});
