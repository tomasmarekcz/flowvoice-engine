import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { CallSession } from "../session";
import { logger } from "../logger";
import { checkCallEligibility } from "../billing";

export async function handleBrowserConnection(
  ws: WS,
  request: IncomingMessage
): Promise<void> {
  const params = new URL(request.url ?? "", "http://localhost").searchParams;
  const projectId = params.get("project_id");
  logger.info("browser client connected", { project_id: projectId ?? "none" });

  if (projectId) {
    const eligibility = await checkCallEligibility(projectId);
    if (!eligibility.allowed) {
      logger.info("browser call rejected by billing eligibility", { project_id: projectId, reason: eligibility.reason });
      ws.send(JSON.stringify({ type: "error", message: `Call not allowed: ${eligibility.reason}` }));
      ws.close();
      return;
    }
  }

  const session = new CallSession(projectId, null, null, {
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
    await session.start();
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
    ws.close();
    return;
  }

  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg["type"] === "input_audio_buffer.append") {
      session.handleClientAudio(msg["audio"] as string);
    } else {
      session.handleClientEvent(msg);
    }
  });

  ws.on("close", () => {
    logger.info("browser client disconnected");
    session.end().catch((e) => logger.error("session.end error", { err: e }));
  });

  ws.on("error", (e) => logger.error("browser WS error", { err: e }));
}
