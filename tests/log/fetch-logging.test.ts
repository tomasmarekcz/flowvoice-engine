import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyUrl, installFetchLogging } from "../../src/log/fetch-logging";
import { runWithLogContext } from "../../src/log/context";

function makeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("classifyUrl", () => {
  it("maps hosts to services and drops the query string", () => {
    expect(classifyUrl("https://abc.supabase.co/rest/v1/calls?phone=eq.%2B420721071534", "get")).toEqual({
      service: "supabase", op: "GET /rest/v1/calls",
    });
    expect(classifyUrl("https://api.openai.com/v1/chat/completions", "POST")?.service).toBe("openai");
    expect(classifyUrl("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json", "POST")?.service).toBe("twilio");
    expect(classifyUrl("https://api.zadarma.com/v1/info/balance/", "GET")?.service).toBe("zadarma");
    expect(classifyUrl("https://api.stripe.com/v1/customers", "GET")?.service).toBe("stripe");
    expect(classifyUrl("https://api.resend.com/emails", "POST")?.service).toBe("resend");
  });

  it("recognises qdrant and the dashboard API from env", () => {
    const env = { QDRANT_URL: "https://x.cloud.qdrant.io:6333", FRONTEND_API_URL: "http://localhost:3000" };
    expect(classifyUrl("https://x.cloud.qdrant.io:6333/collections/documents/points/search", "POST", env)?.service).toBe("qdrant");
    expect(classifyUrl("http://localhost:3000/api/enquiries", "POST", env)?.service).toBe("dashboard-api");
  });

  it("ignores unknown hosts and invalid urls", () => {
    expect(classifyUrl("https://example.com/x", "GET", {})).toBeNull();
    expect(classifyUrl("not a url", "GET", {})).toBeNull();
  });
});

describe("installFetchLogging", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function install(fake: typeof fetch) {
    globalThis.fetch = fake;
    const log = makeLog();
    installFetchLogging(log);
    return log;
  }

  it("logs a successful call as info with service, op, status and duration", async () => {
    const log = install(vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    await fetch("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json", { method: "POST" });
    expect(log.info).toHaveBeenCalledTimes(1);
    const ctx = log.info.mock.calls[0][1];
    expect(ctx.event).toBe("ext.call");
    expect(ctx.ext).toMatchObject({ service: "twilio", op: "POST /2010-04-01/Accounts/AC1/Messages.json", status: 200 });
    expect(typeof ctx.ext.duration_ms).toBe("number");
  });

  it("logs a 5xx as error with a body snippet, and the caller can still read the body", async () => {
    const log = install(vi.fn(async () => new Response("upstream exploded", { status: 502 })) as unknown as typeof fetch);
    const res = await fetch("https://abc.supabase.co/rest/v1/calls");
    expect(await res.text()).toBe("upstream exploded");
    await new Promise((r) => setTimeout(r, 0));
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1].data.body).toContain("upstream exploded");
  });

  it("logs 4xx as warn", async () => {
    const log = install(vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    await fetch("https://api.openai.com/v1/x");
    await new Promise((r) => setTimeout(r, 0));
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps routine call_events writes out of the info stream", async () => {
    const log = install(vi.fn(async () => new Response("", { status: 201 })) as unknown as typeof fetch);
    await fetch("https://abc.supabase.co/rest/v1/call_events", { method: "POST" });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  it("logs network failures as error and rethrows", async () => {
    const log = install(vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    await expect(fetch("https://api.openai.com/v1/x")).rejects.toThrow("ECONNRESET");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1].ext.status).toBe(0);
  });

  it("does not log unknown hosts", async () => {
    const log = install(vi.fn(async () => new Response("ok")) as unknown as typeof fetch);
    await fetch("https://example.com/a");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("adds correlation headers to dashboard-api calls", async () => {
    const seen: Headers[] = [];
    install(vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    }) as unknown as typeof fetch);
    await runWithLogContext({ call_id: "c1", project_id: "p1", request_id: "r1" }, () =>
      fetch("http://localhost:3000/api/enquiries", { method: "POST", headers: { "X-Internal-Secret": "s" } })
    );
    expect(seen[0].get("x-call-id")).toBe("c1");
    expect(seen[0].get("x-project-id")).toBe("p1");
    expect(seen[0].get("x-request-id")).toBe("r1");
    expect(seen[0].get("x-internal-secret")).toBe("s");
  });

  it("is idempotent", async () => {
    const log = install(vi.fn(async () => new Response("{}")) as unknown as typeof fetch);
    installFetchLogging(log);
    await fetch("https://api.openai.com/v1/x");
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
