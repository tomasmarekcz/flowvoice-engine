import { getLogContext } from "./context";

type Log = Record<"debug" | "info" | "warn" | "error", (message: string, ctx?: Record<string, unknown>) => void>;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type Env = Record<string, string | undefined>;

const MARK = Symbol.for("leadoro.fetchLogging");
const SLOW_MS = 3000;
const BODY_SNIPPET = 500;
// Routine, high-frequency writes: only visible when debugging.
const QUIET_OPS = [/\/rest\/v1\/call_events$/];

export type Classified = { service: string; op: string };

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

function serviceFor(url: URL, env: Env): string | null {
  const host = url.hostname;
  if (host.endsWith(".supabase.co")) return "supabase";
  if (host === "api.openai.com") return "openai";
  if (host === "api.twilio.com" || host.endsWith(".twilio.com")) return "twilio";
  if (host.endsWith("zadarma.com")) return "zadarma";
  if (host === "api.stripe.com") return "stripe";
  if (host === "api.resend.com") return "resend";
  const qdrantHost = hostOf(env.QDRANT_URL);
  if (qdrantHost && url.host === qdrantHost) return "qdrant";
  const apiHost = hostOf(env.FRONTEND_API_URL ?? "http://localhost:3000");
  if (apiHost && url.host === apiHost) return "dashboard-api";
  return null;
}

/** Which external service a request goes to. Query strings are dropped: they can contain phone numbers. */
export function classifyUrl(rawUrl: string, method: string, env: Env = process.env): Classified | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const service = serviceFor(url, env);
  if (!service) return null;
  return { service, op: `${method.toUpperCase()} ${url.pathname}` };
}

function withCorrelationHeaders(init: FetchInit): RequestInit {
  const ctx = getLogContext();
  const headers = new Headers(init?.headers);
  if (ctx.call_id && !headers.has("x-call-id")) headers.set("x-call-id", ctx.call_id);
  if (ctx.project_id && !headers.has("x-project-id")) headers.set("x-project-id", ctx.project_id);
  if (ctx.request_id && !headers.has("x-request-id")) headers.set("x-request-id", ctx.request_id);
  return { ...init, headers };
}

function levelFor(c: Classified, status: number, durationMs: number): "debug" | "info" | "warn" | "error" {
  if (status >= 500) return "error";
  // PostgREST answers 404/406 for "row not found" in .single() lookups: expected, not a problem.
  const notFoundLike = c.service === "supabase" && (status === 404 || status === 406);
  if (status >= 400 && !notFoundLike) return "warn";
  if (durationMs > SLOW_MS) return "warn";
  if (QUIET_OPS.some((re) => re.test(c.op))) return "debug";
  return "info";
}

async function report(log: Log, c: Classified, res: Response, copy: Response | null, durationMs: number): Promise<void> {
  const level = levelFor(c, res.status, durationMs);
  const ext = { service: c.service, op: c.op, status: res.status, duration_ms: durationMs };
  let data: Record<string, unknown> | undefined;
  if (copy) {
    try { data = { body: (await copy.text()).slice(0, BODY_SNIPPET) }; } catch { /* body unreadable */ }
  }
  log[level]("external call", { event: "ext.call", ext, ...(data ? { data } : {}) });
}

/** Wrap global fetch once so every call to a known external service is logged. */
export function installFetchLogging(log: Log): void {
  const original = globalThis.fetch;
  if (!original || (original as unknown as Record<symbol, unknown>)[MARK]) return;

  const wrapped = async function loggedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    let classified: Classified | null = null;
    let nextInit = init;
    try {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
      const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as { method: string }).method : "GET");
      classified = classifyUrl(rawUrl, method);
      if (classified?.service === "dashboard-api" && (typeof input === "string" || input instanceof URL)) {
        nextInit = withCorrelationHeaders(init);
      }
    } catch {
      /* never let logging break a request */
    }
    if (!classified) return original(input, nextInit);

    const started = Date.now();
    try {
      const res = await original(input, nextInit);
      const copy = res.status >= 400 ? res.clone() : null; // clone before the caller consumes the body
      void report(log, classified, res, copy, Date.now() - started).catch(() => undefined);
      return res;
    } catch (e) {
      log.error("external call failed", {
        event: "ext.call",
        ext: { service: classified.service, op: classified.op, status: 0, duration_ms: Date.now() - started },
        err: e,
      });
      throw e;
    }
  };

  (wrapped as unknown as Record<symbol, unknown>)[MARK] = true;
  globalThis.fetch = wrapped as typeof fetch;
}
