import { describe, it, expect } from "vitest";
import { verifyTestCallTicket } from "../src/test-call-ticket";
import { makeTicket } from "./helpers-ticket";

const SECRET = "engine-secret";

describe("test call ticket", () => {
  it("accepts a valid ticket and returns the project, the typed number and the limit", () => {
    const result = verifyTestCallTicket(makeTicket(SECRET), SECRET);
    expect(result).toEqual({ ok: true, ticket: { projectId: "proj-1", phone: "+420777123456", maxSeconds: 300 } });
  });

  it("rejects a missing ticket", () => {
    expect(verifyTestCallTicket(null, SECRET)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a ticket signed with another secret", () => {
    expect(verifyTestCallTicket(makeTicket("other"), SECRET)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a ticket whose content was changed after signing", () => {
    const [body, signature] = makeTicket(SECRET).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: "other-project" })).toString("base64url");
    expect(verifyTestCallTicket(`${tampered}.${signature}`, SECRET)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an expired ticket", () => {
    expect(verifyTestCallTicket(makeTicket(SECRET, { exp: Date.now() - 1 }), SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("works only once", () => {
    const ticket = makeTicket(SECRET, { n: "same-nonce" });
    expect(verifyTestCallTicket(ticket, SECRET).ok).toBe(true);
    expect(verifyTestCallTicket(ticket, SECRET)).toEqual({ ok: false, reason: "used" });
  });

  it("rejects everything when the server has no secret", () => {
    expect(verifyTestCallTicket(makeTicket(SECRET), undefined)).toEqual({ ok: false, reason: "invalid" });
  });
});
