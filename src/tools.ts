import { logger } from "./logger";
import { searchKnowledge } from "./knowledge";

// Identifies this engine to the frontend's tenant-scoped API routes (which
// otherwise require a logged-in Supabase Auth session) — the engine has no
// user session of its own, just a project_id it already legitimately derived
// from the live Twilio call.
function internalHeaders(): Record<string, string> {
  return { "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "" };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  calendarProjectId: string,
  dbCallId?: string,
  knowledgeTopN?: number,
  callerPhone?: string | null,
): Promise<{ result: unknown; embeddingTokens: number }> {
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  const t0 = Date.now();

  try {
    let result: unknown;
    let embeddingTokens = 0;

    if (name === "get_available_slots") {
      const fromIso = args["from_date"]
        ? new Date(`${args["from_date"]}T00:00:00`).toISOString()
        : new Date().toISOString();
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        from: fromIso,
        ...(args["from_time"] ? { from_time: String(args["from_time"]) } : {}),
        ...(args["duration_minutes"] ? { duration: String(args["duration_minutes"]) } : {}),
      });
      const r = await fetch(`${base}/api/calendar/slots?${params}`);
      result = await r.json();
    } else if (name === "get_services") {
      const params = new URLSearchParams({ project_id: projectId });
      const r = await fetch(`${base}/api/services?${params}`, { headers: internalHeaders() });
      result = await r.json();
    } else if (name === "get_resources") {
      const params = new URLSearchParams({ project_id: projectId });
      if (args["service_id"]) params.set("service_id", String(args["service_id"]));
      const r = await fetch(`${base}/api/resources?${params}`, { headers: internalHeaders() });
      result = await r.json();
    } else if (name === "get_day_availability") {
      const fromDate = args["from_date"]
        ? String(args["from_date"])
        : new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        from: fromDate,
        days: String(args["days"] ?? 7),
      });
      if (args["service_id"]) params.set("service_id", String(args["service_id"]));
      const r = await fetch(`${base}/api/calendar/windows?${params}`, { headers: internalHeaders() });
      result = await r.json();
    } else if (name === "web_search") {
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        q: String(args["query"] ?? ""),
      });
      const r = await fetch(`${base}/api/web-search?${params}`);
      result = await r.json();
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

      const r = await fetch(`${base}/api/calendar/events?project_id=${calendarProjectId}`, {
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
          status: "pending_review",
          created_by: "ai",
          event_kind: "work",
        }),
      });
      result = await r.json();
    } else if (name === "create_enquiry") {
      const r = await fetch(`${base}/api/enquiries`, {
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
      });
      result = await r.json();
    } else if (name === "search_knowledge") {
      const query = String(args["query"] ?? "");
      const topN = knowledgeTopN ?? 5;
      const { chunks, embeddingTokens: et } = await searchKnowledge(query, projectId, topN);
      result = { chunks };
      embeddingTokens = et;
    } else {
      return { result: { error: `Unknown tool: ${name}` }, embeddingTokens: 0 };
    }

    logger.info("tool executed", { name, duration_ms: Date.now() - t0 });
    return { result, embeddingTokens };
  } catch (e) {
    logger.error("tool execution error", { name, duration_ms: Date.now() - t0, err: e });
    return { result: { error: String(e) }, embeddingTokens: 0 };
  }
}
