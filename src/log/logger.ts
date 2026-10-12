import { hostname } from "node:os";
import { getLogContext } from "./context";
import { fitEvent, redactContext, redactText } from "./redact";
import { CloudWatchSink } from "./sink";
import { createAwsTransport } from "./aws-transport";

export type Level = "debug" | "info" | "warn" | "error";
export type Logger = Record<Level, (message: string, ctx?: Record<string, unknown>) => void>;

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): Level {
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/** CloudWatch sink when LOG_SINK=cloudwatch; the log group follows APP_ENV (staging) and the service name. */
export function sinkFromEnv(service: string, env: Record<string, string | undefined> = process.env): CloudWatchSink | null {
  if (env.LOG_SINK !== "cloudwatch") return null;
  const group = env.LOG_GROUP ?? `/leadoro/${env.APP_ENV === "staging" ? "staging" : "prod"}/${service}`;
  const stream = `${service}/${new Date().toISOString().slice(0, 10)}/${hostname()}-${process.pid}`;
  const sink = new CloudWatchSink({
    group,
    stream,
    transport: createAwsTransport(env.AWS_REGION ?? "eu-central-1"),
  });
  sink.start();
  return sink;
}

function writeStdout(level: Level, event: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") {
    process.stdout.write(JSON.stringify(event) + "\n");
    return;
  }
  const rest = { ...event };
  delete rest.ts;
  delete rest.level;
  delete rest.service;
  delete rest.message;
  const prefix = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level];
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  process.stdout.write(`${prefix} [${level.toUpperCase()}] ${String(event.message)}${extra}\n`);
}

function withoutEmpty(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function createLogger(opts: { service: string; sink?: CloudWatchSink | null }): Logger {
  let sink: CloudWatchSink | null | undefined = opts.sink;
  const getSink = (): CloudWatchSink | null => {
    if (sink === undefined) {
      try { sink = sinkFromEnv(opts.service); } catch { sink = null; }
    }
    return sink;
  };

  function emit(level: Level, message: string, ctx?: Record<string, unknown>): void {
    try {
      if (LEVELS[level] < LEVELS[minLevel()]) return;
      const event = fitEvent({
        ts: new Date().toISOString(),
        level,
        service: opts.service,
        message: redactText(message),
        ...withoutEmpty(getLogContext() as Record<string, unknown>),
        ...(ctx ? redactContext(ctx) : {}),
      });
      writeStdout(level, event);
      getSink()?.push(event);
    } catch {
      /* logging must never throw */
    }
  }

  return {
    debug: (message, ctx) => emit("debug", message, ctx),
    info: (message, ctx) => emit("info", message, ctx),
    warn: (message, ctx) => emit("warn", message, ctx),
    error: (message, ctx) => emit("error", message, ctx),
  };
}
