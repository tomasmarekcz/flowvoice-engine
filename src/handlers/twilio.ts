import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import type { Request, Response } from "express";
import { CallSession } from "../session";
import { logger } from "../logger";
import { twilioAudioToOpenAI, openAIAudioToTwilio } from "../audio";
import { getSupabaseUrl, getSupabaseHeaders } from "../config";
import { checkCallEligibility } from "../billing";

export async function handleTwilioVoiceWebhook(req: Request, res: Response): Promise<void> {
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
  const rawFrom = body["From"] ?? "";
  // Extract phone number from SIP URI e.g. "sip:+420721071534@sip.zadarma.com" → "+420721071534"
  const sipMatch = rawFrom.match(/sip:([^@]+)@/);
  const callerPhone = sipMatch ? sipMatch[1] : rawFrom;
  const callSid = body["CallSid"] ?? "";

  logger.info("twilio voice webhook", { project_id: projectId, caller: callerPhone, call_sid: callSid });

  const eligibility = await checkCallEligibility(projectId);
  if (!eligibility.allowed) {
    logger.info("call rejected by billing eligibility", { project_id: projectId, reason: eligibility.reason });
    const rejectionTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, this number is temporarily unavailable. Please try again later.</Say>
  <Hangup/>
</Response>`;
    res.type("text/xml").send(rejectionTwiml);
    return;
  }

  const engineHost = process.env.ENGINE_HOST ?? req.get("host") ?? "localhost:8080";
  const wsProtocol = process.env.ENGINE_HOST ? "wss" : "ws";
  const httpProtocol = process.env.ENGINE_HOST ? "https" : "http";
  const recordingCallback = `${httpProtocol}://${engineHost}/twilio/recording-status`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Recording recordingStatusCallback="${recordingCallback}" recordingStatusCallbackEvent="completed" />
  </Start>
  <Connect>
    <Stream url="${wsProtocol}://${engineHost}/ws/twilio">
      <Parameter name="project_id" value="${projectId}" />
      <Parameter name="caller_phone" value="${callerPhone}" />
      <Parameter name="call_sid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
}

export async function handleRecordingStatusCallback(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, string>;
  const status = body["RecordingStatus"];
  const recordingUrl = body["RecordingUrl"];
  const recordingSid = body["RecordingSid"];
  const callSid = body["CallSid"];

  // Respond immediately — Twilio expects fast acknowledgement
  res.sendStatus(200);

  if (status !== "completed" || !recordingUrl || !callSid) return;

  try {
    await fetch(
      `${getSupabaseUrl()}/rest/v1/calls?twilio_call_sid=eq.${encodeURIComponent(callSid)}`,
      {
        method: "PATCH",
        headers: { ...getSupabaseHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({
          recording_url: `${recordingUrl}.mp3`,
          recording_sid: recordingSid,
        }),
      }
    );
    logger.info("recording url saved", { call_sid: callSid, recording_sid: recordingSid });
  } catch (e) {
    logger.error("recording status callback error", { err: e });
  }
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
      const callSid = customParams["call_sid"] || null;

      logger.info("Twilio stream started", { stream_sid: streamSid, project_id: projectId ?? "none", call_sid: callSid ?? "none" });

      const capturedStreamSid = streamSid;

      session = new CallSession(projectId, callerPhone, callSid, {
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
        sendMark: (name) => {
          if (!capturedStreamSid || ws.readyState !== WS.OPEN) return;
          ws.send(JSON.stringify({ event: "mark", streamSid: capturedStreamSid, mark: { name } }));
        },
        endCall: () => {
          logger.info("end_call: closing Twilio WS");
          if (ws.readyState === WS.OPEN) ws.close();
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

    if (event === "mark") {
      const markName = (msg["mark"] as Record<string, string> | undefined)?.["name"];
      if (session && markName) session.handleTwilioMark(markName);
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
