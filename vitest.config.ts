import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default: unit tests only (fast, no external deps)
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/staging/**"],
    testTimeout: 5000,
  },
});
