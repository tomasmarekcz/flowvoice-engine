import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../src/logger", () => ({ logger: log }));
vi.mock("../src/knowledge", () => ({ searchKnowledge: vi.fn() }));

import { executeTool } from "../src/tools";

describe("executeTool logging", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { globalThis.fetch = realFetch; });

  it("logs a successful tool run with name, duration and whitelisted arguments only", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ services: [] }))) as unknown as typeof fetch;
    await executeTool("get_day_availability", { from_date: "2026-10-20", customer_name: "Jana Nováková" }, "p1", "p1", "c1");
    const call = log.info.mock.calls.find(([, ctx]) => ctx?.event === "tool.exec");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ tool: "get_day_availability", result_error: false, args: { from_date: "2026-10-20" } });
    expect(JSON.stringify(call![1])).not.toContain("Jana");
  });

  it("logs a tool whose HTTP call throws as an error event", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    await executeTool("get_services", {}, "p1", "p1");
    const call = log.error.mock.calls.find(([, ctx]) => ctx?.event === "tool.exec");
    expect(call![1]).toMatchObject({ tool: "get_services" });
  });

  it("flags tool results that contain an error", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "no slot" }))) as unknown as typeof fetch;
    await executeTool("get_services", {}, "p1", "p1");
    const call = log.info.mock.calls.find(([, ctx]) => ctx?.event === "tool.exec");
    expect(call![1].result_error).toBe(true);
  });
});
