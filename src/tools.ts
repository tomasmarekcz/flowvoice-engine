import { logger } from "./logger";
import { searchKnowledge } from "./knowledge";
import { bookingInstruction } from "./booking-confirmation";
import type { PromptSnapshot } from "./prompts/core";
import { callApi, callWithTimeout, toolError, TOOL_READ_RETRIES, TOOL_TIMEOUT_MS, type ApiResult } from "./tool-http";

// Identifies this engine to the frontend's tenant-scoped API routes (which
// otherwise require a logged-in Supabase Auth session) — the engine has no
// user session of its own, just a project_id it already legitimately derived
// from the live Twilio call.
function internalHeaders(): Record<string, string> {
  return { "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "" };
}

// Only these arguments are written to the logs: free text such as names, phones and notes stays out.
const ARG_WHITELIST = ["from_date", "from_time", "duration_minutes", "service_id", "resource_id", "start_time", "end_time", "days", "slot_id"];

function loggableArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ARG_WHITELIST) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

const READ = { timeoutMs: TOOL_TIMEOUT_MS.read, retries: TOOL_READ_RETRIES } as const;
const WRITE = { timeoutMs: TOOL_TIMEOUT_MS.write, write: true } as const;

// A failed call becomes the shared error object (see tool-http.ts); a good one is passed on as it is.
function unwrap(r: ApiResult): unknown {
  return r.ok ? r.data : r.error;
}

function resultHasError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  calendarProjectId: string,
  dbCallId?: string,
  knowledgeTopN?: number,
  callerPhone?: string | null,
  snapshot?: PromptSnapshot,
): Promise<{ result: unknown; embeddingTokens: number }> {
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  const t0 = Date.now();

  try {
    let result: unknown;
    let embeddingTokens = 0;

    if (name === "get_services") {
      const params = new URLSearchParams({ project_id: projectId });
      result = unwrap(await callApi(`${base}/api/services?${params}`, { headers: internalHeaders() }, READ));
    } else if (name === "get_resources") {
      const params = new URLSearchParams({ project_id: projectId });
      if (args["service_id"]) params.set("service_id", String(args["service_id"]));
      result = unwrap(await callApi(`${base}/api/resources?${params}`, { headers: internalHeaders() }, READ));
    } else if (name === "get_day_availability") {
      // No date given: the dashboard picks today in the calendar's own timezone (LEA-157), not the UTC date.
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        days: String(args["days"] ?? 7),
      });
      if (args["from_date"]) params.set("from", String(args["from_date"]));
      if (args["service_id"]) params.set("service_id", String(args["service_id"]));
      result = unwrap(await callApi(`${base}/api/calendar/windows?${params}`, { headers: internalHeaders() }, READ));
    } else if (name === "web_search") {
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        q: String(args["query"] ?? ""),
      });
      result = unwrap(await callApi(`${base}/api/web-search?${params}`, undefined, { timeoutMs: TOOL_TIMEOUT_MS.webSearch }));
    } else if (name === "create_calendar_event") {
      let startTime = args["start_time"];
      let endTime = args["end_time"];

      // Fallback: if AI passed slot_id instead of start_time/end_time, decode it
      if (!startTime && args["slot_id"]) {
        try {
          const parts = Buffer.from(String(args["slot_id"]), "base64url").toString("utf8").split("|");
          if (parts.length >= 3) {
            startTime = parts[1];
            const durationMin = parseInt(parts[2], 10) || 60;
            endTime = new Date(new Date(startTime as string).getTime() + durationMin * 60_000).toISOString();
          }
        } catch { /* ignore malformed slot_id */ }
      }

      result = unwrap(await callApi(`${base}/api/calendar/events?project_id=${calendarProjectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...internalHeaders() },
        body: JSON.stringify({
          title: args["title"] ?? "Appointment",
          start_time: startTime,
          end_time: endTime,
          customer_name: args["customer_name"] ?? null,
          customer_phone: args["customer_phone"] || callerPhone || null,
          customer_email: args["customer_email"] ?? null,
          notes: args["notes"] ?? null,
          service_id: args["service_id"] ?? null,
          resource_id: args["resource_id"] ?? null,
          source_conversation_id: dbCallId ?? null,
          created_by: "ai",
          event_kind: "work",
        }),
      }, WRITE));
      // The assistant is told what to say about this booking (confirmed or waiting, text message or not), following the settings.
      const instruction = bookingInstruction(result, Boolean(args["customer_phone"] || callerPhone), snapshot);
      if (instruction && typeof result === "object" && result !== null) result = { ...result, say_to_caller: instruction };
    } else if (name === "create_enquiry") {
      result = unwrap(await callApi(`${base}/api/enquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...internalHeaders() },
        body: JSON.stringify({
          project_id: projectId,
          call_id: dbCallId ?? null,
          title: args["title"] ?? "Enquiry",
          description: args["description"] ?? null,
          customer_phone: args["customer_phone"] || callerPhone || "unknown",
          customer_name: args["customer_name"] ?? null,
          customer_email: args["customer_email"] ?? null,
          status: "new",
        }),
      }, WRITE));
    } else if (name === "search_knowledge") {
      const query = String(args["query"] ?? "");
      const topN = knowledgeTopN ?? 5;
      const found = await callWithTimeout(() => searchKnowledge(query, projectId, topN), TOOL_TIMEOUT_MS.knowledge, TOOL_READ_RETRIES);
      if (found.ok) {
        result = { chunks: found.data.chunks };
        embeddingTokens = found.data.embeddingTokens;
      } else {
        result = found.error;
      }
    } else {
      return { result: toolError("rejected", `Unknown tool: ${name}`, false), embeddingTokens: 0 };
    }

    logger.info("tool executed", {
      event: "tool.exec",
      tool: name,
      duration_ms: Date.now() - t0,
      result_error: resultHasError(result),
      error_code: resultHasError(result) ? (result as { error_code?: string }).error_code : undefined,
      args: loggableArgs(args),
    });
    return { result, embeddingTokens };
  } catch (e) {
    logger.error("tool execution error", { event: "tool.exec", tool: name, duration_ms: Date.now() - t0, args: loggableArgs(args), err: e });
    return { result: toolError("unavailable", String(e), false), embeddingTokens: 0 };
  }
}
