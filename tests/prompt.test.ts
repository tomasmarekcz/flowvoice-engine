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
  it("always contains base prompt and today's date", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("professional phone assistant");
    expect(prompt).toContain("Today is");
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

describe("buildTools", () => {
  it("returns calendar tools when calendar capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_day_availability");
    expect(names).toContain("create_calendar_event");
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
