import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// src/prompts/core.ts is a verbatim copy of the dashboard's src/lib/prompts/core.ts (LEA-63).
// When both repositories are checked out side by side, the copies must stay identical.
const dashboardCore = path.resolve(__dirname, "../../flowvoice/src/lib/prompts/core.ts");
const dashboardWorktree = path.resolve(__dirname, "../../flowvoice-lea63/src/lib/prompts/core.ts");
const other = [dashboardCore, dashboardWorktree].find((p) => existsSync(p));

describe("prompt core parity", () => {
  it.skipIf(!other)("is identical to the dashboard copy", () => {
    const mine = readFileSync(path.resolve(__dirname, "../src/prompts/core.ts"), "utf8");
    expect(mine).toBe(readFileSync(other!, "utf8"));
  });
});
