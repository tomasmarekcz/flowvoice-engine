import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, sinkFromEnv } from "../../src/log/logger";
import { runWithLogContext } from "../../src/log/context";
import type { CloudWatchSink } from "../../src/log/sink";

function setup(env = "production") {
  vi.stubEnv("NODE_ENV", env);
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  const push = vi.fn();
  const logger = createLogger({ service: "dashboard", sink: { push } as unknown as CloudWatchSink });
  return { lines, push, logger };
}

describe("logger", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("writes one JSON line and pushes the same event to the sink", () => {
    const { lines, push, logger } = setup();
    logger.info("hello", { event: "x.y", detail: "v" });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ level: "info", service: "dashboard", message: "hello", event: "x.y", detail: "v" });
    expect(typeof parsed.ts).toBe("string");
    expect(push).toHaveBeenCalledWith(parsed);
  });

  it("adds the active log context and lets explicit fields win", () => {
    const { lines, logger } = setup();
    runWithLogContext({ project_id: "p1", call_id: "c1", request_id: "r1" }, () => {
      logger.info("ctx", { call_id: "override" });
    });
    expect(JSON.parse(lines[0])).toMatchObject({ project_id: "p1", call_id: "override", request_id: "r1" });
  });

  it("masks phones and secrets before writing anywhere", () => {
    const { lines, push, logger } = setup();
    logger.info("call from +420721071534", { caller: "+420721071534", api_key: "sk-1" });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).toBe("call from +420 *** *** 534");
    expect(parsed.caller).toBe("+420 *** *** 534");
    expect(parsed.api_key).toBe("[redacted]");
    expect(JSON.stringify(push.mock.calls[0][0])).not.toContain("721071534");
  });

  it("flattens errors into error + stack", () => {
    const { lines, logger } = setup();
    logger.error("failed", { err: new Error("boom") });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("error");
    expect(parsed.error).toBe("boom");
    expect(typeof parsed.stack).toBe("string");
  });

  it("does not emit debug events in production", () => {
    const { lines, push, logger } = setup();
    logger.debug("quiet");
    expect(lines).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("never throws, even when the sink does", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger({ service: "dashboard", sink: { push: () => { throw new Error("sink down"); } } as unknown as CloudWatchSink });
    expect(() => logger.error("x", { err: new Error("y") })).not.toThrow();
  });

  it("uses a readable one-line format outside production", () => {
    const { lines, logger } = setup("development");
    logger.warn("careful", { a: 1 });
    expect(lines[0]).toContain("[WARN] careful");
    expect(lines[0]).toContain('"a":1');
  });
});

describe("sinkFromEnv", () => {
  it("is off unless LOG_SINK=cloudwatch", () => {
    expect(sinkFromEnv("engine", {})).toBeNull();
    expect(sinkFromEnv("engine", { LOG_SINK: "stdout" })).toBeNull();
  });

  it("derives the log group from APP_ENV and service", () => {
    const prod = sinkFromEnv("engine", { LOG_SINK: "cloudwatch", AWS_REGION: "eu-central-1" }) as unknown as { o: { group: string } };
    const staging = sinkFromEnv("dashboard", { LOG_SINK: "cloudwatch", APP_ENV: "staging" }) as unknown as { o: { group: string } };
    expect(prod.o.group).toBe("/leadoro/prod/engine");
    expect(staging.o.group).toBe("/leadoro/staging/dashboard");
  });
});
