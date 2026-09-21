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
