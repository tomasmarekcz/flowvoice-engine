import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { CallSession } from "../session";

export async function handleBrowserConnection(
  ws: WS,
  request: IncomingMessage
): Promise<void> {
  const params = new URL(request.url ?? "", "http://localhost").searchParams;
  const projectId = params.get("project_id");
  console.log(`[browser] client connected — project_id: ${projectId ?? "none"}`);

  const session = new CallSession(projectId, null, {
    sendAudio: (pcm24Base64) => {
      if (ws.readyState === WS.OPEN) {
        // Browser expects the same event shape server.js used to forward
        ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: pcm24Base64 }));
      }
    },
    sendJson: (obj) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(obj));
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
    console.log("[browser] client disconnected");
    session.end().catch((e) => console.error("[browser] session.end error:", (e as Error).message));
  });

  ws.on("error", (e) => console.error("[browser] WS error:", e.message));
}
