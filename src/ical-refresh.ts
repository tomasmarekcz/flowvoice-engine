import { logger } from "./logger";

// LEA-139: the owner's other calendars (iCal addresses) are downloaded by the dashboard. At the start of a call we ask
// it to refresh them, so the busy time is fresh by the time the caller asks for a time. This runs while the assistant is
// still greeting and is never awaited: a slow or failed refresh must not delay the call, the assistant then simply uses
// the last copy it has. Nothing here may throw into the call.
export function refreshExternalCalendars(projectId: string | null): void {
  if (!projectId) return;
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  const failed = (e: unknown) => logger.warn("external calendar refresh failed", { project_id: projectId, err: String(e) });
  try {
    Promise.resolve(
      fetch(`${base}/api/calendar/ical-refresh?project_id=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "" },
        signal: AbortSignal.timeout(20_000),
      }),
    ).catch(failed);
  } catch (e) {
    failed(e);
  }
}
