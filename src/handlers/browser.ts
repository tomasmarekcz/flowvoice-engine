import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { startCallSession } from "../session-factory";
import type { VoiceSession } from "../session-types";
import { openAIAudioToTwilio, twilioAudioToOpenAI } from "../audio";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { createLogContext } from "../log/context";
import { checkCallEligibility } from "../billing";
import { verifyTestCallTicket } from "../test-call-ticket";

// Most test calls that may run at the same time on one engine. More owners than this get a polite "line busy".
const MAX_CONCURRENT_TEST_CALLS = parseInt(process.env.MAX_CONCURRENT_TEST_CALLS ?? "10", 10);
let activeTestCalls = 0;
// How long the goodbye of a Live test call is given to play before the line is hung up.
const END_CALL_PLAYBACK_MS = 3000;
// The caller is told this long before the time limit.
const TIME_WARNING_SECONDS = 60;

function reject(ws: WS, code: string, message: string): void {
  if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: "error", code, message }));
  ws.close();
}

// A test call: the owner scanned the QR code in the dashboard and talks to the assistant from the phone.
// It only starts with a valid one-time ticket from the dashboard; the project and the phone number come from the ticket.
export async function handleBrowserConnection(
  ws: WS,
  request: IncomingMessage
): Promise<void> {
  const params = new URL(request.url ?? "", "http://localhost").searchParams;
  const verified = verifyTestCallTicket(params.get("ticket"), process.env.ENGINE_INTERNAL_SECRET);
  if (!verified.ok) {
    logger.info("test call rejected: bad ticket", { event: "browser.ticket_rejected", reason: verified.reason });
    reject(ws, "ticket_invalid", "This test link is no longer valid.");
    return;
  }
  const { projectId, phone, maxSeconds } = verified.ticket;

  // WebSocket callbacks do not inherit async context, so every listener below is bound to this one.
  const logCtx = createLogContext({ request_id: randomUUID(), project_id: projectId });
  logCtx.run(() => logger.info("test call client connected", { event: "browser.ws_connected", project_id: projectId }));

  if (activeTestCalls >= MAX_CONCURRENT_TEST_CALLS) {
    logger.info("test call rejected: line busy", { project_id: projectId, active: activeTestCalls });
    reject(ws, "busy", "All test lines are busy right now.");
    return;
  }

  const eligibility = await checkCallEligibility(projectId);
  if (!eligibility.allowed) {
    logger.info("browser call rejected by billing eligibility", { project_id: projectId, reason: eligibility.reason });
    ws.send(JSON.stringify({ type: "error", code: "not_allowed", message: `Call not allowed: ${eligibility.reason}` }));
    ws.close();
    return;
  }

  activeTestCalls++;
  let released = false;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    activeTestCalls--;
    if (limitTimer) clearTimeout(limitTimer);
    if (warnTimer) clearTimeout(warnTimer);
  };
  // Also when the caller hangs up while the session is still starting.
  ws.on("close", release);

  // The test call runs the same engine as a real call (Standard or Live, as the project chose). Live speaks 8 kHz phone
  // audio, so the browser's 24 kHz audio is converted both ways: the test then also sounds like a real phone line.
  let session: VoiceSession | null = null;
  const sessionCallbacks = {
    sendAudio: (audio: string, format: "pcm24" | "mulaw8" = "pcm24") => {
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: format === "mulaw8" ? twilioAudioToOpenAI(audio) : audio }));
      }
    },
    sendJson: (obj: unknown) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(obj));
    },
    // There is no Twilio media stream to echo a mark back. The Live session waits for the echo before hanging up
    // after end_call, so it gets one once the goodbye has had time to play; Standard falls back to its safety timer.
    sendMark: (name: string) => {
      if (session?.audioFormat === "mulaw8") setTimeout(() => session?.handleTwilioMark(name), END_CALL_PLAYBACK_MS);
    },
    endCall: () => {
      if (ws.readyState === WS.OPEN) ws.close();
    },
  };

  try {
    session = await logCtx.run(() => startCallSession(projectId, phone, null, sessionCallbacks));
  } catch (e) {
    release();
    ws.send(JSON.stringify({ type: "error", code: "start_failed", message: (e as Error).message }));
    ws.close();
    return;
  }
  const running = session;
  // The Standard session announces itself when its OpenAI socket opens; the Live session is ready once start() returns.
  if (running.audioFormat === "mulaw8") ws.send(JSON.stringify({ type: "proxy.connected" }));

  // A test call is capped so a forgotten call cannot run up minutes. The caller is warned first and told why it ended,
  // so a cut-off is not mistaken for a fault of the assistant.
  if (maxSeconds > TIME_WARNING_SECONDS) {
    warnTimer = setTimeout(() => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: "engine.time_warning", seconds_left: TIME_WARNING_SECONDS }));
    }, (maxSeconds - TIME_WARNING_SECONDS) * 1000);
  }
  limitTimer = setTimeout(() => {
    logger.info("test call reached its time limit", { event: "browser.time_limit", seconds: maxSeconds });
    if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: "engine.time_limit" }));
    ws.close();
  }, maxSeconds * 1000);

  ws.on("message", logCtx.bind((data) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg["type"] === "input_audio_buffer.append") {
      const audio = msg["audio"] as string;
      running.handleClientAudio(running.audioFormat === "mulaw8" ? openAIAudioToTwilio(audio) : audio);
    } else {
      running.handleClientEvent?.(msg);
    }
  }));

  ws.on("close", logCtx.bind(() => {
    release();
    logger.info("browser client disconnected", { event: "browser.ws_closed" });
    running.end().catch((e) => logger.error("session.end error", { err: e }));
  }));

  ws.on("error", logCtx.bind((e: Error) => logger.error("browser WS error", { event: "browser.ws_error", err: e })));
}
