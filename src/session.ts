import { WebSocket } from "ws";
import { CallLogger, generateCallSummary, SmsOptions, TokenUsage, ZERO_TOKEN_USAGE } from "./call-logger";
import { loadAssistantSettings, AssistantSettings } from "./config";
import { logger } from "./logger";
import { buildPromptFromSettings, buildTools } from "./prompt";
import { executeTool } from "./tools";
import { sendSmsNotifications } from "./sms";

function formatOwnerSms(
  rawSummary: string,
  opts: { callerPhone: string | null; startMs: number; callId: string | null; lang: string | null }
): string {
  const isCs = opts.lang === "cs";
  const header = isCs ? "🆕 Nová konverzace" : "🆕 New conversation";
  const time = new Intl.DateTimeFormat(isCs ? "cs-CZ" : "en-US", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
  }).format(opts.startMs);
  const phoneLine = `📞 ${opts.callerPhone ?? (isCs ? "neznámé číslo" : "unknown number")} • ${time}`;

  const lines = [header, phoneLine, rawSummary];
  if (opts.callId) {
    const base = process.env.PUBLIC_APP_URL ?? "https://leadoro.io";
    lines.push(`🔗 ${base}/conversations/${opts.callId}`);
  }
  return lines.join("\n");
}

export interface SessionCallbacks {
  sendAudio: (pcm24Base64: string) => void;
  sendJson: (obj: unknown) => void;
  endCall: () => void;
}

export class CallSession {
  private projectId: string | null;
  private callerPhone: string | null;
  private twilioCallSid: string | null;
  private callbacks: SessionCallbacks;
  private openaiWs: WebSocket | null = null;
  private logger: CallLogger;
  private calendarProjectId = "admin-test";
  private ended = false;
  private settings: AssistantSettings | null = null;
  private usageAccum = {
    realtimeAudioIn: 0, realtimeAudioOut: 0,
    realtimeTextIn: 0,  realtimeTextOut: 0,
    searchEmbedding: 0,
  };

  constructor(
    projectId: string | null,
    callerPhone: string | null,
    twilioCallSid: string | null,
    callbacks: SessionCallbacks
  ) {
    this.projectId = projectId;
    this.callerPhone = callerPhone;
    this.twilioCallSid = twilioCallSid;
    this.callbacks = callbacks;
    this.logger = new CallLogger(projectId, twilioCallSid);
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const [settings] = await Promise.all([
      loadAssistantSettings(this.projectId),
      this.logger.createCall(this.callerPhone),
    ]);

    this.settings = settings;
    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";

    const instructions = buildPromptFromSettings(settings, this.callerPhone);
    const tools = buildTools(settings);
    const voice = settings?.voice ?? "alloy";

    this.logger.openaiPayload = { model: "gpt-realtime-2", voice, instructions, tools };

    logger.info("connecting to OpenAI", { project_id: this.projectId ?? "none" });

    const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.openaiWs = openaiWs;

    openaiWs.on("open", () => {
      logger.info("OpenAI connected, sending session.update");
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions,
          tools,
          tool_choice: tools.length > 0 ? "auto" : "none",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "gpt-4o-transcribe" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.8,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice },
          },
        },
      }));
      this.callbacks.sendJson({
        type: "proxy.connected",
        calendar_project_id: this.calendarProjectId,
        call_id: this.logger.callId,
      });
    });

    openaiWs.on("message", (data) => {
      this.handleOpenAIMessage(data.toString()).catch((e) =>
        logger.error("handleOpenAIMessage error", { err: e })
      );
    });

    openaiWs.on("close", (code) => {
      logger.warn("OpenAI disconnected", { code });
      if (!this.ended) {
        this.callbacks.sendJson({ type: "error", message: `OpenAI disconnected (code ${code})` });
      }
    });

    openaiWs.on("error", (e) => {
      logger.error("OpenAI WS error", { err: e });
      this.callbacks.sendJson({ type: "error", message: `OpenAI error: ${e.message}` });
    });
  }

  handleClientAudio(pcm24Base64: string): void {
    if (this.openaiWs?.readyState !== WebSocket.OPEN) return;
    this.openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24Base64 }));
  }

  handleClientEvent(msg: Record<string, unknown>): void {
    if (this.openaiWs?.readyState !== WebSocket.OPEN) return;
    this.openaiWs.send(JSON.stringify(msg));
    this.logger.handleClientEvent(msg);
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    logger.info("session ending, generating summary");
    if (this.openaiWs?.readyState === WebSocket.OPEN) this.openaiWs.close();
    const apiKey = process.env.OPENAI_API_KEY ?? "";

    const smsOptions: SmsOptions | undefined = this.settings
      ? {
          smsOwnerEnabled: this.settings.sms_owner_enabled ?? false,
          smsCallerEnabled: this.settings.sms_caller_enabled ?? false,
          smsOwnerInstructions: this.settings.sms_owner_instructions ?? null,
          smsCallerInstructions: this.settings.sms_caller_instructions ?? null,
          emailOwnerEnabled: this.settings.email_owner_enabled ?? false,
        }
      : undefined;

    const { title, summary, ownerSms, callerSms, emailOwner, summaryInputTokens, summaryOutputTokens } =
      await generateCallSummary(apiKey, this.logger.transcript, smsOptions, this.settings?._project_language ?? null);

    const ownerSmsFinal = ownerSms
      ? formatOwnerSms(ownerSms, {
          callerPhone: this.callerPhone,
          startMs: this.logger.callStartMs,
          callId: this.logger.callId,
          lang: this.settings?._project_language ?? null,
        })
      : null;

    const { ownerSent, callerSent } = await sendSmsNotifications({
      ownerSms: ownerSmsFinal,
      ownerPhone: this.settings?.owner_phone ?? null,
      callerSms,
      callerPhone: this.callerPhone,
    });

    const tokenUsage: TokenUsage = {
      realtimeAudioIn:  this.usageAccum.realtimeAudioIn,
      realtimeAudioOut: this.usageAccum.realtimeAudioOut,
      realtimeTextIn:   this.usageAccum.realtimeTextIn,
      realtimeTextOut:  this.usageAccum.realtimeTextOut,
      summaryIn:        summaryInputTokens,
      summaryOut:       summaryOutputTokens,
      searchEmbedding:  this.usageAccum.searchEmbedding,
    };

    await this.logger.finalizeCall(title, summary, ownerSent, callerSent, ownerSmsFinal, callerSms, emailOwner, tokenUsage);

    // Send email notification if enabled
    if (this.settings?.email_owner_enabled && emailOwner && this.logger.callId) {
      const base = process.env.FRONTEND_API_URL ?? "http://localhost:3000";
      fetch(`${base}/api/notify/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: this.logger.callId,
          project_id: this.projectId,
          email_body: emailOwner,
          caller_phone: this.callerPhone,
          ai_title: title,
          duration_seconds: this.logger.callDurationSeconds,
        }),
      }).catch((e) => logger.error("notify/call error", { err: e }));
    }
  }

  private async handleOpenAIMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = msg["type"] as string;

    if (type === "error") {
      logger.error("OpenAI error event", { detail: JSON.stringify(msg) });
    } else if (type !== "response.output_audio.delta") {
      logger.debug("← openai event", { type });
    }

    if (type === "response.done") {
      const response = msg["response"] as Record<string, unknown> | undefined;
      const usage = response?.["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const inDet  = usage["input_token_details"]  as Record<string, number> | undefined;
        const outDet = usage["output_token_details"] as Record<string, number> | undefined;
        this.usageAccum.realtimeAudioIn  += inDet?.["audio_tokens"]  ?? 0;
        this.usageAccum.realtimeAudioOut += outDet?.["audio_tokens"] ?? 0;
        this.usageAccum.realtimeTextIn   += inDet?.["text_tokens"]   ?? 0;
        this.usageAccum.realtimeTextOut  += outDet?.["text_tokens"]  ?? 0;
      }
    }

    if (type === "session.updated" && this.settings?.greeting_enabled && this.settings?.greeting_message?.trim()) {
      logger.info("triggering greeting response");
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    }

    this.logger.handleOpenAIEvent(msg);

    if (type === "response.output_audio.delta") {
      this.callbacks.sendAudio(msg["delta"] as string);
      return;
    }

    this.callbacks.sendJson(msg);

    if (type === "response.function_call_arguments.done") {
      await this.executeToolCall(
        msg["name"] as string,
        msg["arguments"] as string,
        msg["call_id"] as string
      );
    }
  }

  private async executeToolCall(name: string, argsJson: string, callId: string): Promise<void> {
    logger.info("executing tool", { name });
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson); } catch { /* invalid json from model */ }

    // end_call is handled entirely in the engine — no external API call needed
    if (name === "end_call") {
      const reason = (args["reason"] as string) ?? "conversation complete";
      logger.info("end_call requested", { reason });
      const toolResultMsg = {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ status: "ok" }) },
      };
      this.logger.handleClientEvent(toolResultMsg);
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.send(JSON.stringify(toolResultMsg));
        // No response.create — AI should not speak after hanging up
      }
      this.callbacks.sendJson({ type: "engine.tool_done", name });
      // End session (generates summary) then close the call connection
      this.end().catch((e) => logger.error("end_call session.end error", { err: e }));
      setTimeout(() => this.callbacks.endCall(), 300);
      return;
    }

    const t0 = Date.now();
    const knowledgeTopN = this.settings?.knowledge_top_n ?? 5;
    const { result, embeddingTokens } = await executeTool(name, args, this.projectId ?? "", this.calendarProjectId, this.logger.callId ?? undefined, knowledgeTopN, this.callerPhone);
    this.usageAccum.searchEmbedding += embeddingTokens;
    logger.info("tool executed", { name, duration_ms: Date.now() - t0 });

    this.callbacks.sendJson({ type: "engine.tool_done", name });

    const toolResultMsg = {
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    };
    this.logger.handleClientEvent(toolResultMsg);
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(toolResultMsg));
      this.openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
  }
}
