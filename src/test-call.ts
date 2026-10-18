import { getSupabaseHeaders, getSupabaseUrl } from "./config";
import { logger } from "./logger";

// A test call is the one the owner makes from the dashboard's QR code (browser): it has no Twilio call.
// It does have a caller number now (the one the owner typed), so the Twilio call is the only mark.
export function isTestCall(twilioCallSid: string | null): boolean {
  return twilioCallSid === null;
}

export interface NotificationPlan {
  /** Write the owner SMS / email texts even if the owner has those switched off, so the call detail shows them. */
  forceGenerate: boolean;
  /** Really send them. */
  send: boolean;
}

// The very first test call of a project really sends the owner's SMS and email (the "wow" moment).
// Later test calls only write the texts into the call detail, so repeated testing does not spam the owner.
export function notificationPlan(testCall: boolean, firstTestCall: boolean): NotificationPlan {
  if (!testCall) return { forceGenerate: false, send: true };
  return { forceGenerate: true, send: firstTestCall };
}

/** True when this project has no other test call than the one that just ended. */
export async function isFirstTestCall(projectId: string | null, callId: string | null): Promise<boolean> {
  if (!projectId || !callId) return false;
  try {
    const res = await fetch(
      `${getSupabaseUrl()}/rest/v1/calls?project_id=eq.${projectId}&twilio_call_sid=is.null&id=neq.${callId}&select=id&limit=1`,
      { headers: getSupabaseHeaders() },
    );
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) && rows.length === 0;
  } catch (e) {
    logger.error("isFirstTestCall error", { err: e });
    return false;
  }
}
