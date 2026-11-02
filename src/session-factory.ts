import { beginActivity } from "./activity";
import { loadAssistantSettings } from "./config";
import { LiveCallSession } from "./live-session";
import { logger } from "./logger";
import { getSnapshot } from "./prompts/store";
import { CallSession } from "./session";
import type { SessionCallbacks, VoiceSession } from "./session-types";

// Where the caller is: a phone line (Twilio, 8 kHz μ-law) or the browser test call (PCM 24 kHz).
export type Transport = "twilio" | "browser";

// A phone call speaks the line's own format with OpenAI, so no audio is converted on the way (LEA-155).
// TWILIO_STANDARD_AUDIO=pcm24 switches back to converting, should the phone format ever sound worse.
function standardAudioFor(transport: Transport): "pcmu" | "pcm24" {
  return transport === "twilio" && process.env.TWILIO_STANDARD_AUDIO !== "pcm24" ? "pcmu" : "pcm24";
}

export async function startCallSession(
  projectId: string | null,
  callerPhone: string | null,
  twilioCallSid: string | null,
  callbacks: SessionCallbacks,
  transport: Transport = "browser"
): Promise<VoiceSession> {
  // From now until the summary, SMS and e-mail are done, a restart of the engine would cut this call (LEA-80).
  const activity = beginActivity(twilioCallSid ? "call" : "test_call", projectId);
  try {
    const session = await createSession(projectId, callerPhone, twilioCallSid, callbacks, transport);
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
  callbacks: SessionCallbacks,
  transport: Transport
): Promise<VoiceSession> {
  // The editable prompts are read once per call (LEA-63); they fall back to the code defaults on any problem.
  const [settings, promptSnapshot] = await Promise.all([loadAssistantSettings(projectId), getSnapshot()]);

  let fallbackReason: string | undefined;
  if (settings?.voice_engine === "live") {
    const live = new LiveCallSession(settings, projectId, callerPhone, twilioCallSid, callbacks, { promptSnapshot });
    try {
      await live.start();
      return live;
    } catch (e) {
      logger.error("live session failed to start, falling back to standard", {
        project_id: projectId ?? "none",
        err: e,
      });
      await live.abort();
      fallbackReason = e instanceof Error ? e.message.slice(0, 120) : "live start failed";
    }
  }

  const session = new CallSession(projectId, callerPhone, twilioCallSid, callbacks, settings, promptSnapshot, {
    audio: standardAudioFor(transport),
    ...(fallbackReason ? { fallbackReason } : {}),
  });
  await session.start();
  return session;
}
