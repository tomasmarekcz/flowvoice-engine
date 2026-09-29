import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.TWILIO_ACCOUNT_SID = "ACtest123";
process.env.TWILIO_AUTH_TOKEN = "authtest";
process.env.TWILIO_SMS_FROM = "Leadoro";

const smsModule = await import("../src/sms");
const { sendSmsNotifications } = smsModule;

describe("sendSmsNotifications", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sid: "SM123" }) });
  });

  it("sends owner SMS when ownerSms and ownerPhone are set", async () => {
    const result = await sendSmsNotifications({
      ownerSms: "New call from Jan Novák.",
      ownerPhone: "+420777000111",
      callerSms: null,
      callerPhone: null,
    });

    expect(result.ownerSent).toBe(true);
    expect(result.callerSent).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("ACtest123/Messages.json");
    expect(opts.method).toBe("POST");
    expect(opts.body).toContain("To=%2B420777000111");
    expect(opts.body).toContain("From=Leadoro");
  });

  it("returns the Twilio message SIDs and asks for delivery reports when ENGINE_HOST is set", async () => {
    process.env.ENGINE_HOST = "leadoro.io";
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sid: "SM999" }) });

    const result = await sendSmsNotifications({
      ownerSms: "Owner summary.",
      ownerPhone: "+420777000111",
      callerSms: null,
      callerPhone: null,
    });
    delete process.env.ENGINE_HOST;

    expect(result.ownerSid).toBe("SM999");
    expect(result.callerSid).toBeNull();
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toContain("StatusCallback=https%3A%2F%2Fleadoro.io%2Ftwilio%2Fsms-status");
  });

  it("sends both SMS when both are set", async () => {
    const result = await sendSmsNotifications({
      ownerSms: "Owner summary.",
      ownerPhone: "+420777000111",
      callerSms: "Thank you for calling.",
      callerPhone: "+420721071534",
    });

    expect(result.ownerSent).toBe(true);
    expect(result.callerSent).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not send when phone is null", async () => {
    const result = await sendSmsNotifications({
      ownerSms: "Some message",
      ownerPhone: null,
      callerSms: null,
      callerPhone: null,
    });

    expect(result.ownerSent).toBe(false);
    expect(result.callerSent).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns ownerSent=false and does not throw when Twilio returns error", async () => {
    mockFetch.mockResolvedValue({ ok: false, text: async () => "Bad request" });

    const result = await sendSmsNotifications({
      ownerSms: "Test",
      ownerPhone: "+420777000111",
      callerSms: null,
      callerPhone: null,
    });

    expect(result.ownerSent).toBe(false);
  });

  describe("on staging", () => {
    beforeEach(() => {
      process.env.APP_ENV = "staging";
      process.env.STAGING_ALLOWED_PHONES = "+420111222333";
    });
    afterEach(() => {
      delete process.env.APP_ENV;
      delete process.env.STAGING_ALLOWED_PHONES;
    });

    it("does not send to a phone outside the allowlist and reports it as not sent", async () => {
      const result = await sendSmsNotifications({
        ownerSms: "hi",
        ownerPhone: "+420999000111",
        callerSms: "hello",
        callerPhone: "+420721071534",
      });

      expect(result).toEqual({ ownerSent: false, callerSent: false, ownerSid: null, callerSid: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends to an allowlisted phone", async () => {
      const result = await sendSmsNotifications({
        ownerSms: "hi",
        ownerPhone: "+420111222333",
        callerSms: null,
        callerPhone: null,
      });

      expect(result.ownerSent).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });
});
