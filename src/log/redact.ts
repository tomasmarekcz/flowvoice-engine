// Everything that goes into a log event passes through here: secrets are hidden,
// phone numbers masked, long values cut, and the whole event kept under a size cap.

const SECRET_KEY = /key|secret|token|password|authorization|cookie|credential/i;
const PHONE_KEY = /phone|caller|msisdn|^from$|^to$/i;
const PHONE_VALUE = /^\+?[\d\s()-]{7,}$/;
const PHONE_IN_TEXT = /\+\d[\d ()-]{7,}\d/g;

export const MAX_STRING = 2000;
export const MAX_EVENT_BYTES = 8192;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const KEEP_WHEN_SLIMMING = [
  "ts", "level", "service", "event", "message", "project_id", "call_id", "call_sid", "request_id", "user_id", "error",
] as const;

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return value;
  return `+${digits.slice(0, 3)} *** *** ${digits.slice(-3)}`;
}

function truncate(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…[truncated]" : value;
}

/** Mask phone numbers inside free text and cut it to MAX_STRING. */
export function redactText(value: string): string {
  return truncate(value.replace(PHONE_IN_TEXT, (m) => maskPhone(m)));
}

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    if (SECRET_KEY.test(key)) return "[redacted]";
    if (PHONE_KEY.test(key) && PHONE_VALUE.test(value.trim())) return maskPhone(value);
    return redactText(value);
  }
  if (value instanceof Error) return redactText(value.message);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[array]";
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(key, item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  return value;
}

export function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "err" || key === "error") {
      out.error = redactText(value instanceof Error ? value.message : String(value));
      if (value instanceof Error && value.stack) {
        out.stack = redactText(value.stack.split("\n").slice(0, 5).join("\n"));
      }
    } else {
      out[key] = redactValue(key, value, 0);
    }
  }
  return out;
}

/** Keep an event under MAX_EVENT_BYTES; if it is bigger, keep only the identifying fields. */
export function fitEvent(event: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(event);
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_EVENT_BYTES) return event;
  const slim: Record<string, unknown> = { truncated: true, dropped_bytes: bytes };
  for (const key of KEEP_WHEN_SLIMMING) {
    if (event[key] !== undefined) slim[key] = event[key];
  }
  return slim;
}
