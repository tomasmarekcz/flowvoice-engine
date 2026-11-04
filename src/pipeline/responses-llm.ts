// LEA-165: the thinking part of the Pipeline engine: the OpenAI Responses API, streamed. The same function tools as the
// Realtime engines use (name, description, parameters), so the tool code does not change.
import type { OpenAITool } from "../prompt";

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  | { type: "usage"; inputTokens: number; cachedInputTokens: number; outputTokens: number };

export interface LlmRequest {
  model: string;
  /** Reasoning effort ("low" is the default: follows the rules better than "none" and the answer still starts fast). Empty = leave to the model. */
  effort: string;
  instructions: string;
  /** The conversation so far, in Responses API input items. */
  input: unknown[];
  tools: OpenAITool[];
  signal: AbortSignal;
}

export type LlmStream = (request: LlmRequest) => AsyncIterable<LlmEvent>;

export const responsesLlm: LlmStream = async function* (request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      stream: true,
      store: false,
      instructions: request.instructions,
      input: request.input,
      ...(request.tools.length > 0 ? { tools: request.tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Responses API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      const type = event["type"];
      if (type === "response.output_text.delta") {
        yield { type: "text", delta: String(event["delta"] ?? "") };
      } else if (type === "response.output_item.done") {
        const item = event["item"] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "function_call" && item.call_id && item.name) {
          yield { type: "tool_call", callId: item.call_id, name: item.name, arguments: item.arguments ?? "{}" };
        }
      } else if (type === "response.completed") {
        const usage = (event["response"] as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | undefined)?.usage;
        yield { type: "usage", inputTokens: usage?.input_tokens ?? 0, cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 };
      } else if (type === "response.failed" || type === "error") {
        throw new Error(`Responses API: ${JSON.stringify(event).slice(0, 200)}`);
      }
    }
  }
};
