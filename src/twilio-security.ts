import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import twilio from "twilio";
import { logger } from "./logger";

// Two protections that keep strangers from starting calls on our account (LEA-59):
//  1. Every webhook must carry Twilio's signature (made from the account's Auth Token, the full URL and the form fields).
//  2. The media stream (/ws/twilio) must carry a token that only our own webhook creates (signed with ENGINE_INTERNAL_SECRET).
// TWILIO_SKIP_VALIDATION=true switches both off; it is the one-minute rollback and the setting for local development.

type Env = Record<string, string | undefined>;

export function validationEnabled(env: Env = process.env): boolean {
  return env.TWILIO_SKIP_VALIDATION !== "true";
}

/** The URL Twilio signed: https + our public host + the path WITH its query string (e.g. ?project_id=...). */
export function requestUrl(req: Pick<Request, "originalUrl" | "get" | "protocol">, env: Env = process.env): string {
  const host = env.ENGINE_HOST ?? req.get("host") ?? "";
  const protocol = env.ENGINE_HOST ? "https" : req.protocol;
  return `${protocol}://${host}${req.originalUrl}`;
}

/** True when the request really comes from Twilio (or validation is off). Otherwise answers 403 and logs why. */
export function guardTwilioRequest(req: Request, res: Response): boolean {
  if (!validationEnabled()) return true;

  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const signature = (req.headers["x-twilio-signature"] as string | undefined) ?? "";
  const url = requestUrl(req);
  const body = (req.body ?? {}) as Record<string, string>;

  const reason = !token ? "no_token" : !signature ? "missing_signature" : !twilio.validateRequest(token, signature, url, body) ? "mismatch" : null;
  if (!reason) return true;

  logger.warn("twilio request rejected", {
    event: "twilio.signature_rejected",
    reason,
    path: req.path,
    expected_url: url,
    project_id: (req.query["project_id"] as string | undefined) ?? body["project_id"] ?? null,
    call_sid: body["CallSid"] ?? null,
    from: body["From"] ?? null,
  });
  res.status(403).send("Forbidden");
  return false;
}

// ─── Media stream token ────────────────────────────────────────────────────────

const STREAM_PREFIX = "twilio-stream.";
const STREAM_TTL_MS = 5 * 60_000;

function streamSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(STREAM_PREFIX + body).digest("base64url");
}

/** Token for one call, put into the TwiML <Stream> parameters. Empty when there is no secret (validation off). */
export function createStreamAuth(projectId: string, callSid: string, now: number = Date.now()): string {
  const secret = process.env.ENGINE_INTERNAL_SECRET;
  if (!secret) return "";
  const body = Buffer.from(JSON.stringify({ v: 1, p: projectId, c: callSid, exp: now + STREAM_TTL_MS })).toString("base64url");
  return `${body}.${streamSignature(body, secret)}`;
}

export type StreamAuthResult = { ok: true } | { ok: false; reason: "missing" | "invalid" | "mismatch" | "expired" };

export function verifyStreamAuth(
  raw: string | null | undefined,
  projectId: string | null,
  callSid: string | null,
  now: number = Date.now(),
): StreamAuthResult {
  const secret = process.env.ENGINE_INTERNAL_SECRET;
  if (!raw) return { ok: false, reason: "missing" };
  if (!secret) return { ok: false, reason: "invalid" };

  const [body, signature, ...rest] = raw.split(".");
  if (!body || !signature || rest.length > 0) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(streamSignature(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };

  let payload: { v?: number; p?: string; c?: string; exp?: number };
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
  if (payload.v !== 1 || typeof payload.exp !== "number") return { ok: false, reason: "invalid" };
  if (payload.exp < now) return { ok: false, reason: "expired" };
  if (payload.p !== projectId || payload.c !== callSid) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** At start: validation on but no token / secret would reject every call, so refuse to start (the deploy then rolls back). */
export function assertTwilioSecurityConfigured(env: Env = process.env): void {
  if (!validationEnabled(env)) return;
  if (!env.TWILIO_AUTH_TOKEN) throw new Error("Refusing to start: Twilio validation is on but TWILIO_AUTH_TOKEN is not set (or set TWILIO_SKIP_VALIDATION=true).");
  if (!env.ENGINE_INTERNAL_SECRET) throw new Error("Refusing to start: Twilio validation is on but ENGINE_INTERNAL_SECRET is not set (or set TWILIO_SKIP_VALIDATION=true).");
}
