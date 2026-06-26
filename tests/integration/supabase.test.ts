import { describe, it, expect } from "vitest";
import { loadAssistantSettings } from "../../src/config";

const hasEnv = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasEnv)("loadAssistantSettings (real Supabase)", () => {
  it("returns null for null input", async () => {
    const result = await loadAssistantSettings(null);
    expect(result).toBeNull();
  });

  it("returns null for invalid UUID", async () => {
    const result = await loadAssistantSettings("not-a-uuid");
    expect(result).toBeNull();
  });

  it("returns null for non-existent project_id", async () => {
    const result = await loadAssistantSettings("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  // Uncomment and fill in a real project UUID once you have one in Supabase:
  // it("returns settings for known project_id", async () => {
  //   const result = await loadAssistantSettings("YOUR-REAL-UUID-HERE");
  //   expect(result).not.toBeNull();
  //   expect(result!.is_active).toBeDefined();
  //   expect(result!._calendar_project_id).toBeDefined();
  // });
});
