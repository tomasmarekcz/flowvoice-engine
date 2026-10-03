import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.TWILIO_SKIP_VALIDATION = "true";

const { handleSmsStatusCallback } = await import("../src/handlers/twilio");

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post("/sms-status", handleSmsStatusCallback);
  return app;
}

describe("handleSmsStatusCallback", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => [{ id: "call-1" }] });
  });

  it("stores a delivered status on the call that owns the owner SMS", async () => {
    const res = await request(makeApp()).post("/sms-status").send("MessageSid=SM1&MessageStatus=delivered");
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(200);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("calls?sms_owner_sid=eq.SM1");
    expect(JSON.parse(opts.body as string)).toEqual({ sms_owner_status: "delivered", sms_owner_error_code: null });
  });

  it("falls back to the caller SMS column and stores the Twilio error code on failure", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: "call-1" }] });

    await request(makeApp()).post("/sms-status").send("MessageSid=SM2&MessageStatus=undelivered&ErrorCode=30007");
    await new Promise((r) => setTimeout(r, 50));

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("calls?sms_caller_sid=eq.SM2");
    expect(JSON.parse(opts.body as string)).toEqual({ sms_caller_status: "undelivered", sms_caller_error_code: "30007" });
  });

  it("ignores intermediate statuses such as queued and sent", async () => {
    await request(makeApp()).post("/sms-status").send("MessageSid=SM3&MessageStatus=sent");
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
