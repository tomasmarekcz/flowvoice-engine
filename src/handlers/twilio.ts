import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import type { Request, Response } from "express";
import { CallSession } from "../session";
import { logger } from "../logger";
import { twilioAudioToOpenAI, openAIAudioToTwilio } from "../audio";

export function handleTwilioVoiceWebhook(req: Request, res: Response): void {
  if (process.env.TWILIO_SKIP_VALIDATION !== "true") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const twilio = require("twilio") as {
      validateRequest: (token: string, sig: string, url: string, params: Record<string, string>) => boolean;
    };
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
    const signature = (req.headers["x-twilio-signature"] as string) ?? "";
    const engineHost = process.env.ENGINE_HOST ?? req.get("host") ?? "";
    const url = `https://${engineHost}/twilio/voice`;
    if (!twilio.validateRequest(authToken, signature, url, req.body as Record<string, string>)) {
      res.status(403).send("Forbidden");
      return;
    }
  }

  const body = req.body as Record<string, string>;
  const projectId = (req.query["project_id"] as string) ?? body["project_id"] ?? "";
  const callerPhone = body["From"] ?? "";

  // Log all Twilio/SIP params to help debug forwarded call caller ID
  const sipFields = Object.fromEntries(
    Object.entries(body).filter(([k]) => k.startsWith("Sip") || ["From","To","ForwardedFrom","CallerCountry","Called","Caller"].includes(k))
  );
  logger.info("twilio voice webhook", { project_id: projectId, caller: callerPhone, sip_fields: sipFields });
  const engineHost = process.env.ENGINE_HOST ?? req.get("host") ?? "localhost:8080";
  const wsProtocol = process.env.ENGINE_HOST ? "wss" : "ws";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProtocol}://${engineHost}/ws/twilio">
      <Parameter name="project_id" value="${projectId}" />
      <Parameter name="caller_phone" value="${callerPhone}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
}

export async function handleTwilioConnection(
  ws: WS,
  _request: IncomingMessage
): Promise<void> {
  let streamSid: string | null = null;
  let session: CallSession | null = null;

  logger.info("Twilio Media Stream connected");

  ws.on("message", async (data) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const event = msg["event"] as string;

    if (event === "start") {
      const start = msg["start"] as Record<string, unknown>;
      streamSid = msg["streamSid"] as string;
      const customParams = (start["customParameters"] as Record<string, string>) ?? {};
      const projectId = customParams["project_id"] ?? null;
      const callerPhone = customParams["caller_phone"] || null;

      logger.info("Twilio stream started", { stream_sid: streamSid, project_id: projectId ?? "none" });

      const capturedStreamSid = streamSid;

      session = new CallSession(projectId, callerPhone, {
        sendAudio: (pcm24Base64) => {
          if (!capturedStreamSid || ws.readyState !== WS.OPEN) return;
          ws.send(JSON.stringify({
            event: "media",
            streamSid: capturedStreamSid,
            media: { payload: openAIAudioToTwilio(pcm24Base64) },
          }));
        },
        sendJson: (obj) => {
          const typed = obj as Record<string, unknown>;
          if (typed?.["type"]) logger.debug("engine event to Twilio", { type: typed["type"] });
        },
      });

      try {
        await session.start();
      } catch (e) {
        logger.error("session.start error", { err: e });
        ws.close();
      }
      return;
    }

    if (event === "media") {
      if (!session) return;
      const payload = (msg["media"] as Record<string, string>)["payload"];
      session.handleClientAudio(twilioAudioToOpenAI(payload));
      return;
    }

    if (event === "stop") {
      logger.info("Twilio stream stopped");
      if (session) {
        await session.end().catch((e) =>
          logger.error("session.end error", { err: e })
        );
      }
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    logger.info("Twilio WS closed");
    if (session) {
      session.end().catch((e) =>
        logger.error("session.end on close error", { err: e })
      );
    }
  });

  ws.on("error", (e) => logger.error("Twilio WS error", { err: e }));
}
