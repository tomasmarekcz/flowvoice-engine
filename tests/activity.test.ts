import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({ settings: null as unknown, makeLive: null as unknown }));
vi.mock("../src/config", () => ({ loadAssistantSettings: async () => h.settings }));
vi.mock("../src/session", () => ({
  CallSession: class {
    constructor(public projectId: string | null) {}
    started = false;
    ended = 0;
    finalized: (() => void) | null = null;
    async start() { this.started = true; }
    end() { this.ended++; return new Promise<void>((r) => { this.finalized = r; }); }
  },
}));
vi.mock("../src/live-session", () => ({ LiveCallSession: class {} }));

const activity = await import("../src/activity");
const { startCallSession } = await import("../src/session-factory");
const { handleActiveCalls } = await import("../src/handlers/activity");

const cb = {} as never;

beforeEach(() => { activity.resetActivityForTests(); process.env.ENGINE_INTERNAL_SECRET = "s3cret"; h.settings = null; });
afterEach(() => vi.useRealTimers());

describe("activity registry", () => {
  it("lists what is running and how long, without phone numbers", () => {
    const a = activity.beginActivity("call", "proj-1");
    a.setPhase("live");
    const snap = activity.snapshot();
    expect(snap.active).toBe(1);
    expect(snap.calls[0]).toMatchObject({ kind: "call", phase: "live", project_id: "proj-1" });
    expect(Object.keys(snap.calls[0])).not.toContain("caller_phone");
    a.end();
    expect(activity.snapshot().active).toBe(0);
  });

  it("forgets an entry that never ended after 2 hours, so a leak cannot block a release forever", () => {
    vi.useFakeTimers();
    activity.beginActivity("call", "p");
    vi.advanceTimersByTime(2 * 3600_000 - 1000);
    expect(activity.snapshot().active).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(activity.snapshot().active).toBe(0);
  });

  it("counts a call that is ringing the owner until the dial result arrives or 90 seconds pass", () => {
    vi.useFakeTimers();
    activity.beginDial("CA1", "proj-1");
    expect(activity.snapshot().calls[0]).toMatchObject({ kind: "call", phase: "dialing" });
    activity.endDial("CA1");
    expect(activity.snapshot().active).toBe(0);
    activity.beginDial("CA2", "proj-1");
    vi.advanceTimersByTime(91_000);
    expect(activity.snapshot().active).toBe(0);
  });
});

describe("startCallSession registers the call until the summary and SMS are done", () => {
  it("counts a call from the moment it starts until end() has fully finished", async () => {
    const session = (await startCallSession("p1", "+420777", "CA1", cb)) as unknown as { end(): Promise<void>; finalized: () => void };
    expect(activity.snapshot()).toMatchObject({ active: 1, calls: [{ kind: "call", phase: "live" }] });

    const ending = session.end();
    expect(activity.snapshot().calls[0].phase).toBe("wrapping_up");
    expect(activity.snapshot().active).toBe(1); // summary / SMS still running

    session.finalized();
    await ending;
    expect(activity.snapshot().active).toBe(0);
  });

  it("a second end() waits for the same work instead of reporting 'done' early", async () => {
    const session = (await startCallSession("p1", "+420777", "CA1", cb)) as unknown as { end(): Promise<void>; finalized: () => void; ended: number };
    const first = session.end();
    const second = session.end();
    expect(second).toBe(first);
    expect(session.ended).toBe(1);
    session.finalized();
    await first;
  });

  it("calls without a Twilio call id are test calls", async () => {
    await startCallSession("p1", null, null, cb);
    expect(activity.snapshot().calls[0].kind).toBe("test_call");
  });

  it("does not leave an entry behind when the session fails to start", async () => {
    vi.resetModules();
    const bad = await import("../src/session-factory");
    const { CallSession } = await import("../src/session");
    CallSession.prototype.start = async () => { throw new Error("boom"); };
    await expect(bad.startCallSession("p1", null, "CA9", cb)).rejects.toThrow("boom");
    const fresh = await import("../src/activity");
    expect(fresh.snapshot().active).toBe(0);
  });
});

describe("GET /internal/active-calls", () => {
  const app = () => { const a = express(); a.get("/internal/active-calls", handleActiveCalls); return a; };

  it("needs the internal secret", async () => {
    expect((await request(app()).get("/internal/active-calls")).status).toBe(401);
    expect((await request(app()).get("/internal/active-calls").set("X-Internal-Secret", "nope")).status).toBe(401);
  });

  it("answers with the count and the list", async () => {
    activity.beginActivity("call", "proj-1");
    const res = await request(app()).get("/internal/active-calls").set("X-Internal-Secret", "s3cret");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: 1, calls: [{ kind: "call", project_id: "proj-1" }] });
  });

  it("refuses everybody when no secret is configured", async () => {
    delete process.env.ENGINE_INTERNAL_SECRET;
    expect((await request(app()).get("/internal/active-calls").set("X-Internal-Secret", "")).status).toBe(401);
  });
});
