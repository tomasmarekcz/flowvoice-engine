import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { computeOutputs, SETTINGS } from "./helpers-prompt-golden";
import { buildPromptFromSettings, buildTools } from "../src/prompt";
import { buildLiveGreetingInstruction, buildLiveVoicePrompt } from "../src/live-protocol";
import { generateCallSummary } from "../src/call-logger";
import { createSnapshot, type PromptOverride } from "../src/prompts/core";
import { ENGINE_PROMPTS, ENGINE_TOOLS } from "../src/prompts/registry";

const golden = JSON.parse(readFileSync(`${__dirname}/fixtures/prompts-golden.json`, "utf8")) as Record<string, unknown>;

describe("assembled prompts are byte-identical to the pre-registry code (no overrides)", () => {
  it("covers every golden entry", async () => {
    const now = await computeOutputs();
    expect(Object.keys(now)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) {
      expect(now[key], key).toEqual(golden[key]);
    }
  });
});

const snap = (entries: Array<[string, string]>) =>
  createSnapshot(new Map<string, PromptOverride>(entries.map(([key, text], i) => [key, { versionId: `v${i}`, text }])));

describe("overrides change exactly the targeted text", () => {
  const s = SETTINGS.full;

  it("base prompt", () => {
    const out = buildPromptFromSettings(s, null, {}, snap([[ENGINE_PROMPTS.callBase.key, "NEW BASE"]]));
    expect(out.startsWith("NEW BASE\n\n===BUSINESS CONTEXT===")).toBe(true);
    expect(out).toContain("===TOOLS===");
  });

  it("customer instructions wrapper keeps the customer's text literally", () => {
    const out = buildPromptFromSettings(
      { ...s!, system_prompt: "Price is $& {{x}}" } as never, null, {},
      snap([[ENGINE_PROMPTS.callBusinessInstructions.key, "RULES:\n{{instructions}}"]])
    );
    expect(out).toContain("RULES:\nPrice is $& {{x}}");
  });

  it("tool description with placeholders (domain note, email note, top n)", () => {
    const tools = buildTools(s, snap([
      [ENGINE_TOOLS.web_search.description.key, "Search. {{domain_note}}"],
      [ENGINE_TOOLS.search_knowledge.description.key, "Docs, top {{top_n}}."],
      [ENGINE_TOOLS.create_calendar_event.params.notes.key, "Free-form notes"],
    ]));
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.web_search.description).toBe("Search.  Restricted to: example.cz, https://zdravi.cz/.");
    expect(byName.search_knowledge.description).toBe("Docs, top 7.");
    expect(byName.create_calendar_event.parameters.properties.notes.description).toBe("Free-form notes");
  });

  it("live voice rules and greeting", () => {
    const tools = buildTools(s);
    const voice = buildLiveVoicePrompt(s, tools, snap([[ENGINE_PROMPTS.liveVoiceEndingRules.key, "BYE RULES"]]));
    expect(voice.endsWith("BYE RULES")).toBe(true);
    expect(buildLiveGreetingInstruction(s, snap([[ENGINE_PROMPTS.liveGreetingInstruction.key, "Say: {{greeting}}"]]))).toBe(
      "Say: Ordinace na Marjánce, dobrý den. Jak vám mohu pomoci?"
    );
  });

  it("an invalid override (undeclared placeholder) is ignored", () => {
    const out = buildPromptFromSettings(s, null, {}, snap([[ENGINE_PROMPTS.callBase.key, "bad {{nope}}"]]));
    expect(out).toBe(buildPromptFromSettings(s, null, {}));
  });
});

describe("post-call summary prompt through the snapshot", () => {
  async function systemPrompt(snapshot: ReturnType<typeof snap>): Promise<string> {
    let captured = "";
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body).messages[0].content as string;
      return { json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    });
    await generateCallSummary(
      "key", [{ role: "user", text: "Hello", timestamp_ms: 0 }],
      { smsOwnerEnabled: true, smsCallerEnabled: false, smsOwnerInstructions: null, smsCallerInstructions: null, emailOwnerEnabled: false },
      "cs", false, snapshot
    );
    vi.unstubAllGlobals();
    return captured;
  }

  it("uses an overridden SMS block, the default instructions override and the forced language wording", async () => {
    const out = await systemPrompt(snap([
      [ENGINE_PROMPTS.summaryOwnerSms.key, "* owner_sms: SHORT. {{instructions}}"],
      [ENGINE_PROMPTS.defaultOwnerSmsInstructions.key, "Say who called."],
      [ENGINE_PROMPTS.summaryLanguageForced.key, "Language: {{language}}."],
    ]));
    expect(out).toContain("Also generate:\n* owner_sms: SHORT. Say who called.");
    expect(out).toContain("Language: Czech.");
    expect(out).toContain("Return valid JSON only");
  });
});
