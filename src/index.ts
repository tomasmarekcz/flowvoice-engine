import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { handleTwilioVoiceWebhook, handleTwilioConnection } from "./handlers/twilio";
import { handleBrowserConnection } from "./handlers/browser";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/twilio/voice", handleTwilioVoiceWebhook);

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = request.url ?? "";
  if (url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTwilioConnection(ws, request).catch((e) => {
        console.error("[engine] twilio handler error:", (e as Error).message);
        ws.close();
      });
    });
  } else if (url.startsWith("/ws/browser")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleBrowserConnection(ws, request).catch((e) => {
        console.error("[engine] browser handler error:", (e as Error).message);
        ws.close();
      });
    });
  } else {
    socket.destroy();
  }
});

const PORT = parseInt(process.env.PORT ?? "8080", 10);

server.listen(PORT, () => {
  console.log(`[engine] listening on port ${PORT}`);
});

export { app, server };
