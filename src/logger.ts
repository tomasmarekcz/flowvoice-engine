type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): Level {
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function truncate(val: unknown, maxLen = 200): unknown {
  if (typeof val === "string" && val.length > maxLen) return val.slice(0, maxLen) + "...";
  return val;
}

function sanitizeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === "err" || k === "error") {
      out["error"] = v instanceof Error ? v.message : String(v);
      if (v instanceof Error && v.stack) out["stack"] = v.stack.split("\n").slice(0, 5).join("\n");
    } else {
      out[k] = truncate(v);
    }
  }
  return out;
}

function emit(level: Level, message: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel()]) return;

  if (process.env.NODE_ENV !== "production") {
    const prefix = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level];
    const extra = ctx ? " " + JSON.stringify(sanitizeContext(ctx)) : "";
    process.stdout.write(`${prefix} [${level.toUpperCase()}] ${message}${extra}\n`);
    return;
  }

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(ctx ? sanitizeContext(ctx) : {}),
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (message: string, ctx?: Record<string, unknown>) => emit("debug", message, ctx),
  info:  (message: string, ctx?: Record<string, unknown>) => emit("info",  message, ctx),
  warn:  (message: string, ctx?: Record<string, unknown>) => emit("warn",  message, ctx),
  error: (message: string, ctx?: Record<string, unknown>) => emit("error", message, ctx),
};
