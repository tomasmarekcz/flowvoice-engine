import { WebSocket as WS } from "ws";
import { IncomingMessage } from "http";
import type { Request, Response } from "express";
import { startCallSession } from "../session-factory";
import type { AudioFormat, VoiceSession } from "../session-types";
import { logger } from "../logger";
import { twilioAudioToOpenAI, openAIAudioToTwilio } from "../audio";
import { getSupabaseUrl, getSupabaseHeaders, loadAssistantSettings } from "../config";
import { checkCallEligibility } from "../billing";
import { decideCallRouting } from "../call-routing";

const DIAL_TO_OWNER_TIMEOUT_SECONDS = 20;

function buildAiConnectTwiml(opts: {
  engineHost: string; wsProtocol: string; httpProtocol: string;
  projectId: string; callerPhone: string; callSid: string;
  includeRecording: boolean;
}): string {
  const recording = opts.includeRecording
    ? `<Start>
    <Recording recordingStatusCallback="${opts.httpProtocol}://${opts.engineHost}/twilio/recording-status" recordingStatusCallbackEvent="completed" />
  </Start>
  `
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${recording}<Connect>
    <Stream url="${opts.wsProtocol}://${opts.engineHost}/ws/twilio">
      <Parameter name="project_id" value="${opts.projectId}" />
      <Parameter name="caller_phone" value="${opts.callerPhone}" />
      <Parameter name="call_sid" value="${opts.callSid}" />
    </Stream>
  </Connect>
</Response>`;
}

function buildDialToOwnerTwiml(opts: {
  engineHost: string; httpProtocol: string; ownerPhone: string;
  projectId: string; callerPhone: string; callSid: string; withAiFallback: boolean;
}): string {
  const recordingCallback = `${opts.httpProtocol}://${opts.engineHost}/twilio/recording-status`;
  const dialAction = `${opts.httpProtocol}://${opts.engineHost}/twilio/voice/dial-status`
    + `?project_id=${encodeURIComponent(opts.projectId)}`
    + `&caller_phone=${encodeURIComponent(opts.callerPhone)}`
    + `&call_sid=${encodeURIComponent(opts.callSid)}`
    + `&with_ai_fallback=${opts.withAiFallback ? "true" : "false"}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Recording recordingStatusCallback="${recordingCallback}" recordingStatusCallbackEvent="completed" />
  </Start>
  <Dial timeout="${DIAL_TO_OWNER_TIMEOUT_SECONDS}" action="${dialAction}">${opts.ownerPhone}</Dial>
</Response>`;
}

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

  const settings = await loadAssistantSettings(projectId);
  const routing = decideCallRouting({
    answerMode: settings?.answer_mode,
    workingHours: settings?.working_hours,
    timezone: settings?._calendar_timezone,
    hasOwnerPhone: !!settings?.owner_phone,
  });

  logger.info("call routing decision", { project_id: projectId, answer_mode: settings?.answer_mode ?? "missed_calls", routing: routing.kind });

  if (routing.kind === "dial") {
    const twiml = buildDialToOwnerTwiml({
      engineHost, httpProtocol,
      ownerPhone: settings!.owner_phone as string,
      projectId, callerPhone, callSid,
      withAiFallback: routing.withAiFallback,
    });
    res.type("text/xml").send(twiml);
    return;
  }

  const twiml = buildAiConnectTwiml({
    engineHost, wsProtocol, httpProtocol, projectId, callerPhone, callSid, includeRecording: true,
  });
  res.type("text/xml").send(twiml);
}

// Twilio calls this after a <Dial> to the owner ends (answered, no-answer,
// busy, failed, or canceled) — see buildDialToOwnerTwiml's action URL.
export async function handleDialStatusCallback(req: Request, res: Response): Promise<void> {
  const dialCallStatus = (req.body as Record<string, string>)["DialCallStatus"] ?? "";
  const withAiFallback = req.query["with_ai_fallback"] === "true";
  const projectId = (req.query["project_id"] as string) ?? "";
  const callerPhone = (req.query["caller_phone"] as string) ?? "";
  const callSid = (req.query["call_sid"] as string) ?? "";

  logger.info("dial status callback", { project_id: projectId, dial_call_status: dialCallStatus, with_ai_fallback: withAiFallback });

  if (dialCallStatus === "completed" || !withAiFallback) {
    // The owner answered, or this mode never wanted an AI fallback on no-answer.
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    return;
  }

  const engineHost = process.env.ENGINE_HOST ?? req.get("host") ?? "localhost:8080";
  const wsProtocol = process.env.ENGINE_HOST ? "wss" : "ws";
  const httpProtocol = process.env.ENGINE_HOST ? "https" : "http";

  // Recording was already started in the initial webhook response, before
  // the <Dial> — don't start a second one here.
  const twiml = buildAiConnectTwiml({
    engineHost, wsProtocol, httpProtocol, projectId, callerPhone, callSid, includeRecording: false,
  });
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
  let session: VoiceSession | null = null;

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

      const callbacks = {
        sendAudio: (audio: string, format: AudioFormat = "pcm24") => {
          if (!capturedStreamSid || ws.readyState !== WS.OPEN) return;
          ws.send(JSON.stringify({
            event: "media",
            streamSid: capturedStreamSid,
            media: { payload: format === "mulaw8" ? audio : openAIAudioToTwilio(audio) },
          }));
        },
        sendJson: (obj: unknown) => {
          const typed = obj as Record<string, unknown>;
          if (typed?.["type"]) logger.debug("engine event to Twilio", { type: typed["type"] });
        },
        sendMark: (name: string) => {
          if (!capturedStreamSid || ws.readyState !== WS.OPEN) return;
          ws.send(JSON.stringify({ event: "mark", streamSid: capturedStreamSid, mark: { name } }));
        },
        endCall: () => {
          logger.info("end_call: closing Twilio WS");
          if (ws.readyState === WS.OPEN) ws.close();
        },
      };

      try {
        const started = await startCallSession(projectId, callerPhone, callSid, callbacks);
        session = started;
        if (ws.readyState !== WS.OPEN) {
          // The caller hung up while the session was starting.
          await started.end().catch((e) => logger.error("session.end error", { err: e }));
        }
      } catch (e) {
        logger.error("session.start error", { err: e });
        ws.close();
      }
      return;
    }

    if (event === "media") {
      if (!session) return;
      const payload = (msg["media"] as Record<string, string>)["payload"];
      session.handleClientAudio(session.audioFormat === "mulaw8" ? payload : twilioAudioToOpenAI(payload));
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
