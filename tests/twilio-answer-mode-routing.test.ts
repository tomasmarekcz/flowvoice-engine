import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.TWILIO_SKIP_VALIDATION = "true";
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
process.env.ENGINE_HOST = "leadoro.io";

const { handleTwilioVoiceWebhook, handleDialStatusCallback } = await import("../src/handlers/twilio");

function makeApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post("/twilio/voice", handleTwilioVoiceWebhook);
  app.post("/twilio/voice/dial-status", handleDialStatusCallback);
  return app;
}

const HOURS = {
  mon: { from: "08:00", to: "18:00" }, tue: { from: "08:00", to: "18:00" },
  wed: { from: "08:00", to: "18:00" }, thu: { from: "08:00", to: "18:00" },
  fri: { from: "08:00", to: "16:00" }, sat: null, sun: null,
};

// Deliberately wide-open/always-closed, so these integration tests exercise
// the real wall clock deterministically without needing to fake Date/Intl.
const ALWAYS_OPEN = {
  mon: { from: "00:00", to: "23:59" }, tue: { from: "00:00", to: "23:59" },
  wed: { from: "00:00", to: "23:59" }, thu: { from: "00:00", to: "23:59" },
  fri: { from: "00:00", to: "23:59" }, sat: { from: "00:00", to: "23:59" }, sun: { from: "00:00", to: "23:59" },
};
const ALWAYS_CLOSED = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

function mockSupabaseAndEligibility(opts: {
  answerMode: string | null; ownerPhone: string | null; workingHours: unknown; isActive?: boolean;
}) {
  mockFetch.mockImplementation((input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input ?? "");
    if (url.includes("call-eligibility")) {
      return Promise.resolve({ ok: true, json: async () => ({ allowed: true, reason: null }) });
    }
    if (url.includes("/rest/v1/assistant_settings")) {
      return Promise.resolve({
        json: async () => [{
          project_id: "11111111-1111-1111-1111-111111111111", is_active: opts.isActive ?? true,
          answer_mode: opts.answerMode, working_hours: opts.workingHours,
          calendar_id: null, capabilities: {},
        }],
      });
    }
    if (url.includes("/rest/v1/projects")) {
      return Promise.resolve({ json: async () => [{ owner_phone: opts.ownerPhone, owner_email: null, name: null, industry: null, description: null, website: null, language: null }] });
    }
    return Promise.resolve({ json: async () => [] });
  });
}

describe("answer_mode call routing (end-to-end webhook)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("always mode connects straight to the AI stream", async () => {
    mockSupabaseAndEligibility({ answerMode: "always", ownerPhone: "+420700000000", workingHours: HOURS });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
    expect(res.text).not.toContain("<Dial");
  });

  it("missed_calls mode connects straight to the AI stream (no <Dial>)", async () => {
    mockSupabaseAndEligibility({ answerMode: "missed_calls", ownerPhone: "+420700000000", workingHours: HOURS });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
    expect(res.text).not.toContain("<Dial");
  });

  it("outside_hours mode dials the owner during working hours, no AI fallback in the action URL", async () => {
    mockSupabaseAndEligibility({ answerMode: "outside_hours", ownerPhone: "+420700000000", workingHours: ALWAYS_OPEN });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("+420700000000");
    expect(res.text).toContain("with_ai_fallback=false");
    expect(res.text).not.toContain("<Stream");
  });

  it("outside_hours mode connects straight to AI outside working hours", async () => {
    mockSupabaseAndEligibility({ answerMode: "outside_hours", ownerPhone: "+420700000000", workingHours: ALWAYS_CLOSED });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
    expect(res.text).not.toContain("<Dial");
  });

  it("missed_and_outside mode dials the owner with AI fallback enabled in the action URL", async () => {
    mockSupabaseAndEligibility({ answerMode: "missed_and_outside", ownerPhone: "+420700000000", workingHours: ALWAYS_OPEN });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("with_ai_fallback=true");
  });

  it("falls back to AI when the mode would dial but there is no owner phone on file", async () => {
    mockSupabaseAndEligibility({ answerMode: "outside_hours", ownerPhone: null, workingHours: ALWAYS_OPEN });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Stream");
    expect(res.text).not.toContain("<Dial");
  });

  it("is_active = false declines the call outright instead of connecting to AI", async () => {
    mockSupabaseAndEligibility({ answerMode: "always", ownerPhone: "+420700000000", workingHours: ALWAYS_OPEN, isActive: false });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Reject");
    expect(res.text).not.toContain("<Say");
    expect(res.text).not.toContain("<Stream");
    expect(res.text).not.toContain("<Dial");
  });

  it("is_active = false takes priority over an answer_mode that would otherwise dial the owner", async () => {
    mockSupabaseAndEligibility({ answerMode: "outside_hours", ownerPhone: "+420700000000", workingHours: ALWAYS_OPEN, isActive: false });

    const res = await request(makeApp())
      .post("/twilio/voice?project_id=11111111-1111-1111-1111-111111111111")
      .send("From=sip:+420777123456@sip.zadarma.com&CallSid=CA123");

    expect(res.text).toContain("<Reject");
    expect(res.text).not.toContain("<Dial");
    expect(res.text).not.toContain("<Stream");
  });
});

describe("dial-status callback", () => {
  beforeEach(() => mockFetch.mockReset());

  it("hangs up when the owner answered (DialCallStatus=completed)", async () => {
    const res = await request(makeApp())
      .post("/twilio/voice/dial-status?project_id=11111111-1111-1111-1111-111111111111&caller_phone=%2B420777123456&call_sid=CA123&with_ai_fallback=true")
      .send("DialCallStatus=completed");

    expect(res.text).toContain("<Hangup");
    expect(res.text).not.toContain("<Stream");
  });

  it("hangs up on no-answer when the mode has no AI fallback (outside_hours)", async () => {
    const res = await request(makeApp())
      .post("/twilio/voice/dial-status?project_id=11111111-1111-1111-1111-111111111111&caller_phone=%2B420777123456&call_sid=CA123&with_ai_fallback=false")
      .send("DialCallStatus=no-answer");

    expect(res.text).toContain("<Hangup");
    expect(res.text).not.toContain("<Stream");
  });

  it("falls back to the AI stream on no-answer when the mode wants an AI fallback (missed_and_outside)", async () => {
    const res = await request(makeApp())
      .post("/twilio/voice/dial-status?project_id=11111111-1111-1111-1111-111111111111&caller_phone=%2B420777123456&call_sid=CA123&with_ai_fallback=true")
      .send("DialCallStatus=no-answer");

    expect(res.text).toContain("<Stream");
    expect(res.text).not.toContain("<Recording");
  });

  it("falls back to the AI stream on busy when AI fallback is enabled", async () => {
    const res = await request(makeApp())
      .post("/twilio/voice/dial-status?project_id=11111111-1111-1111-1111-111111111111&caller_phone=%2B420777123456&call_sid=CA123&with_ai_fallback=true")
      .send("DialCallStatus=busy");

    expect(res.text).toContain("<Stream");
  });
});
