import { describe, it, expect, vi } from "vitest";

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { loadAssistantSettings } = await import("../src/config");

describe("loadAssistantSettings SMS + owner_phone", () => {
  it("returns sms fields and owner_phone from parallel fetch", async () => {
    const fakeSettings = {
      project_id: "20c026ed-4315-47bf-83e5-fc229cdc978e",
      sms_owner_enabled: true,
      sms_caller_enabled: false,
      sms_owner_instructions: "Summarise the call for the owner.",
      sms_caller_instructions: null,
      calendar_id: null,
      _calendar_project_id: "admin-test",
    };

    mockFetch
      .mockResolvedValueOnce({ json: async () => [fakeSettings] })
      .mockResolvedValueOnce({ json: async () => [{ owner_phone: "+420777000111" }] });

    const result = await loadAssistantSettings("20c026ed-4315-47bf-83e5-fc229cdc978e");

    expect(result?.sms_owner_enabled).toBe(true);
    expect(result?.sms_caller_enabled).toBe(false);
    expect(result?.sms_owner_instructions).toBe("Summarise the call for the owner.");
    expect(result?.owner_phone).toBe("+420777000111");
  });

  it("sets owner_phone to null when project has no phone", async () => {
    const fakeSettings = {
      project_id: "20c026ed-4315-47bf-83e5-fc229cdc978e",
      sms_owner_enabled: false,
      sms_caller_enabled: false,
      sms_owner_instructions: null,
      sms_caller_instructions: null,
      calendar_id: null,
    };

    mockFetch
      .mockResolvedValueOnce({ json: async () => [fakeSettings] })
      .mockResolvedValueOnce({ json: async () => [{ owner_phone: null }] });

    const result = await loadAssistantSettings("20c026ed-4315-47bf-83e5-fc229cdc978e");
    expect(result?.owner_phone).toBeNull();
  });
});
