import { beginActivity } from "./activity";
import { loadAssistantSettings } from "./config";
import { LiveCallSession } from "./live-session";
import { logger } from "./logger";
import { CallSession } from "./session";
import type { SessionCallbacks, VoiceSession } from "./session-types";

export async function startCallSession(
  projectId: string | null,
  callerPhone: string | null,
  twilioCallSid: string | null,
  callbacks: SessionCallbacks
): Promise<VoiceSession> {
  // From now until the summary, SMS and e-mail are done, a restart of the engine would cut this call (LEA-80).
  const activity = beginActivity(twilioCallSid ? "call" : "test_call", projectId);
  try {
    const session = await createSession(projectId, callerPhone, twilioCallSid, callbacks);
    activity.setPhase("live");

    if (typeof session.end !== "function") return session;
    const originalEnd = session.end.bind(session);
    let ending: Promise<void> | null = null;
    session.end = () => {
      // Every caller waits for the same work, so the call stays counted until it has really finished.
      if (!ending) {
        activity.setPhase("wrapping_up");
        ending = originalEnd().finally(() => activity.end());
      }
      return ending;
    };
    return session;
  } catch (e) {
    activity.end();
    throw e;
  }
}

async function createSession(
  projectId: string | null,
  callerPhone: string | null,
  twilioCallSid: string | null,
  callbacks: SessionCallbacks
): Promise<VoiceSession> {
  const settings = await loadAssistantSettings(projectId);

  if (settings?.voice_engine === "live") {
    const live = new LiveCallSession(settings, projectId, callerPhone, twilioCallSid, callbacks);
    try {
      await live.start();
      return live;
    } catch (e) {
      logger.error("live session failed to start, falling back to standard", {
        project_id: projectId ?? "none",
        err: e,
      });
      await live.abort();
    }
  }

  const session = new CallSession(projectId, callerPhone, twilioCallSid, callbacks, settings);
  await session.start();
  return session;
}
