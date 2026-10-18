import { createHmac, timingSafeEqual } from "node:crypto";

// A test call from the dashboard's QR code connects with a short-lived ticket signed by the dashboard
// (flowvoice: src/lib/test-call/ticket.ts, same format). The ticket carries the project, the phone number the
// owner typed and the time limit, so nothing in the URL can be changed by the browser. It is signed with
// ENGINE_INTERNAL_SECRET (already on both servers) and works once.

const PREFIX = "test-call-ticket.";

export interface TestCallTicket {
  projectId: string;
  /** Full international number the owner typed, e.g. +420777123456. */
  phone: string;
  maxSeconds: number;
}

export type TicketResult =
  | { ok: true; ticket: TestCallTicket }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "used" };

const usedNonces = new Map<string, number>();

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(PREFIX + body).digest("base64url");
}

function forgetExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of usedNonces) if (expiresAt < now) usedNonces.delete(nonce);
}

export function verifyTestCallTicket(raw: string | null, secret: string | undefined, now: number = Date.now()): TicketResult {
  if (!raw) return { ok: false, reason: "missing" };
  if (!secret) return { ok: false, reason: "invalid" };
  const [body, signature, ...rest] = raw.split(".");
  if (!body || !signature || rest.length > 0) return { ok: false, reason: "invalid" };

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };

  let payload: { v?: number; p?: string; ph?: string; max?: number; exp?: number; n?: string };
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
  if (payload.v !== 1 || !payload.p || !payload.ph || !payload.n || typeof payload.exp !== "number" || typeof payload.max !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (payload.exp < now) return { ok: false, reason: "expired" };

  forgetExpiredNonces(now);
  if (usedNonces.has(payload.n)) return { ok: false, reason: "used" };
  usedNonces.set(payload.n, payload.exp);

  return { ok: true, ticket: { projectId: payload.p, phone: payload.ph, maxSeconds: payload.max } };
}
