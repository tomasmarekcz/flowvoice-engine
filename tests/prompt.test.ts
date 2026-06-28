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
};

describe("buildPromptFromSettings", () => {
  it("returns default Alex prompt when settings is null", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("Alex");
    expect(prompt).toContain("Today is");
  });

  it("returns default Alex prompt when system_prompt is null", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: null });
    expect(prompt).toContain("Alex");
  });

  it("returns default Alex prompt when system_prompt is empty string", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "   " });
    expect(prompt).toContain("Alex");
  });

  it("uses custom system_prompt when provided", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "You are Petra." });
    expect(prompt).toContain("Petra");
    expect(prompt).not.toContain("Alex");
  });

  it("appends today's date to custom prompt", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "Custom instructions." });
    expect(prompt).toMatch(/Today is \w+/);
  });

  it("default prompt contains calendar instructions", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("get_day_availability");
    expect(prompt).toContain("create_calendar_event");
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
});
