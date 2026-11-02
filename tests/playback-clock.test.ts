import { describe, it, expect } from "vitest";
import { PlaybackClock } from "../src/playback-clock";
import { InputBuffer } from "../src/input-buffer";

function clock() {
  let now = 1_000_000;
  return { c: new PlaybackClock(() => now), advance: (ms: number) => { now += ms; } };
}

describe("PlaybackClock", () => {
  it("is not audible before any speech", () => {
    const { c } = clock();
    expect(c.audible()).toBe(false);
    expect(c.playing()).toBeNull();
  });

  it("stays audible while queued speech is left, although all of it was generated at once", () => {
    const { c, advance } = clock();
    c.audio("item_a", 8000); // 8 s of speech generated in a burst
    advance(1000);
    expect(c.audible()).toBe(true);
    expect(c.remainingMs()).toBe(7000);
    advance(6900);
    expect(c.audible()).toBe(false); // only 100 ms left: inside the margin
  });

  it("tells how much of the current item the caller heard", () => {
    const { c, advance } = clock();
    c.audio("item_a", 8000);
    advance(2300);
    expect(c.playing()).toEqual({ itemId: "item_a", playedMs: 2300 });
  });

  it("never reports more than was generated", () => {
    const { c, advance } = clock();
    c.audio("item_a", 1000);
    advance(5000);
    expect(c.playing()).toEqual({ itemId: "item_a", playedMs: 1000 });
  });

  it("adds chunks of the same item together", () => {
    const { c, advance } = clock();
    c.audio("item_a", 400);
    c.audio("item_a", 400);
    c.audio("item_a", 400);
    advance(900);
    expect(c.playing()).toEqual({ itemId: "item_a", playedMs: 900 });
    expect(c.remainingMs()).toBe(300);
  });

  it("queues a second item behind the first: it has not started playing yet", () => {
    const { c, advance } = clock();
    c.audio("item_a", 3000);
    c.audio("item_b", 3000); // starts to play 3 s from now
    advance(1000);
    expect(c.playing()).toEqual({ itemId: "item_a", playedMs: 1000 });
    advance(3000);
    expect(c.playing()).toEqual({ itemId: "item_b", playedMs: 1000 });
  });

  it("forgets everything when the phone line's queue is cleared", () => {
    const { c, advance } = clock();
    c.audio("item_a", 8000);
    advance(500);
    c.clear();
    expect(c.audible()).toBe(false);
    expect(c.playing()).toBeNull();
    c.audio("item_c", 1000);
    expect(c.playing()).toEqual({ itemId: "item_c", playedMs: 0 });
  });
});

describe("InputBuffer", () => {
  it("returns the frames in order and is empty afterwards", () => {
    const b = new InputBuffer();
    b.push("a"); b.push("b");
    expect(b.drain()).toEqual(["a", "b"]);
    expect(b.size).toBe(0);
    expect(b.drain()).toEqual([]);
  });

  it("keeps only the newest frames when it overflows", () => {
    const b = new InputBuffer(3);
    for (const f of ["1", "2", "3", "4", "5"]) b.push(f);
    expect(b.drain()).toEqual(["3", "4", "5"]);
  });
});
