import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { handleTwilioVoiceWebhook, handleRecordingStatusCallback, handleDialStatusCallback, handleSmsStatusCallback, handleTwilioConnection } from "./handlers/twilio";
import { handleBrowserConnection } from "./handlers/browser";
import { handleActiveCalls } from "./handlers/activity";
import { handlePromptPreview } from "./handlers/prompt-preview";
import { logger } from "./logger";
import { assertEnvironmentSafe } from "./environment";
import { assertTwilioSecurityConfigured } from "./twilio-security";
import { installFetchLogging } from "./log/fetch-logging";
import { inLogContext } from "./log-http";
import { ALL_ENGINE_PROMPTS } from "./prompts/registry";
import { getSnapshot, registerPrompts } from "./prompts/store";

assertEnvironmentSafe(); // throws (process exits) if the environment label and the database disagree
assertTwilioSecurityConfigured(); // throws (process exits) if Twilio validation is on but its token/secret is missing

installFetchLogging(logger);
process.on("uncaughtExceptionMonitor", (err) => {
  logger.error("uncaught exception", { event: "system.uncaught", err });
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/internal/active-calls", handleActiveCalls);
app.post("/internal/prompt-preview", handlePromptPreview);

app.post("/twilio/voice", inLogContext(handleTwilioVoiceWebhook));
app.post("/twilio/voice/dial-status", inLogContext(handleDialStatusCallback));
app.post("/twilio/recording-status", inLogContext(handleRecordingStatusCallback));
app.post("/twilio/sms-status", inLogContext(handleSmsStatusCallback));

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
  logger.info("engine listening", { port: PORT, event: "system.start" });

  // LEA-63: tell the database which prompts this version of the code knows (failures are logged, never fatal),
  // and keep the editable-prompt cache warm so a call never waits for it.
  void registerPrompts(ALL_ENGINE_PROMPTS).then(() => getSnapshot());
  setInterval(() => void getSnapshot(), 30_000).unref();
});

export { app, server };
