// LEA-63: reads prompt overrides from the admin schema of this environment's database (REST, service role).
// Reading never throws: any problem falls back to the code defaults.

import { getSupabaseHeaders, getSupabaseUrl } from "../config";
import { logger } from "../logger";
import { createSnapshot, hashText, type PromptDef, type PromptOverride, type PromptSnapshot } from "./core";

const APP = "engine";
const CACHE_TTL_MS = 60_000;

let cache: { at: number; overrides: Map<string, PromptOverride> } | null = null;
const usageWritten = new Set<string>();

export function resetPromptStoreForTests(): void {
  cache = null;
  usageWritten.clear();
}

function adminHeaders(extra: Record<string, string> = {}, write = false): Record<string, string> {
  const base = getSupabaseHeaders();
  delete base["Prefer"];
  return { ...base, [write ? "Content-Profile" : "Accept-Profile"]: "admin", ...extra };
}

/** Writes metadata and the code default of every prompt. Never touches versions or the active pointer. */
export async function registerPrompts(defs: PromptDef[]): Promise<void> {
  try {
    const now = new Date().toISOString();
    const rows = defs.map((d) => ({
      key: d.key,
      app: d.app,
      phase: d.phase,
      title: d.title,
      used_when: d.usedWhen,
      placeholders: d.placeholders,
      code_default: d.default,
      code_default_hash: hashText(d.default),
      last_seen_at: now,
    }));
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/ai_prompts?on_conflict=key`, {
      method: "POST",
      headers: adminHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }, true),
      body: JSON.stringify(rows),
    });
    if (!res.ok) logger.warn("prompt registry: register failed", { event: "prompts.register_failed", status: res.status });
  } catch (err) {
    logger.warn("prompt registry: register failed", { event: "prompts.register_failed", err });
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function loadOverrides(): Promise<Map<string, PromptOverride>> {
  const pointers = await getJson<Array<{ key: string; active_version_id: string }>>(
    `ai_prompts?select=key,active_version_id&app=eq.${APP}&active_version_id=not.is.null`
  );
  const overrides = new Map<string, PromptOverride>();
  if (pointers.length === 0) return overrides;
  const ids = pointers.map((p) => p.active_version_id).join(",");
  const versions = await getJson<Array<{ id: string; text: string }>>(`ai_prompt_versions?select=id,text&id=in.(${ids})`);
  const byId = new Map(versions.map((v) => [v.id, v.text]));
  for (const p of pointers) {
    const text = byId.get(p.active_version_id);
    if (text !== undefined) overrides.set(p.key, { versionId: p.active_version_id, text });
  }
  return overrides;
}

/** Snapshot of the active overrides (cached 60 s). Falls back to the last good rows, then to defaults. */
export async function getSnapshot(): Promise<PromptSnapshot> {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_TTL_MS) {
    try {
      cache = { at: now, overrides: await loadOverrides() };
    } catch (err) {
      logger.warn("prompt registry: load failed, using last good or defaults", { event: "prompts.load_failed", err });
      cache = { at: now, overrides: cache?.overrides ?? new Map() };
    }
  }
  return createSnapshot(cache.overrides, (key, reason) =>
    logger.warn("prompt registry: override ignored", { event: "prompts.override_invalid", prompt_key: key, reason })
  );
}

/** Remembers which versions were actually served (the Promote gate "tried on staging"). Once per version per process. */
export function recordUsage(versionIds: string[]): void {
  const fresh = versionIds.filter((id) => !usageWritten.has(id));
  if (fresh.length === 0) return;
  fresh.forEach((id) => usageWritten.add(id));
  const now = new Date().toISOString();
  void fetch(`${getSupabaseUrl()}/rest/v1/ai_prompt_version_usage?on_conflict=version_id`, {
    method: "POST",
    headers: adminHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }, true),
    body: JSON.stringify(fresh.map((id) => ({ version_id: id, last_used_at: now }))),
  }).catch((err) => logger.warn("prompt registry: usage write failed", { event: "prompts.usage_failed", err }));
}
