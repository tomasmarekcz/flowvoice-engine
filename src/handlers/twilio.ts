import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import type { Request, Response } from "express";
import { CallSession } from "../session";
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

  const projectId =
    (req.query["project_id"] as string) ??
    (req.body as Record<string, string>)["project_id"] ??
    "";
  const engineHost = process.env.ENGINE_HOST ?? req.get("host") ?? "localhost:8080";
  const wsProtocol = process.env.ENGINE_HOST ? "wss" : "ws";

  // TwiML: connect the call to our WebSocket Media Stream endpoint.
  // project_id is passed as a custom parameter so the WS handler knows which
  // business's settings to load from Supabase.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsProtocol}://${engineHost}/ws/twilio">
      <Parameter name="project_id" value="${projectId}" />
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

  console.log("[twilio] Media Stream connected");

  ws.on("message", async (data) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const event = msg["event"] as string;

    if (event === "start") {
      const start = msg["start"] as Record<string, unknown>;
      streamSid = msg["streamSid"] as string;
      const customParams = (start["customParameters"] as Record<string, string>) ?? {};
      const projectId = customParams["project_id"] ?? null;
      // callSid used as caller identifier; real E.164 phone comes via Twilio request body,
      // not the WS stream — acceptable for MVP logging
      const callerPhone = (start["callSid"] as string) ?? null;

      console.log(`[twilio] stream started — sid: ${streamSid}, project_id: ${projectId ?? "none"}`);

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
          if (typed?.["type"]) console.log(`[twilio] engine event: ${typed["type"]}`);
        },
      });

      try {
        await session.start();
      } catch (e) {
        console.error("[twilio] session.start error:", (e as Error).message);
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
      console.log("[twilio] stream stopped");
      if (session) {
        await session.end().catch((e) =>
          console.error("[twilio] session.end error:", (e as Error).message)
        );
      }
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    console.log("[twilio] WS closed");
    if (session) {
      session.end().catch((e) =>
        console.error("[twilio] session.end on close error:", (e as Error).message)
      );
    }
  });

  ws.on("error", (e) => console.error("[twilio] WS error:", e.message));
}
