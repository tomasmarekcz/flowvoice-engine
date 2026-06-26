import { logger } from "./logger";

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  calendarProjectId: string,
): Promise<unknown> {
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  const t0 = Date.now();

  try {
    let result: unknown;

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
    } else if (name === "web_search") {
      const params = new URLSearchParams({
        project_id: calendarProjectId,
        q: String(args["query"] ?? ""),
      });
      const r = await fetch(`${base}/api/web-search?${params}`);
      result = await r.json();
    } else if (name === "create_calendar_event") {
      const r = await fetch(`${base}/api/calendar/events?project_id=${calendarProjectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: args["title"],
          start_time: args["start_time"],
          end_time: args["end_time"],
          customer_name: args["customer_name"] ?? null,
          customer_phone: args["customer_phone"] ?? null,
          notes: args["notes"] ?? null,
          status: "pending_review",
          created_by: "ai",
          event_kind: "work",
        }),
      });
      result = await r.json();
    } else if (name === "create_enquiry") {
      const r = await fetch(`${base}/api/enquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          title: args["title"] ?? "Enquiry",
          description: args["description"] ?? null,
          customer_phone: args["customer_phone"] ?? "unknown",
          customer_name: args["customer_name"] ?? null,
          customer_email: args["customer_email"] ?? null,
          status: "new",
        }),
      });
      result = await r.json();
    } else {
      return { error: `Unknown tool: ${name}` };
    }

    logger.info("tool executed", { name, duration_ms: Date.now() - t0 });
    return result;
  } catch (e) {
    logger.error("tool execution error", { name, duration_ms: Date.now() - t0, err: e });
    return { error: String(e) };
  }
}
