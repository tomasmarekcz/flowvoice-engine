import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { CallSession } from "../session";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { createLogContext } from "../log/context";
import { checkCallEligibility } from "../billing";
import { verifyTestCallTicket } from "../test-call-ticket";

// Most test calls that may run at the same time on one engine. More owners than this get a polite "line busy".
const MAX_CONCURRENT_TEST_CALLS = parseInt(process.env.MAX_CONCURRENT_TEST_CALLS ?? "10", 10);
let activeTestCalls = 0;

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
  const release = () => {
    if (released) return;
    released = true;
    activeTestCalls--;
    if (limitTimer) clearTimeout(limitTimer);
  };
  // Also when the caller hangs up while the session is still starting.
  ws.on("close", release);

  const session = new CallSession(projectId, phone, null, {
    sendAudio: (pcm24Base64) => {
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: pcm24Base64 }));
      }
    },
    sendJson: (obj) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(obj));
    },
    // No Twilio media stream here to echo a mark back — this is a raw
    // browser test client, so end_call just falls back to the safety timer.
    sendMark: () => {},
    endCall: () => {
      if (ws.readyState === WS.OPEN) ws.close();
    },
  });

  try {
    await logCtx.run(() => session.start());
  } catch (e) {
    release();
    ws.send(JSON.stringify({ type: "error", code: "start_failed", message: (e as Error).message }));
    ws.close();
    return;
  }

  // A test call is capped so a shared or forgotten link cannot run up minutes.
  limitTimer = setTimeout(() => {
    logger.info("test call reached its time limit", { event: "browser.time_limit", seconds: maxSeconds });
    if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: "engine.time_limit" }));
    ws.close();
  }, maxSeconds * 1000);

  ws.on("message", logCtx.bind((data) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg["type"] === "input_audio_buffer.append") {
      session.handleClientAudio(msg["audio"] as string);
    } else {
      session.handleClientEvent(msg);
    }
  }));

  ws.on("close", logCtx.bind(() => {
    release();
    logger.info("browser client disconnected", { event: "browser.ws_closed" });
    session.end().catch((e) => logger.error("session.end error", { err: e }));
  }));

  ws.on("error", logCtx.bind((e: Error) => logger.error("browser WS error", { event: "browser.ws_error", err: e })));
}
