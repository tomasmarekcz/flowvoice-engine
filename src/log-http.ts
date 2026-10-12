import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { runWithLogContext } from "./log/context";

type Handler = (req: Request, res: Response) => Promise<void>;

/** Run an Express handler inside a log context so every line carries request id, project and Twilio call sid. */
export function inLogContext(handler: Handler): Handler {
  return (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    return runWithLogContext(
      {
        request_id: randomUUID(),
        project_id: (query["project_id"] as string) || body["project_id"] || null,
        call_sid: body["CallSid"] || (query["call_sid"] as string) || null,
      },
      () => handler(req, res)
    );
  };
}
