import { beginActivity } from "./activity";
import { loadAssistantSettings, type AssistantSettings } from "./config";
import type { PromptSnapshot } from "./prompts/core";
import { LiveCallSession } from "./live-session";
import { logger } from "./logger";
import { getSnapshot } from "./prompts/store";
import { CallSession } from "./session";
import { PipelineCallSession } from "./pipeline-session";
import { makeVoice } from "./voice/make-voice";
import { hybridBrainModel } from "./models";
import type { SessionCallbacks, VoiceSession } from "./session-types";

// Where the caller is: a phone line (Twilio, 8 kHz μ-law) or the browser test call (PCM 24 kHz).
export type Transport = "twilio" | "browser";

// A phone call speaks the line's own format with OpenAI, so no audio is converted on the way (LEA-155).
// TWILIO_STANDARD_AUDIO=pcm24 switches back to converting, should the phone format ever sound worse.
function standardAudioFor(transport: Transport): "pcmu" | "pcm24" {
  return transport === "twilio" && process.env.TWILIO_STANDARD_AUDIO !== "pcm24" ? "pcmu" : "pcm24";
}

// Live may fail to start; a quick failure (the connection dropped or was refused) is tried once more, a slow one is not
// (OpenAI is slow right now: the caller has waited long enough) and the call goes to Standard instead.
async function startLive(
  settings: AssistantSettings | null,
  projectId: string | null,
  callerPhone: string | null,
  twilioCallSid: string | null,
  callbacks: SessionCallbacks,
  promptSnapshot: PromptSnapshot
): Promise<{ session: LiveCallSession; reason?: undefined } | { session?: undefined; reason: string }> {
  let reason = "live failed to start";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const live = new LiveCallSession(settings, projectId, callerPhone, twilioCallSid, callbacks, { promptSnapshot });
    const startedAt = Date.now();
    try {
      await live.start();
      return { session: live };
    } catch (e) {
      const elapsed = Date.now() - startedAt;
      reason = e instanceof Error ? e.message.slice(0, 120) : reason;
      logger.error("live session failed to start", { project_id: projectId ?? "none", attempt, elapsed_ms: elapsed, err: e });
      await live.abort();
      if (attempt === 2 || elapsed > 3000) break; // a slow failure is not worth another wait
    }
  }
  return { reason };
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
  const engine = settings?.voice_engine ?? "standard";
  const audio = standardAudioFor(transport);
  const reasonOf = (e: unknown) => (e instanceof Error ? e.message.slice(0, 120) : "engine failed to start");

  if (engine === "live") {
    const result = await startLive(settings, projectId, callerPhone, twilioCallSid, callbacks, promptSnapshot);
    if (result.session) return result.session;
    fallbackReason = result.reason;
  } else if (engine === "hybrid") {
    // The Realtime model listens and thinks (answering in text); a separate Realtime session is the voice.
    const hybrid = new CallSession(projectId, callerPhone, twilioCallSid, callbacks, settings, promptSnapshot, {
      audio, model: hybridBrainModel(),
      voice: (voiceName, snapshot) => makeVoice(voiceName, snapshot, settings),
    });
    try {
      await hybrid.start();
      return hybrid;
    } catch (e) {
      logger.error("hybrid session failed to start, falling back to standard", { project_id: projectId ?? "none", err: e });
      await hybrid.abort();
      fallbackReason = `hybrid: ${reasonOf(e)}`;
    }
  } else if (engine === "pipeline") {
    const pipeline = new PipelineCallSession(projectId, callerPhone, twilioCallSid, callbacks, settings, promptSnapshot, {
      audio,
      voice: (voiceName, snapshot) => makeVoice(voiceName, snapshot, settings),
    });
    try {
      await pipeline.start();
      return pipeline;
    } catch (e) {
      logger.error("pipeline session failed to start, falling back to standard", { project_id: projectId ?? "none", err: e });
      await pipeline.abort();
      fallbackReason = `pipeline: ${reasonOf(e)}`;
    }
  }

  const session = new CallSession(projectId, callerPhone, twilioCallSid, callbacks, settings, promptSnapshot, {
    audio: standardAudioFor(transport),
    ...(fallbackReason ? { fallbackReason } : {}),
  });
  await session.start();
  return session;
}
