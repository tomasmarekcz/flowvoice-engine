import { logger } from "./logger";

export async function checkCallEligibility(
  projectId: string
): Promise<{ allowed: boolean; reason: string | null }> {
  const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/projects/${projectId}/call-eligibility`, {
      headers: { "X-Internal-Secret": process.env.ENGINE_INTERNAL_SECRET ?? "" },
    });
    if (!res.ok) {
      // Fail open on a transient dashboard error rather than rejecting live
      // calls because of an unrelated outage — matches how other engine→
      // frontend calls in tools.ts already degrade.
      logger.error("call-eligibility check failed, allowing call", { status: res.status, project_id: projectId });
      return { allowed: true, reason: null };
    }
    return (await res.json()) as { allowed: boolean; reason: string | null };
  } catch (e) {
    logger.error("call-eligibility check errored, allowing call", { err: e, project_id: projectId });
    return { allowed: true, reason: null };
  }
}
