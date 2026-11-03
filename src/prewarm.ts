// LEA-162: opens the connection to OpenAI while Twilio is still setting up the audio stream, so the assistant can speak sooner.
// The webhook that decides "the assistant answers" calls prewarmCall; when the stream starts, the session factory takes the
// connection over (takePrewarmed). A connection nobody takes is closed after PREWARM_TTL_MS. Any problem simply means the
// call starts the normal way: nothing here may stop a call.
import { WebSocket } from "ws";
import { loadAssistantSettings, type AssistantSettings } from "./config";
import { logger } from "./logger";
import { LIVE_ENDPOINT } from "./live-protocol";
import { hybridBrainModel, standardModel } from "./models";
import type { PromptSnapshot } from "./prompts/core";
import { getSnapshot } from "./prompts/store";

export const PREWARM_TTL_MS = 10_000;

export interface Prewarmed {
  settings: AssistantSettings | null;
  snapshot: PromptSnapshot;
  /** An open (or still opening) connection for the engine the settings choose, or null (Pipeline, or it failed). */
  socket: WebSocket | null;
  engine: "standard" | "live" | "hybrid" | "pipeline";
  /** How long the connection has been ready before the stream took it over (for the log). */
  readyForMs: number;
}

interface Entry {
  work: Promise<Omit<Prewarmed, "readyForMs"> & { readyAt: number }>;
  timer: NodeJS.Timeout;
}

const entries = new Map<string, Entry>();

/** The address of the connection each engine opens first; Pipeline connects its own sockets at the start of the stream. */
function urlFor(engine: Prewarmed["engine"]): string | null {
  if (engine === "live") return LIVE_ENDPOINT;
  if (engine === "hybrid") return `wss://api.openai.com/v1/realtime?model=${hybridBrainModel()}`;
  if (engine === "standard") return `wss://api.openai.com/v1/realtime?model=${standardModel()}`;
  return null;
}

function discard(callSid: string, why: string): void {
  const entry = entries.get(callSid);
  if (!entry) return;
  clearTimeout(entry.timer);
  entries.delete(callSid);
  entry.work.then((w) => {
    if (w.socket) { try { w.socket.close(); } catch { /* already closed */ } }
    logger.info("prewarmed connection closed", { event: "prewarm.closed", why });
  }).catch(() => undefined);
}

/** Starts getting a call ready. Returns at once; `settings` is passed when the caller already has them. */
export function prewarmCall(opts: { callSid: string; projectId: string; settings?: AssistantSettings | null }): void {
  if (!opts.callSid || process.env.PREWARM === "off") return;
  discard(opts.callSid, "replaced"); // Twilio may call the webhook twice for one call
  const work = (async () => {
    const [settings, snapshot] = await Promise.all([
      opts.settings !== undefined ? opts.settings : loadAssistantSettings(opts.projectId),
      getSnapshot(),
    ]);
    const engine = settings?.voice_engine ?? "standard";
    const url = urlFor(engine);
    const apiKey = process.env.OPENAI_API_KEY;
    let socket: WebSocket | null = null;
    if (url && apiKey) {
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      socket.on("error", (e) => logger.warn("prewarmed connection error", { event: "prewarm.error", err: e }));
    }
    return { settings, snapshot, socket, engine, readyAt: Date.now() };
  })();
  work.catch((e) => logger.warn("prewarm failed", { event: "prewarm.failed", err: e }));
  const timer = setTimeout(() => discard(opts.callSid, "unclaimed"), PREWARM_TTL_MS);
  entries.set(opts.callSid, { work, timer });
}

/** Hands over what was prepared for this call (once), or null when nothing usable is there. */
export async function takePrewarmed(callSid: string | null): Promise<Prewarmed | null> {
  if (!callSid) return null;
  const entry = entries.get(callSid);
  if (!entry) return null;
  clearTimeout(entry.timer);
  entries.delete(callSid);
  try {
    const w = await entry.work;
    const socket = w.socket && (w.socket.readyState === WebSocket.OPEN || w.socket.readyState === WebSocket.CONNECTING) ? w.socket : null;
    const readyForMs = Date.now() - w.readyAt;
    logger.info("prewarmed call taken over", { event: "prewarm.used", engine: w.engine, socket: !!socket, ready_ms_before_stream: readyForMs });
    return { settings: w.settings, snapshot: w.snapshot, socket, engine: w.engine, readyForMs };
  } catch {
    return null;
  }
}

/** For tests. */
export function clearPrewarmed(): void {
  for (const sid of [...entries.keys()]) discard(sid, "cleared");
}
