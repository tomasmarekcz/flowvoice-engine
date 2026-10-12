import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { inLogContext } from "../src/log-http";
import { getLogContext } from "../src/log/context";

describe("inLogContext", () => {
  it("exposes request, project and call sid to everything the handler logs", async () => {
    let seen: ReturnType<typeof getLogContext> = {};
    const handler = inLogContext(async () => { seen = getLogContext(); });
    await handler(
      { query: { project_id: "p1" }, body: { CallSid: "CA123" } } as unknown as Request,
      {} as Response
    );
    expect(seen.project_id).toBe("p1");
    expect(seen.call_sid).toBe("CA123");
    expect(typeof seen.request_id).toBe("string");
  });

  it("falls back to body and query values and tolerates an empty request", async () => {
    let seen: ReturnType<typeof getLogContext> = {};
    await inLogContext(async () => { seen = getLogContext(); })(
      { query: { call_sid: "CA9" }, body: undefined } as unknown as Request, {} as Response
    );
    expect(seen.call_sid).toBe("CA9");
    expect(seen.project_id ?? null).toBeNull();
  });
});
