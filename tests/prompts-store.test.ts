import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { definePrompt } from "../src/prompts/core";
import { getSnapshot, recordUsage, registerPrompts, resetPromptStoreForTests, scheduleRegistration } from "../src/prompts/store";

const def = definePrompt({
  key: "engine.test", app: "engine", title: "T", usedWhen: "U", phase: "during_call",
  placeholders: [{ name: "x", description: "d", required: true }],
  default: "default {{x}}",
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[];
let responses: Record<string, { ok: boolean; json: unknown }>;

beforeEach(() => {
  calls = [];
  responses = {};
  resetPromptStoreForTests();
  vi.useFakeTimers();
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "key";
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers: Record<string, string>; body?: string } = { headers: {} }) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
    const hit = Object.entries(responses).find(([part]) => url.includes(part));
    const r = hit?.[1] ?? { ok: true, json: [] };
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("registerPrompts", () => {
  it("upserts into the admin schema without touching the version pointers", async () => {
    await registerPrompts([def]);
    const call = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/ai_prompts"))!;
    expect(call.headers["Content-Profile"]).toBe("admin");
    expect(call.headers["Prefer"]).toContain("resolution=merge-duplicates");
    const row = JSON.parse(call.body!)[0];
    expect(row.key).toBe("engine.test");
    expect(row.code_default).toBe("default {{x}}");
    expect(row).not.toHaveProperty("active_version_id");
    expect(row).not.toHaveProperty("previous_version_id");
  });

  it("never throws when the database is unreachable", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network"); });
    await expect(registerPrompts([def])).resolves.toBeUndefined();
  });
});

describe("getSnapshot", () => {
  beforeEach(() => {
    responses["ai_prompts?"] = { ok: true, json: [{ key: "engine.test", active_version_id: "v1" }] };
    responses["ai_prompt_versions"] = { ok: true, json: [{ id: "v1", key: "engine.test", text: "override {{x}}" }] };
  });

  it("reads with the admin profile and serves an active override", async () => {
    const snap = await getSnapshot();
    expect(calls[0].headers["Accept-Profile"]).toBe("admin");
    expect(snap.text(def, { x: "1" })).toBe("override 1");
    expect(snap.usedVersionIds()).toEqual(["v1"]);
  });

  it("caches for 60 seconds", async () => {
    await getSnapshot();
    const n = calls.length;
    await getSnapshot();
    expect(calls.length).toBe(n);
    vi.advanceTimersByTime(61_000);
    await getSnapshot();
    expect(calls.length).toBeGreaterThan(n);
  });

  it("falls back to defaults when the database errors, and keeps the last good rows on a failed refresh", async () => {
    responses["ai_prompts?"] = { ok: false, json: { message: "boom" } };
    expect((await getSnapshot()).text(def, { x: "1" })).toBe("default 1");

    resetPromptStoreForTests();
    responses["ai_prompts?"] = { ok: true, json: [{ key: "engine.test", active_version_id: "v1" }] };
    await getSnapshot();
    vi.advanceTimersByTime(61_000);
    responses["ai_prompts?"] = { ok: false, json: { message: "boom" } };
    expect((await getSnapshot()).text(def, { x: "1" })).toBe("override 1");
  });
});

describe("recordUsage", () => {
  it("writes each version once per process", async () => {
    recordUsage(["v1", "v2"]);
    recordUsage(["v1"]);
    await vi.advanceTimersByTimeAsync(0);
    const writes = calls.filter((c) => c.url.includes("ai_prompt_version_usage"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body!).map((r: { version_id: string }) => r.version_id)).toEqual(["v1", "v2"]);
  });
});

describe("scheduleRegistration", () => {
  it("registers at once and again every interval, so last_seen_at never goes stale while the engine runs", async () => {
    const count = () => calls.filter((c) => c.method === "POST" && c.url.includes("/rest/v1/ai_prompts")).length;
    const stop = scheduleRegistration([def], 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(count()).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(count()).toBe(3);
  });
});
