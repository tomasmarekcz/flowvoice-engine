import { describe, it, expect } from "vitest";
import { buildPromptFromSettings } from "../src/prompt";
import type { AssistantSettings } from "../src/config";

const settings = {
  project_id: "proj-1",
  system_prompt: "Be kind.",
  greeting_enabled: true,
  greeting_message: "Hello from Acme",
} as unknown as AssistantSettings;

describe("buildPromptFromSettings greeting option", () => {
  it("includes the greeting rule by default", () => {
    expect(buildPromptFromSettings(settings)).toContain("===CALL START===");
  });

  it("omits the greeting rule when includeGreeting is false", () => {
    const prompt = buildPromptFromSettings(settings, null, { includeGreeting: false });
    expect(prompt).not.toContain("===CALL START===");
    expect(prompt).toContain("Be kind.");
  });
});
