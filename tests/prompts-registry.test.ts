import { describe, it, expect } from "vitest";
import { ALL_ENGINE_PROMPTS, ENGINE_TOOLS } from "../src/prompts/registry";
import { definePrompt } from "../src/prompts/core";
import { buildTools } from "../src/prompt";
import type { AssistantSettings } from "../src/config";

describe("engine prompt registry", () => {
  it("has unique keys, valid definitions and the engine prefix", () => {
    const keys = ALL_ENGINE_PROMPTS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of ALL_ENGINE_PROMPTS) {
      expect(() => definePrompt(p)).not.toThrow();
      expect(p.app).toBe("engine");
      expect(p.key.startsWith("engine.")).toBe(true);
    }
  });

  it("registers a description for every tool and every parameter that buildTools can produce", () => {
    const settings = {
      capabilities: { web_search: true, enquiries: true, calendar: true, business_knowledge: true, end_call: true },
      booking_required_fields: { email: true },
      enquiries_required_fields: { email: true },
    } as unknown as AssistantSettings;
    const tools = buildTools(settings);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["create_calendar_event", "create_enquiry", "end_call", "get_day_availability", "get_resources", "get_services", "search_knowledge", "web_search"]
    );
    for (const tool of tools) {
      const reg = ENGINE_TOOLS[tool.name as keyof typeof ENGINE_TOOLS];
      expect(reg, `tool ${tool.name} is not in ENGINE_TOOLS`).toBeDefined();
      for (const param of Object.keys(tool.parameters.properties)) {
        expect(reg.params[param], `${tool.name}.${param} has no registered description`).toBeDefined();
      }
    }
  });
});
