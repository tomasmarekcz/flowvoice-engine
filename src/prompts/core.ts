// LEA-63: prompt registry core — pure functions, no dependencies besides node:crypto.
// This file is copied verbatim into flowvoice-engine/src/prompts/core.ts (a parity test keeps them equal).

import { createHash } from "node:crypto";

export type PromptPhase = "during_call" | "after_call" | "booking" | "web_search";

export interface PlaceholderDef {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  key: string;
  app: "engine" | "dashboard";
  title: string;
  /** Plain-language "when is this used", shown on the card in the admin. */
  usedWhen: string;
  phase: PromptPhase;
  placeholders: PlaceholderDef[];
  default: string;
}

export interface PromptOverride {
  versionId: string;
  text: string;
}

export interface PromptSnapshot {
  text(def: PromptDef, vars?: Record<string, string>): string;
  /** Version ids of overrides that were actually served from this snapshot. */
  usedVersionIds(): string[];
}

const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function extractPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Replaces `{{name}}` with vars[name]. Values are inserted literally and never re-scanned. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
  );
}

export function validateOverride(def: Pick<PromptDef, "placeholders">, text: string): { ok: true } | { ok: false; reason: string } {
  if (text.trim() === "") return { ok: false, reason: "Text je prázdný." };
  const declared = new Set(def.placeholders.map((p) => p.name));
  const used = extractPlaceholders(text);
  const unknown = used.filter((n) => !declared.has(n));
  if (unknown.length > 0) return { ok: false, reason: `Neznámá značka: ${unknown.map((n) => `{{${n}}}`).join(", ")}` };
  const missing = def.placeholders.filter((p) => p.required && !used.includes(p.name));
  if (missing.length > 0) return { ok: false, reason: `Chybí povinná značka: ${missing.map((p) => `{{${p.name}}}`).join(", ")}` };
  return { ok: true };
}

/** Declares a prompt; fails loudly at startup/test time if the definition is incomplete. */
export function definePrompt(def: PromptDef): PromptDef {
  if (def.title.trim() === "") throw new Error(`Prompt ${def.key}: title is empty`);
  if (def.usedWhen.trim() === "") throw new Error(`Prompt ${def.key}: usedWhen is empty`);
  const declared = new Set(def.placeholders.map((p) => p.name));
  for (const n of extractPlaceholders(def.default)) {
    if (!declared.has(n)) throw new Error(`Prompt ${def.key}: default uses undeclared placeholder {{${n}}}`);
  }
  const used = extractPlaceholders(def.default);
  for (const p of def.placeholders) {
    if (p.required && !used.includes(p.name)) throw new Error(`Prompt ${def.key}: required placeholder {{${p.name}}} is missing from the default`);
  }
  return def;
}

export function createSnapshot(
  overrides: Map<string, PromptOverride>,
  onInvalid?: (key: string, reason: string) => void
): PromptSnapshot {
  const used = new Set<string>();
  return {
    text(def, vars = {}) {
      let template = def.default;
      const override = overrides.get(def.key);
      if (override) {
        const check = validateOverride(def, override.text);
        if (check.ok) {
          template = override.text;
          used.add(override.versionId);
        } else {
          onInvalid?.(def.key, check.reason);
        }
      }
      // Declared placeholders the caller did not pass become empty, never a stray {{name}} in a live prompt.
      const filled: Record<string, string> = {};
      for (const p of def.placeholders) filled[p.name] = "";
      return renderTemplate(template, { ...filled, ...vars });
    },
    usedVersionIds: () => [...used],
  };
}

export function emptySnapshot(): PromptSnapshot {
  return createSnapshot(new Map());
}
