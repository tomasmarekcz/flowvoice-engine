import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callApi, callWithTimeout } from "../src/tool-http";

// LEA-159: time limits, answer checks and the shared error object for tool calls.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const hangs = () => new Promise<never>((_, reject) => { /* never answers; the signal ends it */ void reject; });

beforeEach(() => { mockFetch.mockReset(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("callApi", () => {
  it("returns the body of a good answer", async () => {
    mockFetch.mockResolvedValueOnce(ok({ days: [] }));
    expect(await callApi("http://x/a", undefined, { timeoutMs: 4000 })).toEqual({ ok: true, data: { days: [] } });
  });

  it("gives every call a time limit signal", async () => {
    mockFetch.mockResolvedValueOnce(ok({}));
    await callApi("http://x/a", undefined, { timeoutMs: 4000 });
    expect((mockFetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("a read that times out is tried once more, then reported as a timeout", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    mockFetch.mockRejectedValue(timeout);
    const r = await callApi("http://x/a", undefined, { timeoutMs: 4000, retries: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, error: { error_code: "timeout", retryable: true } });
  });

  it("a read that fails once and then works returns the good answer", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok({ services: [1] }));
    expect(await callApi("http://x/a", undefined, { timeoutMs: 4000, retries: 1 })).toEqual({ ok: true, data: { services: [1] } });
  });

  it("a server error (5xx) is 'unavailable' and tried again", async () => {
    mockFetch.mockResolvedValue(ok({ message: "boom" }, 503));
    const r = await callApi("http://x/a", undefined, { timeoutMs: 4000, retries: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, error: { error_code: "unavailable" } });
  });

  it("a refusal (4xx) is passed on with its own message and is not repeated", async () => {
    mockFetch.mockResolvedValue(ok({ error: "start_time_in_past", message: "That time has already passed." }, 400));
    const r = await callApi("http://x/a", undefined, { timeoutMs: 8000, retries: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: { error: "start_time_in_past", error_code: "rejected", retryable: false, message: "That time has already passed." } });
  });

  it("an answer that is not JSON is a bad response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("not json"); } });
    expect(await callApi("http://x/a", undefined, { timeoutMs: 4000 })).toMatchObject({ ok: false, error: { error_code: "bad_response" } });
  });

  it("a write that fails after it was sent is 'unknown outcome' and is never repeated", async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    const r = await callApi("http://x/a", { method: "POST" }, { timeoutMs: 8000, retries: 3, write: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: { error_code: "unknown_outcome", retryable: false } });
  });

  it("a write answered with a server error is also 'unknown outcome'", async () => {
    mockFetch.mockResolvedValue(ok({}, 500));
    expect(await callApi("http://x/a", { method: "POST" }, { timeoutMs: 8000, write: true })).toMatchObject({ ok: false, error: { error_code: "unknown_outcome" } });
  });
});

describe("callWithTimeout (knowledge search)", () => {
  it("returns the result of work that finishes in time", async () => {
    expect(await callWithTimeout(async () => 7, 5000)).toEqual({ ok: true, data: 7 });
  });

  it("reports work that takes too long, after one more try when asked", async () => {
    const work = vi.fn(hangs);
    const promise = callWithTimeout(work, 5000, 1);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toMatchObject({ ok: false, error: { error_code: "timeout" } });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("reports work that throws", async () => {
    expect(await callWithTimeout(async () => { throw new Error("qdrant down"); }, 5000)).toMatchObject({ ok: false, error: { error_code: "unavailable" } });
  });
});
