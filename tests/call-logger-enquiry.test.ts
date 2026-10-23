import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.FRONTEND_API_URL = "https://fake-frontend.local";
process.env.ENGINE_INTERNAL_SECRET = "fake-secret";

const { generateCallSummary, maybeCreatePostCallEnquiry, prepareEnquiryCheck } = await import("../src/call-logger");
const { buildEnquiryRules } = await import("../src/enquiry-rules");

const RULES = buildEnquiryRules({
  enquiries_trigger: ["cant_help", "wants_human"], enquiries_trigger_custom: null,
  enquiries_required_fields: { email: false }, enquiries_extra_info: null,
} as never);

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

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, null);

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

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, RULES);

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

    const result = await generateCallSummary("fake-api-key", transcript, undefined, null, null);

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

  it("creates an enquiry via the frontend API when none exists yet", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "new-enquiry" }) });

    await maybeCreatePostCallEnquiry({
      shouldCreate: true,
      callId: "call-1",
      projectId: "project-1",
      callerPhone: "+420111222333",
      enquiryTitle: "Frustrated customer",
      enquiryDescription: "Needed a human, wasn't helped.",
      customerName: "Jana Nováková",
      customerEmail: "jana@example.com",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [postUrl, postInit] = mockFetch.mock.calls[0];
    expect(postUrl).toBe("https://fake-frontend.local/api/enquiries");
    const body = JSON.parse(postInit.body);
    expect(body).toMatchObject({
      project_id: "project-1",
      call_id: "call-1",
      title: "Frustrated customer",
      description: "Needed a human, wasn't helped.",
      customer_phone: "+420111222333",
      customer_name: "Jana Nováková",
      customer_email: "jana@example.com",
      status: "new",
    });
    expect(body).not.toHaveProperty("enquiry_type");
    expect(postInit.headers["X-Internal-Secret"]).toBe("fake-secret");
  });
});

describe("after-call check uses the same rules as the live tool", () => {
  beforeEach(() => mockFetch.mockReset());

  const okSummary = (extra: object) => ({
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: "T", summary: "S", ...extra }) } }] }),
  });

  it("puts the business's conditions into the summary prompt, not fixed criteria", async () => {
    mockFetch.mockResolvedValue(okSummary({}));
    await generateCallSummary("k", transcript, undefined, null, RULES);
    const prompt = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].content as string;
    expect(prompt).toContain("- you can't fully resolve the customer's request");
    expect(prompt).toContain("- the customer asks to speak with a human");
    expect(prompt).not.toContain("dissatisfied");
    expect(prompt).toContain("enquiry_customer_email");
  });

  it("returns the customer's name and email the model found", async () => {
    mockFetch.mockResolvedValue(okSummary({
      create_enquiry: true, enquiry_title: "X", enquiry_description: "Y",
      enquiry_customer_name: " Jana ", enquiry_customer_email: "",
    }));
    const r = await generateCallSummary("k", transcript, undefined, null, RULES);
    expect(r.enquiryCustomerName).toBe("Jana");
    expect(r.enquiryCustomerEmail).toBeNull();
  });

  it("the owner's details go into the check", async () => {
    mockFetch.mockResolvedValue(okSummary({}));
    const rules = buildEnquiryRules({ enquiries_trigger: ["cant_help"], enquiries_extra_info: "the address" } as never);
    await generateCallSummary("k", transcript, undefined, null, rules);
    const prompt = JSON.parse(mockFetch.mock.calls[0][1].body).messages[0].content as string;
    expect(prompt).toContain("the following from the customer: the address");
  });
});

describe("prepareEnquiryCheck (runs before the summary is generated)", () => {
  beforeEach(() => mockFetch.mockReset());
  const settings = { capabilities: { enquiries: true }, enquiries_trigger: ["cant_help"] } as never;

  it("returns no rules when the enquiries capability is off, without any request", async () => {
    expect(await prepareEnquiryCheck({ capabilities: { enquiries: false } } as never, "call-1", "p-1")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns no rules without a call id or project id", async () => {
    expect(await prepareEnquiryCheck(settings, null, "p-1")).toBeNull();
    expect(await prepareEnquiryCheck(settings, "call-1", null)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns no rules when the assistant already created an enquiry for this call", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => [{ id: "existing-enquiry" }] });
    expect(await prepareEnquiryCheck(settings, "call-1", "p-1")).toBeNull();
    expect(mockFetch.mock.calls[0][0]).toContain("call_id=eq.call-1");
  });

  it("returns the rules when no enquiry exists yet", async () => {
    mockFetch.mockResolvedValueOnce({ json: async () => [] });
    const rules = await prepareEnquiryCheck(settings, "call-1", "p-1");
    expect(rules?.conditions).toEqual(["you can't fully resolve the customer's request"]);
  });

  it("still runs the check when the lookup fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    expect(await prepareEnquiryCheck(settings, "call-1", "p-1")).not.toBeNull();
  });
});
