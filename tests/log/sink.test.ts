import { describe, it, expect, vi } from "vitest";
import { CloudWatchSink, type CloudWatchTransport } from "../../src/log/sink";

type Put = { group: string; stream: string; events: { timestamp: number; message: string }[] };

function fakeTransport(overrides: Partial<CloudWatchTransport> = {}) {
  const puts: Put[] = [];
  const state = { ensured: 0 };
  const transport: CloudWatchTransport = {
    async ensureStream() { state.ensured++; },
    async put(group, stream, events) { puts.push({ group, stream, events }); },
    ...overrides,
  };
  return { puts, state, transport };
}

function makeSink(t: CloudWatchTransport, extra: Record<string, unknown> = {}) {
  let nowMs = 1_000_000;
  const errors: string[] = [];
  const sink = new CloudWatchSink({
    group: "/leadoro/test/engine", stream: "s1", transport: t,
    now: () => nowMs, onError: (m) => errors.push(m), ...extra,
  });
  return { sink, errors, advance: (ms: number) => { nowMs += ms; } };
}

describe("CloudWatchSink", () => {
  it("sends queued events in one ordered batch and creates the stream once", async () => {
    const { puts, state, transport } = fakeTransport();
    const { sink } = makeSink(transport);
    sink.push({ message: "a" });
    sink.push({ message: "b" });
    await sink.flush();
    sink.push({ message: "c" });
    await sink.flush();
    expect(state.ensured).toBe(1);
    expect(puts).toHaveLength(2);
    expect(puts[0].events.map((e) => JSON.parse(e.message).message)).toEqual(["a", "b"]);
    expect(puts[0].group).toBe("/leadoro/test/engine");
  });

  it("flushes automatically when a full batch is queued", async () => {
    const { puts, transport } = fakeTransport();
    const { sink } = makeSink(transport, { maxBatchEvents: 3 });
    for (let i = 0; i < 3; i++) sink.push({ message: String(i) });
    await sink.flush();
    expect(puts.flatMap((p) => p.events)).toHaveLength(3);
  });

  it("never throws or rejects when CloudWatch fails, and reports at most once a minute", async () => {
    const { transport } = fakeTransport({ async put() { throw new Error("throttled"); } });
    const { sink, errors, advance } = makeSink(transport);
    sink.push({ message: "a" });
    await expect(sink.flush()).resolves.toBeUndefined();
    advance(31_000); // past the back-off
    sink.push({ message: "b" });
    await sink.flush();
    expect(errors).toHaveLength(1);
  });

  it("backs off after a failure instead of hammering AWS", async () => {
    const put = vi.fn().mockRejectedValue(new Error("down"));
    const { transport } = fakeTransport({ put });
    const { sink } = makeSink(transport);
    sink.push({ message: "a" });
    await sink.flush();
    sink.push({ message: "b" });
    await sink.flush();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("recreates the stream and retries once on ResourceNotFoundException", async () => {
    let first = true;
    const { puts, state, transport } = fakeTransport({
      async put(group, stream, events) {
        if (first) { first = false; const e = new Error("gone"); e.name = "ResourceNotFoundException"; throw e; }
        puts.push({ group, stream, events });
      },
    });
    const { sink } = makeSink(transport);
    sink.push({ message: "a" });
    await sink.flush();
    expect(state.ensured).toBe(2);
    expect(puts).toHaveLength(1);
  });

  it("drops the oldest events when the queue is full", async () => {
    const { puts, transport } = fakeTransport();
    const { sink } = makeSink(transport, { maxQueue: 3, maxBatchEvents: 1000, maxPerMinute: 1000 });
    for (let i = 0; i < 5; i++) sink.push({ message: String(i) });
    await sink.flush();
    const sent = puts.flatMap((p) => p.events).map((e) => JSON.parse(e.message).message);
    expect(sent).toEqual(["2", "3", "4"]);
  });

  it("caps events per minute and reports the drop in the next minute", async () => {
    const { puts, transport } = fakeTransport();
    const { sink, advance } = makeSink(transport, { maxPerMinute: 2, maxBatchEvents: 1000 });
    for (let i = 0; i < 5; i++) sink.push({ service: "engine", message: `m${i}` });
    advance(61_000);
    sink.push({ service: "engine", message: "later" });
    await sink.flush();
    const sent = puts.flatMap((p) => p.events).map((e) => JSON.parse(e.message));
    expect(sent.map((e) => e.message)).toEqual(["m0", "m1", "log rate limit hit, events dropped", "later"]);
    expect(sent[2].data).toEqual({ dropped: 3 });
  });

  it("push never throws, even for values JSON cannot serialize", () => {
    const { transport } = fakeTransport();
    const { sink } = makeSink(transport);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sink.push(circular)).not.toThrow();
  });
});
