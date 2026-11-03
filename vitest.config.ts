import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: unit tests only (fast, no external deps)
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/staging/**"],
    testTimeout: 5000,
    // The webhook opens a connection to OpenAI ahead of the call (LEA-162); tests must not reach the network.
    env: { PREWARM: "off" },
  },
});
