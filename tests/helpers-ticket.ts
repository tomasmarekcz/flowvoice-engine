import { createHmac } from "node:crypto";

// Same format the dashboard signs (flowvoice: src/lib/test-call/ticket.ts).
export function makeTicket(
  secret: string,
  overrides: Partial<{ v: number; p: string; ph: string; max: number; exp: number; n: string }> = {},
): string {
  const payload = { v: 1, p: "proj-1", ph: "+420777123456", max: 300, exp: Date.now() + 60_000, n: Math.random().toString(36).slice(2), ...overrides };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update("test-call-ticket." + body).digest("base64url");
  return `${body}.${signature}`;
}
