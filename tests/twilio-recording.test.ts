import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { handleRecordingStatusCallback } = await import("../src/handlers/twilio");

describe("handleRecordingStatusCallback", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
  });

  it("responds 200 immediately", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post("/recording-status", handleRecordingStatusCallback);

    const res = await request(app)
      .post("/recording-status")
      .send(
        "RecordingStatus=completed&RecordingUrl=https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123&RecordingSid=RE123&CallSid=CA123"
      );

    expect(res.status).toBe(200);
  });

  it("patches Supabase with recording_url when status is completed", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post("/recording-status", handleRecordingStatusCallback);

    await request(app)
      .post("/recording-status")
      .send(
        "RecordingStatus=completed&RecordingUrl=https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123&RecordingSid=RE123&CallSid=CA456"
      );

    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("calls?twilio_call_sid=eq.CA456"),
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("does not patch Supabase when status is not completed", async () => {
    mockFetch.mockClear();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post("/recording-status", handleRecordingStatusCallback);

    await request(app)
      .post("/recording-status")
      .send("RecordingStatus=failed&RecordingSid=RE123&CallSid=CA789");

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
