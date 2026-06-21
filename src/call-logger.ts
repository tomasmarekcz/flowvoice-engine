import { getSupabaseUrl, getSupabaseHeaders } from "./config";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp_ms: number;
}

interface ToolCallEntry {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
  timestamp_ms: number;
}

interface PendingToolCall {
  name: string;
  args: Record<string, unknown>;
  startMs: number;
}

export class CallLogger {
  callId: string | null = null;
  transcript: TranscriptEntry[] = [];
  openaiPayload: unknown = null;

  private projectId: string | null;
  private seq = 0;
  private startMs = Date.now();
  private toolCalls: ToolCallEntry[] = [];
  private pending: Record<string, PendingToolCall> = {};

  private get enabled(): boolean {
    try { getSupabaseUrl(); getSupabaseHeaders(); return !!this.projectId; }
    catch { return false; }
  }

  constructor(projectId: string | null) {
    this.projectId = projectId;
  }

  async createCall(callerPhone: string | null): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${getSupabaseUrl()}/rest/v1/calls`, {
        method: "POST",
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          project_id: this.projectId,
          caller_phone: callerPhone ?? null,
          started_at: new Date(this.startMs).toISOString(),
          status: "new",
          transcript: [],
          tool_calls: [],
        }),
      });
      const rows = (await res.json()) as Array<{ id: string }>;
      this.callId = rows?.[0]?.id ?? null;
      if (this.callId) console.log(`[logger] call created: ${this.callId}`);
      else console.warn("[logger] createCall: no id returned", rows);
    } catch (e) {
      console.error("[logger] createCall error:", (e as Error).message);
    }
  }

  logEvent(eventType: string, direction: string, payload: unknown): void {
    if (!this.enabled || !this.callId) return;
    fetch(`${getSupabaseUrl()}/rest/v1/call_events`, {
      method: "POST",
      headers: { ...getSupabaseHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        call_id: this.callId,
        project_id: this.projectId,
        seq: this.seq++,
        timestamp_ms: Date.now(),
        event_type: eventType,
        direction,
        payload,
      }),
    }).catch((e: Error) => console.error("[logger] logEvent error:", e.message));
  }

  handleOpenAIEvent(msg: Record<string, unknown>): void {
    const t = msg["type"] as string;
    if (
      t === "response.output_audio.delta" ||
      t === "response.output_audio_transcript.delta" ||
      t === "input_audio_buffer.speech_started" ||
      t === "input_audio_buffer.speech_stopped"
    ) return;

    if (t === "response.output_audio_transcript.done" && msg["transcript"]) {
      this.transcript.push({ role: "assistant", text: msg["transcript"] as string, timestamp_ms: Date.now() });
      this.logEvent(t, "inbound", { transcript: msg["transcript"] });
      return;
    }
    if (t === "conversation.item.input_audio_transcription.completed" && msg["transcript"]) {
      this.transcript.push({ role: "user", text: msg["transcript"] as string, timestamp_ms: Date.now() });
      this.logEvent(t, "inbound", { transcript: msg["transcript"] });
      return;
    }
    if (t === "response.function_call_arguments.done") {
      try {
        this.pending[msg["call_id"] as string] = {
          name: msg["name"] as string,
          args: JSON.parse((msg["arguments"] as string) ?? "{}"),
          startMs: Date.now(),
        };
      } catch { /* ignore parse errors */ }
      this.logEvent(t, "inbound", { name: msg["name"], call_id: msg["call_id"], arguments: msg["arguments"] });
      return;
    }
    if (t === "session.created" || t === "session.updated") {
      this.logEvent(t, "inbound", { model: (msg["session"] as Record<string, unknown>)?.["model"] });
      return;
    }
    if (t === "error") this.logEvent(t, "inbound", msg);
  }

  handleClientEvent(msg: Record<string, unknown>): void {
    const t = msg["type"] as string;
    if (t === "input_audio_buffer.append") return;
    if (
      t === "conversation.item.create" &&
      (msg["item"] as Record<string, unknown>)?.["type"] === "function_call_output"
    ) {
      const item = msg["item"] as Record<string, unknown>;
      const callId = item["call_id"] as string;
      const pending = this.pending[callId];
      if (pending) {
        let result: unknown;
        try { result = JSON.parse(item["output"] as string); }
        catch { result = item["output"]; }
        this.toolCalls.push({
          name: pending.name,
          args: pending.args,
          result,
          duration_ms: Date.now() - pending.startMs,
          timestamp_ms: pending.startMs,
        });
        delete this.pending[callId];
      }
    }
  }

  async finalizeCall(aiTitle: string | null, aiSummary: string | null): Promise<void> {
    if (!this.enabled || !this.callId) return;
    const endMs = Date.now();
    this.logEvent("call.ended", "system", {
      duration_seconds: Math.round((endMs - this.startMs) / 1000),
      transcript_turns: this.transcript.length,
      tool_calls_count: this.toolCalls.length,
    });
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fetch(`${getSupabaseUrl()}/rest/v1/calls?id=eq.${this.callId}`, {
        method: "PATCH",
        headers: { ...getSupabaseHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({
          ended_at: new Date(endMs).toISOString(),
          duration_seconds: Math.round((endMs - this.startMs) / 1000),
          transcript: this.transcript,
          tool_calls: this.toolCalls,
          ai_title: aiTitle ?? null,
          ai_summary: aiSummary ?? null,
          openai_payload: this.openaiPayload ?? null,
        }),
      });
      console.log(`[logger] call finalized: ${this.callId} (${Math.round((endMs - this.startMs) / 1000)}s, ${this.transcript.length} turns)`);
    } catch (e) {
      console.error("[logger] finalizeCall error:", (e as Error).message);
    }
  }
}

export async function generateCallSummary(
  apiKey: string,
  transcript: TranscriptEntry[]
): Promise<{ title: string | null; summary: string | null }> {
  if (!apiKey || transcript.length === 0) return { title: null, summary: null };
  const lines = transcript
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.text}`)
    .join("\n");
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: 'Summarize this business phone call. Generate a short title (max 6 words) and a one-sentence summary. Match the language of the conversation. Respond ONLY as JSON: {"title": "...", "summary": "..."}',
          },
          { role: "user", content: lines.slice(0, 4000) },
        ],
        response_format: { type: "json_object" },
        max_tokens: 120,
      }),
    });
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { title?: string; summary?: string };
    return { title: parsed.title ?? null, summary: parsed.summary ?? null };
  } catch (e) {
    console.error("[logger] generateCallSummary error:", (e as Error).message);
    return { title: null, summary: null };
  }
}
