import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { loadAssistantSettings, type AssistantSettings } from "../config";
import { buildLiveSessionStart } from "../live-protocol";
import { buildPromptFromSettings, type OpenAITool } from "../prompt";
import type { PromptSnapshot } from "../prompts/core";
import { getSnapshot } from "../prompts/store";

export const CUSTOMER_INSTRUCTIONS_MARKER = "⟦ INSTRUKCE ZÁKAZNÍKA ⟧";
export const CUSTOMER_GREETING_MARKER = "⟦ POZDRAV ZÁKAZNÍKA ⟧";
const EXAMPLE_PHONE = "+420 777 123 456";

export interface PromptPreview {
  standard: string;
  live_voice: string;
  live_backend: string;
  tools: OpenAITool[];
}

/** The prompts a call of this project would get right now. With mask, the customer's own texts are replaced by markers. */
export function buildPromptPreview(settings: AssistantSettings, snapshot: PromptSnapshot, mask: boolean): PromptPreview {
  const shown: AssistantSettings = mask
    ? { ...settings, system_prompt: CUSTOMER_INSTRUCTIONS_MARKER, greeting_enabled: true, greeting_message: CUSTOMER_GREETING_MARKER }
    : settings;
  const live = buildLiveSessionStart(shown, EXAMPLE_PHONE, snapshot);
  const session = live.message["session"] as { instructions: string; delegation: { responses: { instructions: string } } };
  return {
    standard: buildPromptFromSettings(shown, EXAMPLE_PHONE, {}, snapshot),
    live_voice: session.instructions,
    live_backend: session.delegation.responses.instructions,
    tools: live.tools,
  };
}

function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /internal/prompt-preview { project_id, mask_customer? }: for the admin tab AI Settings. Same protection as /internal/active-calls. */
export async function handlePromptPreview(req: Request, res: Response): Promise<void> {
  if (!secretMatches(req.get("x-internal-secret"), process.env.ENGINE_INTERNAL_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const projectId = typeof req.body?.project_id === "string" ? req.body.project_id : null;
  if (!projectId) {
    res.status(400).json({ error: "project_id required" });
    return;
  }
  const settings = await loadAssistantSettings(projectId);
  if (!settings) {
    res.status(404).json({ error: "Project has no assistant settings" });
    return;
  }
  const mask = req.body?.mask_customer !== false;
  res.json(buildPromptPreview(settings, await getSnapshot(), mask));
}
