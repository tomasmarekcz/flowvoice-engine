// What the engine is doing right now that a restart would interrupt (LEA-80).
// Kept in memory: a restart empties it, which is exactly the moment nothing is running any more.
// Only counts and ages are reported, never phone numbers.

export type ActivityKind = "call" | "test_call";
export type ActivityPhase = "starting" | "live" | "wrapping_up" | "dialing";

interface Entry {
  kind: ActivityKind;
  phase: ActivityPhase;
  projectId: string | null;
  startedAt: number;
  /** After this many ms the entry is forgotten, so a missed end() can never block a release forever. */
  maxAgeMs: number;
}

const MAX_AGE_MS = 2 * 3600_000;
// Ringing the owner lasts up to 20 s; Twilio's answer should arrive well within 90 s.
const DIAL_MAX_AGE_MS = 90_000;

const entries = new Map<number, Entry>();
const dials = new Map<string, number>();
let nextId = 1;

export interface ActivityHandle {
  setPhase(phase: ActivityPhase): void;
  end(): void;
}

export function beginActivity(kind: ActivityKind, projectId: string | null): ActivityHandle {
  const id = nextId++;
  const entry: Entry = { kind, phase: "starting", projectId, startedAt: Date.now(), maxAgeMs: MAX_AGE_MS };
  entries.set(id, entry);
  return {
    setPhase: (phase) => { entry.phase = phase; },
    end: () => { entries.delete(id); },
  };
}

/** A call that is ringing the owner: the engine is not in the call, but a restart would drop it. */
export function beginDial(callSid: string, projectId: string | null): void {
  endDial(callSid);
  const id = nextId++;
  entries.set(id, { kind: "call", phase: "dialing", projectId, startedAt: Date.now(), maxAgeMs: DIAL_MAX_AGE_MS });
  dials.set(callSid, id);
}

export function endDial(callSid: string): void {
  const id = dials.get(callSid);
  if (id !== undefined) entries.delete(id);
  dials.delete(callSid);
}

export interface ActivitySnapshot {
  active: number;
  calls: Array<{ kind: ActivityKind; phase: ActivityPhase; project_id: string | null; seconds: number }>;
}

export function snapshot(now: number = Date.now()): ActivitySnapshot {
  for (const [id, e] of entries) if (now - e.startedAt > e.maxAgeMs) entries.delete(id);
  const calls = [...entries.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((e) => ({ kind: e.kind, phase: e.phase, project_id: e.projectId, seconds: Math.round((now - e.startedAt) / 1000) }));
  return { active: calls.length, calls };
}

export function resetActivityForTests(): void {
  entries.clear();
  dials.clear();
}
