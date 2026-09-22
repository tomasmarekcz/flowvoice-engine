import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.FRONTEND_API_URL = "https://fake-frontend.local";
process.env.ENGINE_INTERNAL_SECRET = "fake-secret";

const { generateCallSummary, maybeCreatePostCallEnquiry } = await import("../src/call-logger");

const transcript = [
  { role: "assistant" as const, text: "Hello, how can I help?", timestamp_ms: 1000 },
  { role: "user" as const, text: "I'm really unhappy, nobody called me back.", timestamp_ms: 2000 },
];

describe("generateCallSummary enquiry extension", () => {
  beforeEach(() => mockFetch.mockReset());

  it("does not include enquiry fields in the prompt/response when disabled", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ title: "Test", summary: "A call." }) } }],
      }),
    });

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, false);

    expect(result.shouldCreateEnquiry).toBe(false);
    expect(result.enquiryTitle).toBeNull();
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).not.toContain("create_enquiry");
  });

  it("parses create_enquiry:true from GPT when enabled", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Unhappy customer",
              summary: "Customer was frustrated, no callback received.",
              create_enquiry: true,
              enquiry_title: "Frustrated customer needs follow-up",
              enquiry_description: "Customer said nobody called them back and was upset.",
            }),
          },
        }],
      }),
    });

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, true);

    expect(result.shouldCreateEnquiry).toBe(true);
    expect(result.enquiryTitle).toBe("Frustrated customer needs follow-up");
    expect(result.enquiryDescription).toContain("called them back");
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toContain("create_enquiry");
  });

  it("ignores create_enquiry:true from GPT when the capability is disabled", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: { content: JSON.stringify({ title: "Test", summary: "A call.", create_enquiry: true }) },
        }],
      }),
    });

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, false);

    expect(result.shouldCreateEnquiry).toBe(false);
  });
});

describe("maybeCreatePostCallEnquiry", () => {
  beforeEach(() => mockFetch.mockReset());

  it("does nothing when shouldCreate is false", async () => {
    await maybeCreatePostCallEnquiry({
      shouldCreate: false,
      callId: "call-1",
      projectId: "project-1",
      callerPhone: "+420111222333",
      enquiryTitle: "Test",
      enquiryDescription: "Test",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing when callId or projectId is missing", async () => {
    await maybeCreatePostCallEnquiry({
      shouldCreate: true,
      callId: null,
      projectId: "project-1",
      callerPhone: "+420111222333",
      enquiryTitle: "Test",
      enquiryDescription: "Test",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips creating an enquiry when one already exists for this call", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => [{ id: "existing-enquiry" }],
    });

    await maybeCreatePostCallEnquiry({
      shouldCreate: true,
      callId: "call-1",
      projectId: "project-1",
      callerPhone: "+420111222333",
      enquiryTitle: "Test",
      enquiryDescription: "Test",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [dedupUrl] = mockFetch.mock.calls[0];
    expect(dedupUrl).toContain("call_id=eq.call-1");
  });

  it("creates an enquiry via the frontend API when none exists yet", async () => {
    mockFetch
      .mockResolvedValueOnce({ json: async () => [] }) // dedup check: none found
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "new-enquiry" }) }); // POST

    await maybeCreatePostCallEnquiry({
      shouldCreate: true,
      callId: "call-1",
      projectId: "project-1",
      callerPhone: "+420111222333",
      enquiryTitle: "Frustrated customer",
      enquiryDescription: "Needed a human, wasn't helped.",
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = mockFetch.mock.calls[1];
    expect(postUrl).toBe("https://fake-frontend.local/api/enquiries");
    const body = JSON.parse(postInit.body);
    expect(body).toMatchObject({
      project_id: "project-1",
      call_id: "call-1",
      title: "Frustrated customer",
      description: "Needed a human, wasn't helped.",
      customer_phone: "+420111222333",
      enquiry_type: "support",
      status: "new",
    });
    expect(postInit.headers["X-Internal-Secret"]).toBe("fake-secret");
  });
});
