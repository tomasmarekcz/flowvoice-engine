import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { AssistantSettings } from "../src/config";

const h = vi.hoisted(() => ({ settings: null as unknown }));
vi.mock("../src/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config")>()),
  loadAssistantSettings: async () => h.settings,
}));
vi.mock("../src/prompts/store", () => ({
  getSnapshot: async () => (await import("../src/prompts/core")).emptySnapshot(),
}));

const { buildPromptPreview, CUSTOMER_INSTRUCTIONS_MARKER, CUSTOMER_GREETING_MARKER, handlePromptPreview } = await import("../src/handlers/prompt-preview");
const { emptySnapshot } = await import("../src/prompts/core");

const settings = {
  project_id: "p", system_prompt: "SECRET customer rules", greeting_enabled: true, greeting_message: "SECRET hello",
  capabilities: { calendar: true, end_call: true }, _calendar_project_id: "cal", voice_engine: "live",
  _project_name: "Acme",
} as unknown as AssistantSettings;

describe("buildPromptPreview", () => {
  it("returns the standard prompt, the live voice and backend prompts and the tools", () => {
    const p = buildPromptPreview(settings, emptySnapshot(), false);
    expect(p.standard).toContain("SECRET customer rules");
    expect(p.live_voice).toContain("===ENDING THE CALL===");
    expect(p.live_backend).toContain("SECRET customer rules");
    expect(p.tools.map((t) => t.name)).toContain("end_call");
  });

  it("masks the customer's own texts and shows where they go", () => {
    const p = buildPromptPreview(settings, emptySnapshot(), true);
    const all = JSON.stringify(p);
    expect(all).not.toContain("SECRET");
    expect(p.standard).toContain(CUSTOMER_INSTRUCTIONS_MARKER);
    expect(p.standard).toContain(CUSTOMER_GREETING_MARKER);
  });
});

describe("POST /internal/prompt-preview", () => {
  const app = () => { const a = express(); a.use(express.json()); a.post("/internal/prompt-preview", handlePromptPreview); return a; };
  beforeEach(() => { process.env.ENGINE_INTERNAL_SECRET = "s3cret"; h.settings = settings; });

  it("needs the internal secret", async () => {
    expect((await request(app()).post("/internal/prompt-preview").send({ project_id: "x" })).status).toBe(401);
    expect((await request(app()).post("/internal/prompt-preview").set("X-Internal-Secret", "no").send({})).status).toBe(401);
  });

  it("answers 400 without a project id and 404 for an unknown project", async () => {
    const r1 = await request(app()).post("/internal/prompt-preview").set("X-Internal-Secret", "s3cret").send({});
    expect(r1.status).toBe(400);
    h.settings = null;
    const r2 = await request(app()).post("/internal/prompt-preview").set("X-Internal-Secret", "s3cret").send({ project_id: "11111111-1111-1111-1111-111111111111" });
    expect(r2.status).toBe(404);
  });

  it("returns the masked preview by default", async () => {
    const res = await request(app()).post("/internal/prompt-preview").set("X-Internal-Secret", "s3cret").send({ project_id: "11111111-1111-1111-1111-111111111111" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
    expect(res.body.standard).toContain(CUSTOMER_INSTRUCTIONS_MARKER);
  });
});
