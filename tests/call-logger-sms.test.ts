import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";

const { generateCallSummary } = await import("../src/call-logger");

const transcript = [
  { role: "assistant" as const, text: "Hello, how can I help?", timestamp_ms: 1000 },
  { role: "user" as const, text: "I need a plumber tomorrow.", timestamp_ms: 2000 },
];

describe("generateCallSummary SMS extension", () => {
  it("returns ownerSms and callerSms when both SMS enabled", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Plumber request",
              summary: "Customer needs a plumber tomorrow.",
              owner_sms: "New call: customer needs plumber tomorrow. Action required.",
              caller_sms: "Thank you for calling! We will contact you shortly.",
            }),
          },
        }],
      }),
    });

    const result = await generateCallSummary("fake-api-key", transcript, {
      smsOwnerEnabled: true,
      smsCallerEnabled: true,
      smsOwnerInstructions: "Summarise for owner.",
      smsCallerInstructions: "Thank the caller.",
    });

    expect(result.title).toBe("Plumber request");
    expect(result.ownerSms).toBe("New call: customer needs plumber tomorrow. Action required.");
    expect(result.callerSms).toBe("Thank you for calling! We will contact you shortly.");
  });

  it("returns null for ownerSms and callerSms when SMS disabled", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: { content: JSON.stringify({ title: "Test", summary: "A call." }) },
        }],
      }),
    });

    const result = await generateCallSummary("fake-api-key", transcript, {
      smsOwnerEnabled: false,
      smsCallerEnabled: false,
      smsOwnerInstructions: null,
      smsCallerInstructions: null,
    });

    expect(result.ownerSms).toBeNull();
    expect(result.callerSms).toBeNull();
  });

  it("returns null fields when transcript is empty (no GPT call)", async () => {
    const result = await generateCallSummary("fake-api-key", []);
    expect(result.title).toBeNull();
    expect(result.ownerSms).toBeNull();
    expect(result.callerSms).toBeNull();
  });
});
