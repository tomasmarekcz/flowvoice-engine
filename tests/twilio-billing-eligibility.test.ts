import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.TWILIO_SKIP_VALIDATION = "true";
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { handleTwilioVoiceWebhook } = await import("../src/handlers/twilio");

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post("/twilio/voice", handleTwilioVoiceWebhook);
  return app;
}

describe("handleTwilioVoiceWebhook billing eligibility", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("connects the media stream when the call is eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: true, reason: null }) });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=proj-1")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
  });

  it("rejects with a spoken message and no stream when not eligible", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ allowed: false, reason: "needs_payment" }) });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=proj-1")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).not.toContain("<Stream");
    expect(res.text).toContain("<Say");
    expect(res.text).toContain("<Hangup");
  });

  it("fails open (still connects) when the eligibility check errors", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=proj-1")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
  });
});
