import WebSocket from "ws";

export const cfg = {
  base: process.env.STAGING_BASE_URL ?? "",
  supabaseUrl: process.env.STAGING_SUPABASE_URL ?? "",
  serviceKey: process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY ?? "",
  projectId: process.env.STAGING_PROJECT_ID ?? "",
  twilioToken: process.env.STAGING_TWILIO_AUTH_TOKEN ?? "",
  internalSecret: process.env.STAGING_ENGINE_INTERNAL_SECRET ?? "",
};

// Staging mirrors production: Twilio signature checking is OFF there today (LEA-59). Set
// STAGING_TWILIO_VALIDATION=on once it is switched on; the signed-webhook scenario then needs the token.
export const validationOn = process.env.STAGING_TWILIO_VALIDATION === "on";

export const configured =
  [cfg.base, cfg.supabaseUrl, cfg.serviceKey, cfg.projectId, cfg.internalSecret].every(Boolean) &&
  (!validationOn || !!cfg.twilioToken);

const sbHeaders = () => ({ apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` });

export async function supabaseGet<T = unknown>(path: string): Promise<T[]> {
  const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase GET ${path} -> ${r.status}`);
  return (await r.json()) as T[];
}

export async function supabaseDelete(path: string): Promise<void> {
  await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { method: "DELETE", headers: sbHeaders() });
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 1500
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Plays a Twilio Media Streams call against the staging engine: connect, start, then stream the
// "caller" (silence, 20 ms frames in real time, exactly like Twilio does from the first second)
// until the assistant's first audio (its greeting) arrives, keep going briefly, and stop.
export async function simulateCall(opts: {
  callSid: string;
  callerPhone: string;
}): Promise<{ firstAudioMs: number | null }> {
  const wsUrl = cfg.base.replace(/^http/, "ws") + "/ws/twilio";
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });

  const t0 = Date.now();
  let firstAudioMs: number | null = null;
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.event === "media" && firstAudioMs === null) firstAudioMs = Date.now() - t0;
    } catch {
      /* ignore */
    }
  });

  const streamSid = `MZ${opts.callSid}`;
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid,
      start: {
        streamSid,
        callSid: opts.callSid,
        customParameters: {
          project_id: cfg.projectId,
          caller_phone: opts.callerPhone,
          call_sid: opts.callSid,
        },
      },
    })
  );

  const silence = Buffer.alloc(160, 0xff).toString("base64"); // 20 ms of mu-law silence
  const frames = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence } }));
    }
  }, 20);

  try {
    await waitFor(async () => firstAudioMs !== null, 25_000, 250);
    await new Promise((r) => setTimeout(r, 1_500)); // let the greeting play a moment
  } finally {
    clearInterval(frames);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "stop", streamSid }));
    await new Promise((r) => setTimeout(r, 500));
    ws.close();
  }
  return { firstAudioMs };
}
