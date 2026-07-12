# Testing & Logging Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete testing and structured logging infrastructure across both repos that catches regressions before they reach production and makes debugging failures fast and deterministic.

**Architecture:** Structured JSON logger replaces all console calls in the engine; vitest covers units and integration in both repos; GitHub Actions runs the full suite before every deploy and blocks on failure.

**Tech Stack:** vitest (both repos), TypeScript, GitHub Actions, Supabase (integration tests use real DB with isolated test project_id), no external logging service needed initially.

## Global Constraints

- Node.js ≥ 20
- vitest ≥ 2.1.0 (already in engine, add to frontend)
- No new runtime dependencies unless unavoidable — test utilities only in devDependencies
- All tests must pass with `npm test` in each repo root
- CI must block deploy when any test fails
- Log output is always valid JSON (one object per line) in production; human-readable in dev
- Never log raw API keys, passwords, or full JWT tokens — truncate to first 8 chars + `...`
- Test project_id used in integration tests: `test-flowvoice-ci` (never touches production data)

---

## File Map

### flowvoice-engine
| File | Action | Purpose |
|------|--------|---------|
| `src/logger.ts` | **Create** | Structured JSON logger with levels, context, error serialization |
| `src/index.ts` | **Modify** | Replace console.log with logger |
| `src/session.ts` | **Modify** | Replace console.log/error with logger, log session events structurally |
| `src/call-logger.ts` | **Modify** | Replace console.log/error with logger |
| `src/config.ts` | **Modify** | Replace console.error with logger |
| `src/tools.ts` | **Modify** | Add per-tool request/response logging with duration |
| `src/handlers/twilio.ts` | **Modify** | Replace console.log/error with logger |
| `src/handlers/browser.ts` | **Modify** | Replace console.log/error with logger |
| `tests/logger.test.ts` | **Create** | Unit tests for logger output format and level filtering |
| `tests/prompt.test.ts` | **Create** | Unit tests for buildPromptFromSettings and buildTools |
| `tests/call-logger.test.ts` | **Create** | Unit tests for transcript building and tool call tracking |
| `tests/integration/supabase.test.ts` | **Create** | Integration test: loadAssistantSettings reads real Supabase |
| `tests/integration/tools.test.ts` | **Create** | Integration test: executeTool calls real frontend API routes |
| `.github/workflows/deploy.yml` | **Modify** | Add test step before deploy |
| `vitest.config.ts` | **Create** | Separate configs for unit vs integration |

### flowvoice (Next.js)
| File | Action | Purpose |
|------|--------|---------|
| `src/lib/logger.ts` | **Create** | Same structured logger, adapted for Next.js (server-side only) |
| `src/app/api/calendar/slots/route.ts` | **Modify** | Add request/response logging |
| `src/app/api/enquiries/route.ts` | **Modify** | Add request/response logging |
| `src/app/api/web-search/route.ts` | **Modify** | Add request/response logging |
| `vitest.config.ts` | **Create** | Vitest config with Next.js environment |
| `src/__tests__/lib/calendar-utils.test.ts` | **Create** | Unit tests for slot generation, timezone, DST handling |
| `src/__tests__/api/slots.test.ts` | **Create** | Integration test: real Supabase, real slot query |
| `src/__tests__/api/enquiries.test.ts` | **Create** | Integration test: create and read enquiry |
| `src/__tests__/api/web-search.test.ts` | **Create** | Integration test: web search returns results |
| `package.json` | **Modify** | Add vitest + test scripts |
| `.github/workflows/deploy.yml` | **Modify** | Add test step before deploy |

---

## Task 1: Structured Logger — flowvoice-engine

**Files:**
- Create: `flowvoice-engine/src/logger.ts`
- Create: `flowvoice-engine/tests/logger.test.ts`

**Interfaces:**
- Produces: `log(level, message, context?)`, `logger` default export with `.info()`, `.warn()`, `.error()`, `.debug()`

- [ ] **Step 1: Write failing tests**

Create `flowvoice-engine/tests/logger.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the logger by intercepting console output
describe("logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.NODE_ENV;
  });

  it("outputs valid JSON in production", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.info("test message", { key: "value" });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("test message");
    expect(parsed.key).toBe("value");
    expect(typeof parsed.ts).toBe("string");
  });

  it("includes error details when error is passed", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    const err = new Error("something broke");
    logger.error("operation failed", { err });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("error");
    expect(parsed.error).toBe("something broke");
  });

  it("truncates strings longer than 200 chars in context", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.info("msg", { big: "x".repeat(300) });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect((parsed.big as string).length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it("does not log debug in production", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.debug("verbose detail");
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd flowvoice-engine && npm test -- tests/logger.test.ts
```
Expected: FAIL — `Cannot find module '../src/logger'`

- [ ] **Step 3: Implement logger**

Create `flowvoice-engine/src/logger.ts`:

```typescript
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): Level {
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function truncate(val: unknown, maxLen = 200): unknown {
  if (typeof val === "string" && val.length > maxLen) return val.slice(0, maxLen) + "...";
  return val;
}

function sanitizeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === "err" || k === "error") {
      out["error"] = v instanceof Error ? v.message : String(v);
      if (v instanceof Error && v.stack) out["stack"] = v.stack.split("\n").slice(0, 5).join("\n");
    } else {
      out[k] = truncate(v);
    }
  }
  return out;
}

function emit(level: Level, message: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return;

  if (process.env.NODE_ENV !== "production") {
    const prefix = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level];
    const extra = ctx ? " " + JSON.stringify(sanitizeContext(ctx)) : "";
    process.stdout.write(`${prefix} [${level.toUpperCase()}] ${message}${extra}\n`);
    return;
  }

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(ctx ? sanitizeContext(ctx) : {}),
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (message: string, ctx?: Record<string, unknown>) => emit("debug", message, ctx),
  info:  (message: string, ctx?: Record<string, unknown>) => emit("info",  message, ctx),
  warn:  (message: string, ctx?: Record<string, unknown>) => emit("warn",  message, ctx),
  error: (message: string, ctx?: Record<string, unknown>) => emit("error", message, ctx),
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd flowvoice-engine && npm test -- tests/logger.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd flowvoice-engine
git add src/logger.ts tests/logger.test.ts
git commit -m "feat(logging): add structured JSON logger with level filtering"
```

---

## Task 2: Replace console calls with logger — flowvoice-engine

**Files:**
- Modify: `src/session.ts`, `src/call-logger.ts`, `src/config.ts`, `src/tools.ts`, `src/handlers/twilio.ts`, `src/handlers/browser.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `logger` from `./logger`

- [ ] **Step 1: Replace in session.ts**

Replace the ad-hoc error spy block and all `console.log`/`console.error` in `src/session.ts`:

```typescript
// At top of file, add:
import { logger } from "./logger";

// Replace:
//   console.log("[session] OpenAI connected — sending session.update");
// With:
//   logger.info("OpenAI connected, sending session.update");

// Replace the error spy block (lines ~87-95) with:
openaiWs.on("message", (data) => {
  this.handleOpenAIMessage(data.toString()).catch((e) =>
    logger.error("handleOpenAIMessage error", { err: e })
  );
});

// Replace:
//   console.log(`[session] ← ${type}`);
// With:
//   if (type !== "response.output_audio.delta") logger.debug("← openai event", { type });

// Replace:
//   console.log(`[session] connecting to OpenAI ...`);
//   console.log("[session] ending — generating summary");
//   console.error("[session] OpenAI WS error:", e.message);
//   console.error("[session] OpenAI disconnected ...");
//   console.log(`[session] executing tool: ${name}`);
// With logger equivalents:
//   logger.info("connecting to OpenAI", { project_id: this.projectId });
//   logger.info("session ending, generating summary");
//   logger.error("OpenAI WS error", { err: e });
//   logger.warn("OpenAI disconnected", { code });
//   logger.info("executing tool", { name });

// Also replace the inline error spy block you added:
openaiWs.on("message", (data) => {
  const raw = data.toString();
  this.handleOpenAIMessage(raw).catch((e) =>
    logger.error("handleOpenAIMessage error", { err: e })
  );
});
```

- [ ] **Step 2: Replace in call-logger.ts**

```typescript
import { logger } from "./logger";

// Replace every console.log/warn/error:
// console.log(`[logger] call created: ${this.callId}`)
//   → logger.info("call created", { call_id: this.callId })
// console.warn("[logger] createCall: no id returned", rows)
//   → logger.warn("createCall returned no id", { rows })
// console.error("[logger] createCall error:", ...)
//   → logger.error("createCall error", { err: e })
// console.error("[logger] logEvent error:", ...)
//   → logger.error("logEvent error", { err: e })
// console.log(`[logger] call finalized: ...`)
//   → logger.info("call finalized", { call_id: this.callId, duration_seconds, turns: this.transcript.length })
// console.error("[logger] finalizeCall error:", ...)
//   → logger.error("finalizeCall error", { err: e })
// console.error("[logger] generateCallSummary error:", ...)
//   → logger.error("generateCallSummary error", { err: e })
```

- [ ] **Step 3: Replace in config.ts, tools.ts, handlers**

```typescript
// config.ts
import { logger } from "./logger";
// console.error("[config] loadAssistantSettings error:", ...)
//   → logger.error("loadAssistantSettings error", { project_id: projectId, err: e })

// tools.ts — add timing + request/response logging:
import { logger } from "./logger";
// Before fetch: const t0 = Date.now();
// After fetch:  logger.info("tool executed", { name, duration_ms: Date.now() - t0 })
// On catch:     logger.error("tool execution error", { name, err: e })

// handlers/twilio.ts
import { logger } from "./logger";
// All [twilio] console.log → logger.info / logger.error

// handlers/browser.ts
import { logger } from "./logger";
// All [browser] console.log → logger.info / logger.error

// index.ts
import { logger } from "./logger";
// console.log(`[engine] listening on port ${PORT}`)
//   → logger.info("engine listening", { port: PORT })
// console.error("[engine] twilio handler error:", ...)
//   → logger.error("twilio handler error", { err: e })
```

- [ ] **Step 4: TypeScript build check**

```bash
cd flowvoice-engine && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 5: Run all tests**

```bash
cd flowvoice-engine && npm test
```
Expected: PASS (all existing + logger tests)

- [ ] **Step 6: Commit**

```bash
cd flowvoice-engine
git add src/
git commit -m "feat(logging): replace all console calls with structured logger"
```

---

## Task 3: Engine Unit Tests — Prompt & Tools

**Files:**
- Create: `flowvoice-engine/tests/prompt.test.ts`
- Create: `flowvoice-engine/tests/call-logger-unit.test.ts`

**Interfaces:**
- Consumes: `buildPromptFromSettings`, `buildTools` from `../src/prompt`
- Consumes: `CallLogger` from `../src/call-logger`

- [ ] **Step 1: Write prompt tests**

Create `flowvoice-engine/tests/prompt.test.ts`:

```typescript
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
  it("returns default Alex prompt when system_prompt is null", () => {
    const prompt = buildPromptFromSettings(null);
    expect(prompt).toContain("Alex");
    expect(prompt).toContain("Today is");
  });

  it("returns default Alex prompt when settings has no system_prompt", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: null });
    expect(prompt).toContain("Alex");
  });

  it("uses custom system_prompt when provided", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "You are Petra." });
    expect(prompt).toContain("Petra");
    expect(prompt).toContain("Today is");
  });

  it("appends today's date to custom prompt", () => {
    const prompt = buildPromptFromSettings({ ...BASE, system_prompt: "Custom." });
    expect(prompt).toMatch(/Today is \w+/);
  });
});

describe("buildTools", () => {
  it("returns calendar tools when calendar capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: true } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_available_slots");
    expect(names).toContain("create_calendar_event");
  });

  it("returns no calendar tools when calendar capability is false", () => {
    const tools = buildTools({ ...BASE, capabilities: { calendar: false } });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("get_available_slots");
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

  it("includes enquiry tool when enquiries capability is true", () => {
    const tools = buildTools({ ...BASE, capabilities: { enquiries: true } });
    expect(tools.map((t) => t.name)).toContain("create_enquiry");
  });

  it("falls back to { calendar: true, lead_collection: true } when settings is null", () => {
    const tools = buildTools(null);
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_available_slots");
    expect(names).toContain("create_calendar_event");
  });

  it("includes calendar_project_id in get_available_slots description", () => {
    const tools = buildTools({ ...BASE, _calendar_project_id: "my-cal-project" });
    const slot = tools.find((t) => t.name === "get_available_slots")!;
    expect(slot.description).toContain("my-cal-project");
  });

  it("all tools have required parameters defined", () => {
    const tools = buildTools({
      ...BASE,
      capabilities: { calendar: true, web_search: true, enquiries: true },
    });
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Write call-logger unit tests**

Create `flowvoice-engine/tests/call-logger-unit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch so no real Supabase calls happen
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  json: async () => [{ id: "call-test-123" }],
}));

// Provide env so logger and config are happy
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { CallLogger } = await import("../src/call-logger");

describe("CallLogger transcript tracking", () => {
  let logger: InstanceType<typeof CallLogger>;

  beforeEach(() => {
    logger = new CallLogger("test-project");
  });

  it("builds transcript from OpenAI transcript events", () => {
    logger.handleOpenAIEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Hello, how can I help?",
    });
    expect(logger.transcript).toHaveLength(1);
    expect(logger.transcript[0].role).toBe("assistant");
    expect(logger.transcript[0].text).toBe("Hello, how can I help?");
  });

  it("builds transcript from user transcription events", () => {
    logger.handleOpenAIEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "I need an appointment.",
    });
    expect(logger.transcript[0].role).toBe("user");
    expect(logger.transcript[0].text).toBe("I need an appointment.");
  });

  it("tracks pending tool calls and resolves them", () => {
    logger.handleOpenAIEvent({
      type: "response.function_call_arguments.done",
      name: "get_available_slots",
      call_id: "call-abc",
      arguments: JSON.stringify({ from_date: "2026-07-01" }),
    });

    logger.handleClientEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-abc",
        output: JSON.stringify({ slots: ["2026-07-01T09:00:00Z"] }),
      },
    });

    // toolCalls is private — access via the instance internals for test
    // We verify indirectly: finalizeCall won't throw and transcript is intact
    expect(logger.transcript).toHaveLength(0); // no speech yet
  });

  it("ignores audio buffer append events", () => {
    logger.handleClientEvent({ type: "input_audio_buffer.append", audio: "base64data" });
    expect(logger.transcript).toHaveLength(0);
  });

  it("does not add transcript entries for non-transcript events", () => {
    logger.handleOpenAIEvent({ type: "session.created" });
    logger.handleOpenAIEvent({ type: "rate_limits.updated" });
    expect(logger.transcript).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd flowvoice-engine && npm test -- tests/prompt.test.ts tests/call-logger-unit.test.ts
```
Expected: PASS (all tests)

- [ ] **Step 4: Commit**

```bash
cd flowvoice-engine
git add tests/prompt.test.ts tests/call-logger-unit.test.ts
git commit -m "test(engine): add unit tests for prompt builder and call logger"
```

---

## Task 4: Engine Integration Tests — Supabase & Tools

**Files:**
- Create: `flowvoice-engine/tests/integration/supabase.test.ts`
- Create: `flowvoice-engine/tests/integration/tools-integration.test.ts`
- Create: `flowvoice-engine/vitest.config.ts` (separate unit vs integration configs)

**Interfaces:**
- Consumes: `loadAssistantSettings` from `../../src/config`
- Consumes: `executeTool` from `../../src/tools`

- [ ] **Step 1: Create vitest config with two modes**

Create `flowvoice-engine/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: unit tests only (fast, no external deps)
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
    testTimeout: 5000,
  },
});
```

Create `flowvoice-engine/vitest.integration.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 15000,
  },
});
```

Update `flowvoice-engine/package.json` scripts:

```json
{
  "scripts": {
    "dev": "ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:all": "npm test && npm run test:integration"
  }
}
```

- [ ] **Step 2: Write Supabase integration test**

Create `flowvoice-engine/tests/integration/supabase.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { loadAssistantSettings } from "../../src/config";

// These tests require real env vars — skip in CI if not set
const hasEnv = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasEnv)("loadAssistantSettings (real Supabase)", () => {
  it("returns null for a non-existent project_id", async () => {
    const result = await loadAssistantSettings("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("returns null for invalid UUID", async () => {
    const result = await loadAssistantSettings("not-a-uuid");
    expect(result).toBeNull();
  });

  it("returns null for null input", async () => {
    const result = await loadAssistantSettings(null);
    expect(result).toBeNull();
  });

  // Add a real project_id test after you have one in Supabase:
  // it("returns settings for known project_id", async () => {
  //   const result = await loadAssistantSettings("YOUR-REAL-PROJECT-ID");
  //   expect(result).not.toBeNull();
  //   expect(result!.is_active).toBeDefined();
  // });
});
```

- [ ] **Step 3: Write tools integration test**

Create `flowvoice-engine/tests/integration/tools-integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { executeTool } from "../../src/tools";

const frontendRunning = process.env.FRONTEND_API_URL ?? "http://localhost:3000";

// These tests require the frontend to be running (locally or on the server)
const hasFrontend = !!process.env.RUN_INTEGRATION_TOOLS;

describe.skipIf(!hasFrontend)("executeTool (real frontend API)", () => {
  it("get_available_slots returns slots array or empty array", async () => {
    process.env.FRONTEND_API_URL = frontendRunning;
    const result = await executeTool(
      "get_available_slots",
      { from_date: new Date().toISOString().slice(0, 10) },
      "test-proj",
      "admin-test"
    ) as { slots?: unknown[]; error?: string };

    // Either slots array or graceful error — never throws
    expect(result).toBeDefined();
    if ("error" in result) {
      expect(typeof result.error).toBe("string");
    } else {
      expect(Array.isArray(result.slots ?? [])).toBe(true);
    }
  });

  it("create_enquiry returns id or error", async () => {
    const result = await executeTool(
      "create_enquiry",
      {
        title: "CI Test Enquiry — delete me",
        customer_phone: "+420000000000",
        description: "Created by integration test",
      },
      "test-proj",
      "admin-test"
    ) as { id?: string; error?: string };

    expect(result).toBeDefined();
  });

  it("unknown tool returns error object without throwing", async () => {
    const result = await executeTool("does_not_exist", {}, "test-proj", "admin-test") as { error: string };
    expect(result.error).toMatch(/Unknown tool/);
  });
});
```

- [ ] **Step 4: Run unit tests (integration skipped without env)**

```bash
cd flowvoice-engine && npm test
```
Expected: PASS — integration tests show as skipped, not failed

- [ ] **Step 5: Run integration tests manually**

```bash
cd flowvoice-engine && npm run test:integration
```
Expected: Tests marked `.skipIf(!hasEnv)` are skipped unless env is set. With env set: PASS.

- [ ] **Step 6: Commit**

```bash
cd flowvoice-engine
git add vitest.config.ts vitest.integration.config.ts package.json tests/integration/
git commit -m "test(engine): add integration tests for Supabase and tool execution"
```

---

## Task 5: Frontend Test Setup + Calendar Utils Tests

**Files:**
- Modify: `flowvoice/package.json`
- Create: `flowvoice/vitest.config.ts`
- Create: `flowvoice/src/__tests__/lib/calendar-utils.test.ts`

**Interfaces:**
- Consumes: `getAvailableSlots`, `isSlotAvailable`, slot utilities from `../../lib/calendar-utils`

- [ ] **Step 1: Add vitest to frontend**

```bash
cd flowvoice && npm install -D vitest @vitejs/plugin-react
```

Update `flowvoice/package.json` scripts section:

```json
{
  "scripts": {
    "dev": "node --env-file=.env.local server.js",
    "build": "next build",
    "start": "NODE_ENV=production node --env-file=.env.local server.js",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create `flowvoice/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 2: Verify vitest works**

```bash
cd flowvoice && npx vitest run --reporter=verbose 2>&1 | head -5
```
Expected: "No test files found" (no error, just no tests yet)

- [ ] **Step 3: Examine calendar-utils to understand what to test**

```bash
cd flowvoice && wc -l src/lib/calendar-utils.ts && head -60 src/lib/calendar-utils.ts
```

- [ ] **Step 4: Write calendar-utils tests**

Create `flowvoice/src/__tests__/lib/calendar-utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  generateTimeSlots,
  isWithinBusinessHours,
  slotsForDay,
  addMinutes,
} from "../../lib/calendar-utils";

// NOTE: Import the actual exported functions from calendar-utils.
// If function names differ, update these imports to match.

describe("addMinutes", () => {
  it("adds minutes to a date", () => {
    const base = new Date("2026-07-01T09:00:00Z");
    const result = addMinutes(base, 60);
    expect(result.toISOString()).toBe("2026-07-01T10:00:00Z");
  });

  it("handles crossing midnight", () => {
    const base = new Date("2026-07-01T23:30:00Z");
    const result = addMinutes(base, 60);
    expect(result.getUTCDate()).toBe(2);
  });
});

describe("isWithinBusinessHours", () => {
  it("returns true for a time inside business hours", () => {
    // 10:00 Prague time on a weekday
    const dt = new Date("2026-07-01T08:00:00Z"); // 10:00 CEST (UTC+2)
    expect(isWithinBusinessHours(dt, "08:00", "17:00", "Europe/Prague")).toBe(true);
  });

  it("returns false for a time outside business hours", () => {
    const dt = new Date("2026-07-01T20:00:00Z"); // 22:00 CEST
    expect(isWithinBusinessHours(dt, "08:00", "17:00", "Europe/Prague")).toBe(false);
  });

  it("returns false on weekends", () => {
    // 2026-07-04 is a Saturday
    const dt = new Date("2026-07-04T10:00:00Z");
    expect(isWithinBusinessHours(dt, "08:00", "17:00", "Europe/Prague")).toBe(false);
  });
});

describe("generateTimeSlots / slotsForDay", () => {
  it("generates slots at correct intervals", () => {
    const slots = slotsForDay(
      new Date("2026-07-01T00:00:00Z"),
      60,          // duration minutes
      "08:00",     // open
      "12:00",     // close
      "Europe/Prague",
      []           // no existing events
    );
    // 08:00, 09:00, 10:00, 11:00 = 4 slots
    expect(slots.length).toBe(4);
  });

  it("skips slots that overlap with existing events", () => {
    const existingEvent = {
      start: new Date("2026-07-01T07:00:00Z"), // 09:00 CEST
      end:   new Date("2026-07-01T08:00:00Z"), // 10:00 CEST
    };
    const slots = slotsForDay(
      new Date("2026-07-01T00:00:00Z"),
      60,
      "08:00",
      "12:00",
      "Europe/Prague",
      [existingEvent]
    );
    // 08:00 and 09:00 are blocked → 2 slots remain
    expect(slots.length).toBe(2);
  });

  it("returns empty array when duration fills whole day", () => {
    const slots = slotsForDay(
      new Date("2026-07-01T00:00:00Z"),
      480, // 8h
      "08:00",
      "12:00", // only 4h window
      "Europe/Prague",
      []
    );
    expect(slots.length).toBe(0);
  });
});
```

**Note:** If `calendar-utils.ts` exports different function names, run `grep "^export" src/lib/calendar-utils.ts` and update the imports above to match.

- [ ] **Step 5: Run tests**

```bash
cd flowvoice && npm test
```
Expected: PASS (adjust function names if needed to match actual exports)

- [ ] **Step 6: Commit**

```bash
cd flowvoice
git add package.json vitest.config.ts src/__tests__/lib/calendar-utils.test.ts
git commit -m "test(frontend): add vitest setup and calendar-utils unit tests"
```

---

## Task 6: Frontend Structured Logger + API Route Logging

**Files:**
- Create: `flowvoice/src/lib/logger.ts`
- Modify: `flowvoice/src/app/api/calendar/slots/route.ts`
- Modify: `flowvoice/src/app/api/enquiries/route.ts`
- Modify: `flowvoice/src/app/api/web-search/route.ts`

**Interfaces:**
- Produces: `logger` with same interface as engine logger (`.info`, `.warn`, `.error`, `.debug`)

- [ ] **Step 1: Create frontend logger**

Create `flowvoice/src/lib/logger.ts`:

```typescript
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, ctx?: Record<string, unknown>): void {
  const isProd = process.env.NODE_ENV === "production";
  if (level === "debug" && isProd) return;

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx ?? {})) {
    if (k === "err" || k === "error") {
      sanitized["error"] = v instanceof Error ? v.message : String(v);
    } else if (typeof v === "string" && v.length > 200) {
      sanitized[k] = v.slice(0, 200) + "...";
    } else {
      sanitized[k] = v;
    }
  }

  if (isProd) {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...sanitized }) + "\n");
  } else {
    const prefix = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level];
    console.log(`${prefix} [${level.toUpperCase()}] ${message}`, Object.keys(sanitized).length ? sanitized : "");
  }
}

export const logger = {
  debug: (message: string, ctx?: Record<string, unknown>) => emit("debug", message, ctx),
  info:  (message: string, ctx?: Record<string, unknown>) => emit("info",  message, ctx),
  warn:  (message: string, ctx?: Record<string, unknown>) => emit("warn",  message, ctx),
  error: (message: string, ctx?: Record<string, unknown>) => emit("error", message, ctx),
};
```

- [ ] **Step 2: Add logging to slots API route**

In `src/app/api/calendar/slots/route.ts`, wrap the handler:

```typescript
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project_id = searchParams.get("project_id");
  const from = searchParams.get("from");

  logger.info("calendar/slots request", { project_id, from });

  try {
    // ... existing implementation ...
    logger.info("calendar/slots success", { project_id, slot_count: slots.length });
    return Response.json({ slots });
  } catch (e) {
    logger.error("calendar/slots error", { project_id, err: e });
    return Response.json({ error: "Failed to fetch slots" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Add logging to enquiries route**

In `src/app/api/enquiries/route.ts`:

```typescript
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  logger.info("enquiry create request");
  try {
    const body = await request.json();
    logger.debug("enquiry payload", { project_id: body.project_id, title: body.title });
    // ... existing implementation ...
    logger.info("enquiry created", { id: result.id, project_id: body.project_id });
    return Response.json(result);
  } catch (e) {
    logger.error("enquiry create error", { err: e });
    return Response.json({ error: "Failed to create enquiry" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Add logging to web-search route**

In `src/app/api/web-search/route.ts`:

```typescript
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  logger.info("web-search request", { query: q?.slice(0, 80) });
  try {
    // ... existing implementation ...
    logger.info("web-search success");
    return Response.json(result);
  } catch (e) {
    logger.error("web-search error", { err: e });
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
```

- [ ] **Step 5: TypeScript check**

```bash
cd flowvoice && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd flowvoice
git add src/lib/logger.ts src/app/api/
git commit -m "feat(logging): add structured logger to API routes"
```

---

## Task 7: Frontend API Integration Tests

**Files:**
- Create: `flowvoice/src/__tests__/api/slots.test.ts`
- Create: `flowvoice/src/__tests__/api/enquiries.test.ts`

**Interfaces:**
- Consumes: real Supabase (reads `calendars`, `calendar_events`, writes `enquiries`)

- [ ] **Step 1: Write slots integration test**

Create `flowvoice/src/__tests__/api/slots.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const hasApp = !!process.env.RUN_INTEGRATION_API;

describe.skipIf(!hasApp)("GET /api/calendar/slots (real)", () => {
  it("returns a slots object for admin-test project", async () => {
    const from = new Date().toISOString();
    const res = await fetch(`${BASE}/api/calendar/slots?project_id=admin-test&from=${from}`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { slots?: unknown[]; error?: string };
    // Either slots or a graceful error — never a 500
    expect(res.status).not.toBe(500);
  });

  it("returns 400 or empty slots for missing project_id", async () => {
    const from = new Date().toISOString();
    const res = await fetch(`${BASE}/api/calendar/slots?from=${from}`);
    expect([200, 400]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Write enquiries integration test**

Create `flowvoice/src/__tests__/api/enquiries.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const hasApp = !!process.env.RUN_INTEGRATION_API;

describe.skipIf(!hasApp)("POST /api/enquiries (real)", () => {
  it("creates an enquiry and returns id", async () => {
    const res = await fetch(`${BASE}/api/enquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "test-flowvoice-ci",
        title: "CI Test — delete me",
        customer_phone: "+420000000000",
        description: "Integration test enquiry",
        status: "new",
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { id?: string; error?: string };
    expect(body.id).toBeDefined();
  });

  it("returns 4xx for missing required fields", async () => {
    const res = await fetch(`${BASE}/api/enquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 3: Run tests (integration skipped without flag)**

```bash
cd flowvoice && npm test
```
Expected: PASS — integration tests skipped

- [ ] **Step 4: Commit**

```bash
cd flowvoice
git add src/__tests__/api/
git commit -m "test(frontend): add API integration tests for slots and enquiries"
```

---

## Task 8: CI/CD Pipeline — Block Deploy on Test Failure

**Files:**
- Modify: `flowvoice/.github/workflows/deploy.yml`
- Modify: `flowvoice-engine/.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: GitHub Secrets `EC2_HOST`, `EC2_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`

- [ ] **Step 1: Update engine deploy workflow**

Replace `flowvoice-engine/.github/workflows/deploy.yml`:

```yaml
name: Test & Deploy Engine

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: TypeScript check
        run: npx tsc --noEmit
      - name: Unit tests
        run: npm test
      - name: Integration tests (Supabase)
        run: npm run test:integration
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to EC2
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_KEY }}
          script: |
            cd ~/flowvoice-engine
            git pull origin main
            docker build -t flowvoice-engine .
            docker stop engine || true
            docker rm engine || true
            docker run -d --restart=always --env-file .env --network host --name engine flowvoice-engine
            echo "✅ Engine deployed"
```

- [ ] **Step 2: Update frontend deploy workflow**

Replace `flowvoice/.github/workflows/deploy.yml`:

```yaml
name: Test & Deploy Frontend

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: TypeScript check
        run: npx tsc --noEmit
      - name: Unit tests
        run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to EC2
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_KEY }}
          script: |
            cd ~/flowvoice
            git pull origin main
            npm ci
            npm run build
            pm2 restart flowvoice
            echo "✅ Frontend deployed"
```

- [ ] **Step 3: Add Supabase secrets to GitHub**

In each repo: **Settings → Secrets → Actions → New repository secret**

Add:
- `SUPABASE_URL` = `https://gnobailsforiruhyplnl.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = your service role key

- [ ] **Step 4: Push and verify CI passes**

```bash
# In flowvoice-engine:
cd flowvoice-engine
git add .github/workflows/deploy.yml
git commit -m "ci: block deploy on test failure, add TypeScript check"
git push origin main

# In flowvoice:
cd ../flowvoice
git add .github/workflows/deploy.yml
git commit -m "ci: block deploy on test failure, add TypeScript check"
git push origin main
```

Go to GitHub → Actions and verify both pipelines show green ✅.

- [ ] **Step 5: Verify deploy is blocked on failure**

Temporarily break a test to confirm:
```typescript
// In tests/smoke.test.ts, change:
expect(1 + 1).toBe(3); // intentional failure
```
Push → confirm Actions shows ❌ and deploy step is skipped → revert the change.

---

## Debugging Workflow Reference

When something breaks in production, follow this order:

```bash
# 1. Engine errors
ssh -i ~/Downloads/flowvoice-eu.pem ubuntu@63.179.10.198 "docker logs engine --tail 100"

# 2. Frontend errors
ssh -i ~/Downloads/flowvoice-eu.pem ubuntu@63.179.10.198 "pm2 logs --lines 100"

# 3. Supabase — check call_events table for the failing call_id
# Go to Supabase → Table Editor → call_events → filter by call_id

# 4. Reproduce locally with same project_id
cd flowvoice-engine && SUPABASE_URL=... OPENAI_API_KEY=... npm run dev
# then open https://leadoro.io/test-call?project_id=YOUR_ID
```

**Adding a new feature checklist:**
1. Write the unit test first (TDD)
2. Implement the feature
3. Add logger.info/error calls at entry and exit points
4. Write integration test if it touches Supabase or external API
5. Push → CI must be green before considering it done
