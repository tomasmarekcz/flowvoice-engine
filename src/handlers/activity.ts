import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { snapshot } from "../activity";

function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET /internal/active-calls: what a release must not interrupt. Only reachable from the server itself (nginx does not proxy it) and needs the internal secret. */
export function handleActiveCalls(req: Request, res: Response): void {
  if (!secretMatches(req.get("x-internal-secret"), process.env.ENGINE_INTERNAL_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(snapshot());
}
