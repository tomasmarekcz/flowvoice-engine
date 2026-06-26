import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    consoleSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  it("outputs valid JSON in production", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.info("test message", { key: "value" });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("test message");
    expect(parsed.key).toBe("value");
    expect(typeof parsed.ts).toBe("string");
  });

  it("includes error message when error is passed", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    const err = new Error("something broke");
    logger.error("operation failed", { err });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("error");
    expect(parsed.error).toBe("something broke");
  });

  it("truncates strings longer than 200 chars", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.info("msg", { big: "x".repeat(300) });
    const output = (consoleSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(output.trim());
    expect((parsed.big as string).length).toBeLessThanOrEqual(203);
  });

  it("does not log debug in production", async () => {
    process.env.NODE_ENV = "production";
    const { logger } = await import("../src/logger");
    logger.debug("verbose detail");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs debug in development", async () => {
    process.env.NODE_ENV = "development";
    const { logger } = await import("../src/logger");
    logger.debug("dev detail");
    expect(consoleSpy).toHaveBeenCalled();
  });
});
