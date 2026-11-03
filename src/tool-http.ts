// LEA-159: every call a tool makes to the dashboard goes through callApi. It gives the call a time limit, checks the answer
// and turns every failure into the same small object, so the assistant never waits for ever or gets a nonsense result.

export type ToolErrorCode = "timeout" | "unavailable" | "bad_response" | "rejected" | "unknown_outcome";

/** What the model receives when a tool did not work. `error` keeps its old place, so "is there an error" checks still work. */
export interface ToolError {
  error: string;
  error_code: ToolErrorCode;
  /** True when asking again might help (the model is not told to retry on its own; the engine retries reads once). */
  retryable: boolean;
  [key: string]: unknown;
}

// Time limits per kind of call (ms). A write is never repeated: if it timed out we cannot know whether it was saved.
export const TOOL_TIMEOUT_MS = {
  read: 4000,
  knowledge: 5000,
  webSearch: 10000,
  write: 8000,
} as const;
/** Reads and knowledge searches are repeated once when they fail; web search and writes are not. */
export const TOOL_READ_RETRIES = 1;

export function toolError(code: ToolErrorCode, message: string, retryable: boolean, extra: Record<string, unknown> = {}): ToolError {
  return { ...extra, error: message, error_code: code, retryable };
}

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: ToolError };

export interface CallOptions {
  timeoutMs: number;
  /** Extra attempts after a failure that might be temporary (timeout, connection, 5xx). */
  retries?: number;
  /** A write: a failure after the request was sent means "outcome unknown", never "not done". */
  write?: boolean;
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

async function attempt(url: string, init: RequestInit | undefined, opts: CallOptions): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (e) {
    if (opts.write) return { ok: false, error: toolError("unknown_outcome", "The request did not finish, so it is not known whether it was saved.", false) };
    if (isTimeout(e)) return { ok: false, error: toolError("timeout", "The service did not answer in time.", true) };
    return { ok: false, error: toolError("unavailable", "The service could not be reached.", true) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (res.status >= 500) return { ok: false, error: toolError(opts.write ? "unknown_outcome" : "unavailable", "The service is not working right now.", !opts.write) };
    return { ok: false, error: toolError(opts.write && res.ok ? "unknown_outcome" : "bad_response", "The service gave an answer that cannot be read.", false) };
  }

  if (res.status >= 500) {
    return { ok: false, error: toolError(opts.write ? "unknown_outcome" : "unavailable", "The service is not working right now.", !opts.write) };
  }
  if (res.status >= 400) {
    const detail = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    return { ok: false, error: toolError("rejected", String(detail["error"] ?? `The request was refused (${res.status}).`), false, detail) };
  }
  return { ok: true, data: body };
}

export async function callApi(url: string, init: RequestInit | undefined, opts: CallOptions): Promise<ApiResult> {
  const retries = opts.write ? 0 : opts.retries ?? 0;
  let last: ApiResult = { ok: false, error: toolError("unavailable", "The service could not be reached.", true) };
  for (let i = 0; i <= retries; i++) {
    last = await attempt(url, init, opts);
    if (last.ok || !last.error.retryable) return last;
  }
  return last;
}

/** Runs `work` with a time limit; a rejected or late result becomes a ToolError (for the knowledge search, which is not HTTP). */
export async function callWithTimeout<T>(work: () => Promise<T>, timeoutMs: number, retries = 0): Promise<{ ok: true; data: T } | { ok: false; error: ToolError }> {
  let last: ToolError = toolError("unavailable", "The service could not be reached.", true);
  for (let i = 0; i <= retries; i++) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const data = await Promise.race([
        work(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs); }),
      ]);
      return { ok: true, data };
    } catch (e) {
      last = isTimeout(e) ? toolError("timeout", "The search did not answer in time.", true) : toolError("unavailable", "The search is not working right now.", true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, error: last };
}
