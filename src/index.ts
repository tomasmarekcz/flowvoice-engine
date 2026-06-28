import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { handleTwilioVoiceWebhook, handleRecordingStatusCallback, handleTwilioConnection } from "./handlers/twilio";
import { handleBrowserConnection } from "./handlers/browser";
import { logger } from "./logger";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/twilio/voice", handleTwilioVoiceWebhook);
app.post("/twilio/recording-status", handleRecordingStatusCallback);

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = request.url ?? "";
  if (url.startsWith("/ws/twilio")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTwilioConnection(ws, request).catch((e) => {
        logger.error("twilio handler error", { err: e });
        ws.close();
      });
    });
  } else if (url.startsWith("/ws/browser")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleBrowserConnection(ws, request).catch((e) => {
        logger.error("browser handler error", { err: e });
        ws.close();
      });
    });
  } else {
    socket.destroy();
  }
});

const PORT = parseInt(process.env.PORT ?? "8080", 10);

server.listen(PORT, () => {
  logger.info("engine listening", { port: PORT });
});

export { app, server };
