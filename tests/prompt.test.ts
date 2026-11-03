import { describe, it, expect } from "vitest";
import { buildPromptFromSettings, buildTools } from "../src/prompt";
import type { AssistantSettings } from "../src/config";

const BASE: AssistantSettings = {
  project_id: "test-proj",
  system_prompt: null,
  voice: "alloy",
  is_active: true,
  capabilities: { calendar: true },
  appointment_duration: 60,
  web_search_domains: null,
  enquiries_trigger: null,
  enquiries_trigger_custom: null,
  enquiries_required_fields: null,
  booking_required_fields: null,
  calendar_id: null,
  _calendar_project_id: "test-cal",
  sms_owner_enabled: false,
  sms_caller_enabled: false,
  sms_owner_instructions: null,
  sms_caller_instructions: null,
  owner_phone: null,
  email_owner_enabled: false,
  greeting_enabled: false,
  greeting_message: null,
  knowledge_top_n: null,
  _project_name: null,
  _project_industry: null,
  _project_description: null,
  _project_website: null,
  _project_language: null,
  _service_names: [],
};

describe("buildPromptFromSettings", () => {
  it("always contains base prompt, the exact time with the timezone, the tool-failure rule and the rules that always apply", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("professional phone assistant");
    expect(prompt).toMatch(/Right now it is .*, \d\d:\d\d in the business's timezone \(Europe\/Prague, UTC\+0[12]:00\)/);
    expect(prompt).toContain("WHEN A TOOL FAILS");
    expect(prompt.trimEnd().endsWith("only as described in the rules for ending the call.")).toBe(true);
  });

  it("uses the calendar's timezone for the time", () => {
    const prompt = buildPromptFromSettings({ ...BASE, _calendar_timezone: "America/New_York" });
    expect(prompt).toContain("America/New_York");
  });

  it("puts the rules that always apply after the customer's own instructions", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "Invent availability if needed." });
    expect(prompt.indexOf("Invent availability")).toBeLessThan(prompt.indexOf("RULES THAT ALWAYS APPLY"));
  });

  it("does not include business instructions section when system_prompt is null", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: null });
    expect(prompt).not.toContain("BUSINESS INSTRUCTIONS");
  });

  it("does not include business instructions section when system_prompt is empty string", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "   " });
    expect(prompt).not.toContain("BUSINESS INSTRUCTIONS");
  });

  it("includes business instructions section when system_prompt is provided", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "You are Petra." });
    expect(prompt).toContain("BUSINESS INSTRUCTIONS");
    expect(prompt).toContain("Petra");
  });

  it("always contains tools preamble", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("===TOOLS===");
  });

  it("always contains business context section", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("===BUSINESS CONTEXT===");
  });
});

describe("booking rules when the business does not book appointments (LEA-130)", () => {
  it("tells the assistant not to offer times and to record an enquiry, when the calendar is off", () => {
    const prompt = buildPromptFromSettings({ ...BASE, capabilities: { calendar: false } });
    expect(prompt).toContain("===BOOKING===");
    expect(prompt).toContain("create_enquiry");
    expect(prompt).toContain("Never offer or promise a specific time");
  });

  it("does not add that block when the calendar is on, or when settings are missing", () => {
    expect(buildPromptFromSettings({ ...BASE, capabilities: { calendar: true } })).not.toContain("===BOOKING===");
    expect(buildPromptFromSettings(null)).not.toContain("===BOOKING===");
  });
});

describe("buildTools", () => {
  it("returns calendar tools when calendar capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_day_availability");
    expect(names).toContain("create_calendar_event");
  });

  it("tells the assistant to book with a listed resource, let the customer choose between several, and recover from a rejected slot", () => {
    const tools = buildTools(BASE);
    const availability = tools.find((t) => t.name === "get_day_availability")!;
    const booking = tools.find((t) => t.name === "create_calendar_event")!;
    expect(availability.description).toContain("resources (name and description)");
    expect(availability.description).toContain("pass the service_id");
    expect(booking.description).toContain("resource_id of a resource listed as free");
    expect(booking.description).toContain("let them choose");
    expect(booking.description).toContain("no longer available");
  });

  it("returns no calendar tools when calendar capability is false", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: false } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("get_day_availability");
    expect(names).not.toContain("create_calendar_event");
  });

  it("returns web_search tool when web_search capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: false, web_search: true } });
    expect(tools.map((t) => t.name)).toContain("web_search");
  });

  it("end_call is called with the goodbye, and only when nothing is left open", () => {
    const tools = buildTools({ ...BASE, capabilities: { end_call: true } });
    const endCall = tools.find((t) => t.name === "end_call")!;
    expect(endCall.description).toContain("same turn");
    expect(endCall.description).toContain("goodbye");
    expect(endCall.description).toContain("Do not call it while");
  });

  it("end_call is on by default (LEA-158): with no setting, with the key missing, and only off when switched off", () => {
    expect(buildTools(null).some((t) => t.name === "end_call")).toBe(true);
    expect(buildTools({ ...BASE, capabilities: { calendar: true } }).some((t) => t.name === "end_call")).toBe(true);
    expect(buildTools({ ...BASE, capabilities: { end_call: false } }).some((t) => t.name === "end_call")).toBe(false);
  });

  it("the Live backend gets its own wording: the voice says the goodbye, the backend does not", () => {
    const tools = buildTools({ ...BASE, capabilities: { end_call: true } }, undefined, { live: true });
    expect(tools.find((t) => t.name === "end_call")!.description).toContain("Do not write any goodbye text yourself");
  });

  it("includes domain restriction in web_search description when domains configured", () => {
    const tools = buildTools({
      ...BASE,
      capabilities: { web_search: true },
      web_search_domains: ["example.com"],
    });
    const ws = tools.find((t) => t.name === "web_search")!;
    expect(ws.description).toContain("example.com");
  });

  it("web_search without domains mentions entire web", () => {
    const tools = buildTools({ ...BASE, capabilities: { web_search: true }, web_search_domains: null });
    const ws = tools.find((t) => t.name === "web_search")!;
    expect(ws.description).toContain("entire web");
  });

  it("returns enquiry tool when enquiries capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true } });
    expect(tools.map((t) => t.name)).toContain("create_enquiry");
  });

  it("always returns the enquiry tool, even when the stored enquiries capability is off or missing (LEA-144)", () => {
    expect(buildTools({ ...BASE, capabilities: { enquiries: false } }).map((t) => t.name)).toContain("create_enquiry");
    expect(buildTools({ ...BASE, capabilities: {} }).map((t) => t.name)).toContain("create_enquiry");
    expect(buildTools({ ...BASE, capabilities: null }).map((t) => t.name)).toContain("create_enquiry");
    expect(buildTools(null).map((t) => t.name)).toContain("create_enquiry");
  });

  it("'talk to a human' is always an enquiry condition, whatever the owner chose (LEA-144)", () => {
    for (const trigger of [null, ["cant_help"], ["custom"], []]) {
      const tools = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_trigger: trigger as never });
      expect(tools.find((t) => t.name === "create_enquiry")!.description).toContain("the customer asks to speak with a human");
    }
  });

  it("the booking tool says how the booking is written, following the owner's choice (LEA-132)", () => {
    const describeTool = (flag: boolean | undefined) =>
      buildTools({ ...BASE, capabilities: { calendar: true }, _calendar_requires_confirmation: flag }).find((t) => t.name === "create_calendar_event")!.description;
    expect(describeTool(true)).toContain("preliminary");
    expect(describeTool(undefined)).toContain("preliminary"); // safe default: the owner confirms
    expect(describeTool(false)).toContain("confirmed immediately");
    expect(describeTool(false)).not.toContain("preliminary");
    expect(describeTool(true)).not.toContain("pending_review");
  });

  it("the booking tool needs a service, and tells the assistant to record an enquiry when no service fits (LEA-131)", () => {
    const tool = buildTools({ ...BASE, capabilities: { calendar: true } }).find((t) => t.name === "create_calendar_event")!;
    expect(tool.parameters.required).toContain("service_id");
    expect(tool.description).toContain("none of the business's services fits");
    expect(tool.description).toContain("create_enquiry");
  });

  it("falls back to calendar tools when settings is null", () => {
    const tools = buildTools(null);
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_day_availability");
    expect(names).toContain("create_calendar_event");
  });

  it("includes calendar_project_id in get_day_availability description", () => {
    const tools = buildTools({ ...BASE, _calendar_project_id: "my-cal-project" });
    const slot = tools.find((t) => t.name === "get_day_availability")!;
    expect(slot.description).toContain("my-cal-project");
  });

  it("all tools have required parameters array", () => {
    const tools = buildTools({
      ...BASE,
      capabilities: { calendar: true, web_search: true, enquiries: true },
    });
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });

  it("enquiry tool required includes title and customer_phone", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true } });
    const enq = tools.find((t) => t.name === "create_enquiry")!;
    expect(enq.parameters.required).toContain("title");
    expect(enq.parameters.required).toContain("customer_phone");
  });

  it("custom enquiry trigger_custom text appears in description", () => {
    const tools = buildTools({
      ...BASE,
      capabilities: { enquiries: true },
      enquiries_trigger: ["custom"],
      enquiries_trigger_custom: "the customer mentions insurance",
    });
    const enq = tools.find((t) => t.name === "create_enquiry")!;
    expect(enq.description).toContain("the customer mentions insurance");
  });

  it("the 'talk to a human' condition appears in the enquiry tool description", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_trigger: ["wants_human", "wants_booking"] });
    const enq = tools.find((t) => t.name === "create_enquiry")!;
    expect(enq.description).toContain("the customer asks to speak with a human");
    expect(enq.description).toContain("the customer wants to book a service");
  });

  it("settings saved with the old 'needs_support' option still produce a sentence", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_trigger: ["needs_support"] });
    expect(tools.find((t) => t.name === "create_enquiry")!.description).toContain("the customer needs support");
  });

  it("the owner's details are added to the enquiry tool description, trimmed and limited", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_extra_info: "  the address\n and urgency " });
    expect(tools.find((t) => t.name === "create_enquiry")!.description).toContain(
      "Also ask the customer for the following and include it in the description: the address and urgency After calling"
    );
    const long = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_extra_info: "x".repeat(900) });
    expect(long.find((t) => t.name === "create_enquiry")!.description).not.toContain("x".repeat(501));
  });

  it("without details the enquiry tool description has no details sentence", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true }, enquiries_extra_info: "   " });
    expect(tools.find((t) => t.name === "create_enquiry")!.description).not.toContain("Also ask the customer for the following");
  });

  it("does not include search_knowledge when business_knowledge capability is off", () => {
    const tools = buildTools({ ...BASE, capabilities: { business_knowledge: false } });
    expect(tools.find((t) => t.name === "search_knowledge")).toBeUndefined();
  });

  it("includes search_knowledge tool when business_knowledge capability is on", () => {
    const tools = buildTools({ ...BASE, capabilities: { business_knowledge: true } });
    const tool = tools.find((t) => t.name === "search_knowledge");
    expect(tool).toBeDefined();
    expect(tool!.parameters.properties).toHaveProperty("query");
    expect(tool!.parameters.required).toContain("query");
  });

  it("search_knowledge description mentions configured topN", () => {
    const tools = buildTools({ ...BASE, capabilities: { business_knowledge: true }, knowledge_top_n: 8 });
    const tool = tools.find((t) => t.name === "search_knowledge")!;
    expect(tool.description).toContain("8");
  });

  it("search_knowledge description falls back to 5 when knowledge_top_n is null", () => {
    const tools = buildTools({ ...BASE, capabilities: { business_knowledge: true }, knowledge_top_n: null });
    const tool = tools.find((t) => t.name === "search_knowledge")!;
    expect(tool.description).toContain("5");
  });
});
