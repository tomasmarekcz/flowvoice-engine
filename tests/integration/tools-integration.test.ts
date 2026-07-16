import { describe, it, expect } from "vitest";
import { executeTool } from "../../src/tools";

// Set RUN_INTEGRATION_TOOLS=1 and FRONTEND_API_URL=http://localhost:3000 to run these
const hasFrontend = !!process.env.RUN_INTEGRATION_TOOLS;

describe.skipIf(!hasFrontend)("executeTool (real frontend API)", () => {
  it("get_available_slots returns object without throwing", async () => {
    const { result } = await executeTool(
      "get_available_slots",
      { from_date: new Date().toISOString().slice(0, 10) },
      "test-proj",
      "admin-test"
    );
    const r = result as Record<string, unknown>;
    expect(r).toBeDefined();
    if ("error" in r) {
      expect(typeof r.error).toBe("string");
    } else {
      expect(Array.isArray(r.slots ?? [])).toBe(true);
    }
  });

  it("create_enquiry returns id or graceful error", async () => {
    const { result } = await executeTool(
      "create_enquiry",
      {
        title: "CI Integration Test — delete me",
        customer_phone: "+420000000000",
        description: "Created by integration test",
      },
      "test-proj",
      "admin-test"
    );
    expect(result).toBeDefined();
  });

  it("unknown tool returns error object without throwing", async () => {
    const { result } = await executeTool("does_not_exist", {}, "test-proj", "admin-test");
    expect((result as { error: string }).error).toMatch(/Unknown tool/);
  });
});

// This test always runs — it verifies unknown-tool handling works without external deps
describe("executeTool unknown tool (always runs)", () => {
  it("returns error for unknown tool name", async () => {
    const { result } = await executeTool("totally_fake_tool", {}, "proj", "cal");
    expect((result as { error: string }).error).toContain("Unknown tool");
  });
});
