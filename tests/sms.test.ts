import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.TWILIO_ACCOUNT_SID = "ACtest123";
process.env.TWILIO_AUTH_TOKEN = "authtest";
process.env.TWILIO_SMS_FROM = "FlowVoice";

const { sendSmsNotifications } = await import("../src/sms");

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
    expect(opts.body).toContain("From=FlowVoice");
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
});
