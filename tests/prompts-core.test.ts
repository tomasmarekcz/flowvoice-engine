import { describe, it, expect, vi } from "vitest";
import {
  createSnapshot,
  definePrompt,
  emptySnapshot,
  extractPlaceholders,
  hashText,
  renderTemplate,
  validateOverride,
  type PromptDef,
  type PromptOverride,
} from "../src/prompts/core";

const def: PromptDef = definePrompt({
  key: "dashboard.test",
  app: "dashboard",
  title: "Test",
  usedWhen: "In tests",
  phase: "booking",
  placeholders: [
    { name: "name", description: "Customer name", required: true },
    { name: "note", description: "Optional note", required: false },
  ],
  default: "Hello {{name}}.{{note}}",
});

describe("renderTemplate", () => {
  it("inserts values literally, without $ patterns or re-scanning", () => {
    expect(renderTemplate("a {{x}} b", { x: "$& {{y}}" })).toBe("a $& {{y}} b");
  });
  it("replaces every occurrence and leaves unknown placeholders untouched", () => {
    expect(renderTemplate("{{x}}-{{x}}-{{z}}", { x: "1" })).toBe("1-1-{{z}}");
  });
});

describe("extractPlaceholders", () => {
  it("returns unique names", () => {
    expect(extractPlaceholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("hashText", () => {
  it("is stable and 16 hex chars", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});

describe("definePrompt", () => {
  const base = { key: "k", app: "engine" as const, title: "T", usedWhen: "U", phase: "during_call" as const, placeholders: [], default: "x" };
  it("throws on empty usedWhen", () => {
    expect(() => definePrompt({ ...base, usedWhen: " " })).toThrow(/usedWhen/);
  });
  it("throws on an undeclared placeholder in the default", () => {
    expect(() => definePrompt({ ...base, default: "{{oops}}" })).toThrow(/oops/);
  });
  it("throws when a required placeholder is missing from the default", () => {
    expect(() => definePrompt({ ...base, placeholders: [{ name: "a", description: "d", required: true }] })).toThrow(/a/);
  });
});

describe("validateOverride", () => {
  it("accepts text with all required placeholders", () => {
    expect(validateOverride(def, "Hi {{name}}")).toEqual({ ok: true });
  });
  it("rejects an undeclared placeholder", () => {
    const r = validateOverride(def, "Hi {{name}} {{z}}");
    expect(r.ok).toBe(false);
  });
  it("rejects a missing required placeholder", () => {
    const r = validateOverride(def, "Hi there");
    expect(r.ok).toBe(false);
  });
  it("rejects empty text", () => {
    expect(validateOverride(def, "   ").ok).toBe(false);
  });
});

describe("createSnapshot", () => {
  it("serves the default and renders placeholders when there is no override", () => {
    const snap = createSnapshot(new Map());
    expect(snap.text(def, { name: "Eva", note: "" })).toBe("Hello Eva.");
    expect(snap.usedVersionIds()).toEqual([]);
  });
  it("serves a valid override and records its version id", () => {
    const o = new Map<string, PromptOverride>([[def.key, { versionId: "v1", text: "Hi {{name}}!" }]]);
    const snap = createSnapshot(o);
    expect(snap.text(def, { name: "Eva" })).toBe("Hi Eva!");
    expect(snap.usedVersionIds()).toEqual(["v1"]);
  });
  it("falls back to the default and reports an invalid override", () => {
    const onInvalid = vi.fn();
    const o = new Map<string, PromptOverride>([[def.key, { versionId: "v2", text: "Hi {{zzz}}" }]]);
    const snap = createSnapshot(o, onInvalid);
    expect(snap.text(def, { name: "Eva", note: "" })).toBe("Hello Eva.");
    expect(onInvalid).toHaveBeenCalledWith(def.key, expect.any(String));
    expect(snap.usedVersionIds()).toEqual([]);
  });
  it("empties declared placeholders the caller did not pass", () => {
    expect(createSnapshot(new Map()).text(def, { name: "Eva" })).toBe("Hello Eva.");
  });
  it("emptySnapshot always serves defaults", () => {
    expect(emptySnapshot().text(def, { name: "A", note: "" })).toBe("Hello A.");
  });
});
