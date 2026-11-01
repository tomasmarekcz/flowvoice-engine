// LEA-149: the owner gets one notice per call. When the call made a booking, the dashboard words it (heading, date, the
// link to answer it or to open it) and the engine puts it into the call-summary SMS instead of sending a second text.
// Any failure here only means the SMS goes out as it always did; the dashboard's safety net then announces the booking.

import { logger } from "./logger";

export interface OwnerBookingBlock {
  heading: string;
  lines: string[];
}

const TIMEOUT_MS = 5000;

export async function fetchOwnerBookingBlock(callId: string | null, projectId: string | null): Promise<OwnerBookingBlock | null> {
  if (!callId || !projectId) return null;
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/notify/booking-block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "" },
      body: JSON.stringify({ call_id: callId, project_id: projectId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("owner booking block: dashboard answered with an error", { status: res.status });
      return null;
    }
    const data = (await res.json()) as { heading?: string; lines?: string[] };
    if (!data.heading || !Array.isArray(data.lines) || data.lines.length === 0) return null;
    return { heading: data.heading, lines: data.lines };
  } catch (e) {
    logger.warn("owner booking block: could not ask the dashboard", { err: String(e) });
    return null;
  }
}
