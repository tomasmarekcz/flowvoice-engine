import { WebSocket } from "ws";
import { CallLogger, generateCallSummary } from "./call-logger";
import { loadAssistantSettings } from "./config";
import { buildPromptFromSettings, buildTools } from "./prompt";
import { executeTool } from "./tools";

export interface SessionCallbacks {
  sendAudio: (pcm24Base64: string) => void;
  sendJson: (obj: unknown) => void;
}

export class CallSession {
  private projectId: string | null;
  private callerPhone: string | null;
  private callbacks: SessionCallbacks;
  private openaiWs: WebSocket | null = null;
  private logger: CallLogger;
  private calendarProjectId = "admin-test";
  private ended = false;

  constructor(
    projectId: string | null,
    callerPhone: string | null,
    callbacks: SessionCallbacks
  ) {
    this.projectId = projectId;
    this.callerPhone = callerPhone;
    this.callbacks = callbacks;
    this.logger = new CallLogger(projectId);
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const [settings] = await Promise.all([
      loadAssistantSettings(this.projectId),
      this.logger.createCall(this.callerPhone),
    ]);

    this.calendarProjectId = settings?._calendar_project_id ?? "admin-test";

    const instructions = buildPromptFromSettings(settings);
    const tools = buildTools(settings);
    const voice = settings?.voice ?? "alloy";

    this.logger.openaiPayload = { model: "gpt-realtime", voice, instructions, tools };

    console.log(`[session] connecting to OpenAI (project: ${this.projectId ?? "none"})`);

    const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.openaiWs = openaiWs;

    openaiWs.on("open", () => {
      console.log("[session] OpenAI connected — sending session.update");
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
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 600,
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
        console.error("[session] handleOpenAIMessage error:", (e as Error).message)
      );
    });

    openaiWs.on("close", (code) => {
      console.log(`[session] OpenAI disconnected (code ${code})`);
      if (!this.ended) {
        this.callbacks.sendJson({ type: "error", message: `OpenAI disconnected (code ${code})` });
      }
    });

    openaiWs.on("error", (e) => {
      console.error("[session] OpenAI WS error:", e.message);
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
    console.log("[session] ending — generating summary");
    if (this.openaiWs?.readyState === WebSocket.OPEN) this.openaiWs.close();
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const { title, summary } = await generateCallSummary(apiKey, this.logger.transcript);
    await this.logger.finalizeCall(title, summary);
  }

  private async handleOpenAIMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = msg["type"] as string;
    if (type !== "response.output_audio.delta") console.log(`[session] ← ${type}`);

    this.logger.handleOpenAIEvent(msg);

    // Audio chunks go to sendAudio; everything else goes to sendJson for client UI
    if (type === "response.output_audio.delta") {
      this.callbacks.sendAudio(msg["delta"] as string);
      return;
    }

    this.callbacks.sendJson(msg);

    // Engine executes tool calls — browser/Twilio only shows UI indicators
    if (type === "response.function_call_arguments.done") {
      await this.executeToolCall(
        msg["name"] as string,
        msg["arguments"] as string,
        msg["call_id"] as string
      );
    }
  }

  private async executeToolCall(name: string, argsJson: string, callId: string): Promise<void> {
    console.log(`[session] executing tool: ${name}`);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson); } catch { /* invalid json from model */ }

    const result = await executeTool(name, args, this.projectId ?? "", this.calendarProjectId);

    // Notify client UI that tool is done
    this.callbacks.sendJson({ type: "engine.tool_done", name });

    // Send result back to OpenAI and trigger next response
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
