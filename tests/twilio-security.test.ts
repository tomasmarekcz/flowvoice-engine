import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import type { WebSocket as WS } from "ws";

const h = vi.hoisted(() => ({ startCallSession: vi.fn() }));
vi.mock("../src/session-factory", () => ({ startCallSession: h.startCallSession }));

const TOKEN = "0123456789abcdef0123456789abcdef";
const SECRET = "internal-secret-for-tests";

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }), text: async () => "" }));
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const sec = await import("../src/twilio-security");
const handlers = await import("../src/handlers/twilio");

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({ TWILIO_SKIP_VALIDATION: undefined, TWILIO_AUTH_TOKEN: TOKEN, ENGINE_INTERNAL_SECRET: SECRET, ENGINE_HOST: "leadoro.io" });
});
afterEach(() => vi.clearAllMocks());

function app() {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.post("/twilio/voice", handlers.handleTwilioVoiceWebhook);
  a.post("/twilio/voice/dial-status", handlers.handleDialStatusCallback);
  a.post("/twilio/recording-status", handlers.handleRecordingStatusCallback);
  a.post("/twilio/sms-status", handlers.handleSmsStatusCallback);
  return a;
}

/** Signs a request the way Twilio does: the full URL as Twilio called it (with the query string) plus the form fields. */
function signed(pathAndQuery: string, params: Record<string, string>, token = TOKEN) {
  const signature = twilio.getExpectedTwilioSignature(token, `https://leadoro.io${pathAndQuery}`, params);
  return request(app()).post(pathAndQuery).set("X-Twilio-Signature", signature).type("form").send(params);
}

const voiceParams = { From: "sip:+420777123456@sip.zadarma.com", CallSid: "CA123" };
const VOICE = "/twilio/voice?project_id=20c026ed-4315-47bf-83e5-fc229cdc978e";

describe("Twilio webhook signature", () => {
  it("accepts a real call: the signature covers the query string", async () => {
    const res = await signed(VOICE, voiceParams);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Stream");
  });

  it("rejects a request without a signature", async () => {
    const res = await request(app()).post(VOICE).type("form").send(voiceParams);
    expect(res.status).toBe(403);
  });

  it("rejects a signature made with another token", async () => {
    const res = await signed(VOICE, voiceParams, "ffffffffffffffffffffffffffffffff");
    expect(res.status).toBe(403);
  });

  it("rejects a signature made without the query string (the old bug) and a changed body", async () => {
    const noQuery = twilio.getExpectedTwilioSignature(TOKEN, "https://leadoro.io/twilio/voice", voiceParams);
    expect((await request(app()).post(VOICE).set("X-Twilio-Signature", noQuery).type("form").send(voiceParams)).status).toBe(403);

    const good = twilio.getExpectedTwilioSignature(TOKEN, `https://leadoro.io${VOICE}`, voiceParams);
    const tampered = await request(app()).post(VOICE).set("X-Twilio-Signature", good).type("form").send({ ...voiceParams, From: "sip:+420999@x" });
    expect(tampered.status).toBe(403);
  });

  it("guards the other three webhooks too", async () => {
    const dial = "/twilio/voice/dial-status?project_id=p1&caller_phone=%2B420777123456&call_sid=CA123&with_ai_fallback=false";
    expect((await signed(dial, { DialCallStatus: "completed" })).status).toBe(200);
    expect((await request(app()).post(dial).type("form").send({ DialCallStatus: "completed" })).status).toBe(403);

    expect((await signed("/twilio/recording-status", { RecordingStatus: "in-progress", CallSid: "CA1" })).status).toBe(200);
    expect((await request(app()).post("/twilio/recording-status").type("form").send({ RecordingStatus: "completed", CallSid: "CA1", RecordingUrl: "x" })).status).toBe(403);

    expect((await signed("/twilio/sms-status", { MessageSid: "SM1", MessageStatus: "queued" })).status).toBe(200);
    expect((await request(app()).post("/twilio/sms-status").type("form").send({ MessageSid: "SM1", MessageStatus: "delivered" })).status).toBe(403);
  });

  it("lets everything through while TWILIO_SKIP_VALIDATION=true (the rollback switch)", async () => {
    setEnv({ TWILIO_SKIP_VALIDATION: "true" });
    const res = await request(app()).post(VOICE).type("form").send(voiceParams);
    expect(res.status).toBe(200);
  });
});

describe("request URL used for the signature", () => {
  it("is https + ENGINE_HOST + the path with its query string", () => {
    const req = { originalUrl: "/twilio/voice?project_id=abc", get: () => "localhost:8080", protocol: "http" };
    expect(sec.requestUrl(req as never)).toBe("https://leadoro.io/twilio/voice?project_id=abc");
  });

  it("falls back to the Host header when ENGINE_HOST is not set (local development)", () => {
    setEnv({ ENGINE_HOST: undefined });
    const req = { originalUrl: "/twilio/voice", get: () => "localhost:8080", protocol: "http" };
    expect(sec.requestUrl(req as never)).toBe("http://localhost:8080/twilio/voice");
  });
});

describe("media stream authorisation", () => {
  const now = 1_800_000_000_000;

  it("accepts the token the webhook created for this project and call", () => {
    const token = sec.createStreamAuth("p1", "CA1", now);
    expect(sec.verifyStreamAuth(token, "p1", "CA1", now + 60_000)).toEqual({ ok: true });
  });

  it("rejects a missing token, another call, another project, a forged and an expired token", () => {
    const token = sec.createStreamAuth("p1", "CA1", now);
    expect(sec.verifyStreamAuth(undefined, "p1", "CA1", now)).toEqual({ ok: false, reason: "missing" });
    expect(sec.verifyStreamAuth(token, "p1", "CA2", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(sec.verifyStreamAuth(token, "p2", "CA1", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(sec.verifyStreamAuth(token + "x", "p1", "CA1", now)).toEqual({ ok: false, reason: "invalid" });
    expect(sec.verifyStreamAuth("a.b", "p1", "CA1", now)).toEqual({ ok: false, reason: "invalid" });
    expect(sec.verifyStreamAuth(token, "p1", "CA1", now + 6 * 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("the voice webhook puts a valid token into the stream parameters", async () => {
    const res = await signed(VOICE, voiceParams);
    const auth = /<Parameter name="auth" value="([^"]+)"/.exec(res.text)?.[1];
    expect(auth).toBeTruthy();
    expect(sec.verifyStreamAuth(auth, "20c026ed-4315-47bf-83e5-fc229cdc978e", "CA123")).toEqual({ ok: true });
  });
});

describe("start-up check", () => {
  it("passes with the token and the secret, or when validation is switched off", () => {
    expect(() => sec.assertTwilioSecurityConfigured()).not.toThrow();
    setEnv({ TWILIO_SKIP_VALIDATION: "true", TWILIO_AUTH_TOKEN: undefined, ENGINE_INTERNAL_SECRET: undefined });
    expect(() => sec.assertTwilioSecurityConfigured()).not.toThrow();
  });

  it("refuses to start with validation on but a missing token or secret (so the deploy rolls back)", () => {
    setEnv({ TWILIO_AUTH_TOKEN: "" });
    expect(() => sec.assertTwilioSecurityConfigured()).toThrow(/TWILIO_AUTH_TOKEN/);
    setEnv({ TWILIO_AUTH_TOKEN: TOKEN, ENGINE_INTERNAL_SECRET: "" });
    expect(() => sec.assertTwilioSecurityConfigured()).toThrow(/ENGINE_INTERNAL_SECRET/);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.emit("close"); }
  says(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}

async function openStream(customParameters: Record<string, string>) {
  const socket = new FakeSocket();
  h.startCallSession.mockResolvedValue({ audioFormat: "mulaw8", end: vi.fn().mockResolvedValue(undefined), handleClientAudio: vi.fn(), handleTwilioMark: vi.fn() });
  await handlers.handleTwilioConnection(socket as unknown as WS, {} as IncomingMessage);
  socket.says({ event: "start", streamSid: "MZ1", start: { customParameters } });
  await new Promise((r) => setTimeout(r, 20));
  return socket;
}

describe("/ws/twilio start message", () => {
  it("starts the assistant only with the token our webhook created", async () => {
    const auth = sec.createStreamAuth("p1", "CA1");
    const socket = await openStream({ project_id: "p1", caller_phone: "+420777123456", call_sid: "CA1", auth });
    expect(h.startCallSession).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(1);
  });

  it("closes the stream and starts nothing without a token, with a forged one or one for another call", async () => {
    for (const customParameters of [
      { project_id: "p1", call_sid: "CA1" },
      { project_id: "p1", call_sid: "CA1", auth: "forged.token" },
      { project_id: "p1", call_sid: "CA2", auth: sec.createStreamAuth("p1", "CA1") },
    ]) {
      h.startCallSession.mockClear();
      const socket = await openStream(customParameters);
      expect(h.startCallSession).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(3);
    }
  });

  it("does not check the token while TWILIO_SKIP_VALIDATION=true", async () => {
    setEnv({ TWILIO_SKIP_VALIDATION: "true" });
    await openStream({ project_id: "p1", call_sid: "CA1" });
    expect(h.startCallSession).toHaveBeenCalledTimes(1);
  });
});
