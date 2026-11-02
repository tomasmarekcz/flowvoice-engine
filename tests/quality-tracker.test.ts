import { describe, it, expect } from "vitest";
import { CallQualityTracker, audioDurationMs, toolResultFailed } from "../src/quality-tracker";

function setup() {
  let now = 1_000_000;
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const tracker = new CallQualityTracker((type, payload) => events.push({ type, payload }), () => now);
  return {
    tracker,
    events,
    advance: (ms: number) => { now += ms; },
    types: () => events.map((e) => e.type),
  };
}

describe("audioDurationMs", () => {
  it("reads the length of a 24 kHz PCM16 chunk (48 bytes per ms)", () => {
    const b64 = Buffer.alloc(4800).toString("base64"); // 100 ms
    expect(audioDurationMs(b64, "pcm24")).toBeCloseTo(100, 5);
  });

  it("reads the length of a 8 kHz mu-law chunk (8 bytes per ms)", () => {
    const b64 = Buffer.alloc(160).toString("base64"); // 20 ms, base64 has padding
    expect(audioDurationMs(b64, "mulaw8")).toBeCloseTo(20, 5);
  });
});

describe("toolResultFailed", () => {
  it("is true only for a result with an error", () => {
    expect(toolResultFailed({ error: "boom" })).toBe(true);
    expect(toolResultFailed({ chunks: [] })).toBe(false);
    expect(toolResultFailed({ error: null })).toBe(false);
    expect(toolResultFailed(null)).toBe(false);
    expect(toolResultFailed("text")).toBe(false);
  });
});

describe("interruptions (Standard)", () => {
  it("counts a caller who speaks while the assistant is still audible", () => {
    const { tracker, advance, events } = setup();
    tracker.assistantAudio(3000); // 3 s of speech queued, streamed at once
    advance(1000);
    tracker.callerSpeechStarted();
    tracker.callerSpeechStopped();
    tracker.callerTranscribed("Počkejte prosím");
    const stats = tracker.finish();
    expect(stats.interruptions).toBe(1);
    expect(events).toEqual([{ type: "quality.interruption", payload: { assistant_remaining_ms: 2000 } }]);
  });

  it("does not count a caller who answers after the assistant has finished", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(1000);
    advance(1500);
    tracker.callerSpeechStarted();
    tracker.callerTranscribed("Dobrý den");
    expect(tracker.finish().interruptions).toBe(0);
  });

  it("does not count the last 200 ms of the assistant's audio as being talked over", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(1000);
    advance(850);
    tracker.callerSpeechStarted();
    tracker.callerTranscribed("ano");
    expect(tracker.finish().interruptions).toBe(0);
  });

  it("counts noise as a false trigger, not an interruption", () => {
    const { tracker, advance, events } = setup();
    tracker.assistantAudio(3000);
    advance(500);
    tracker.callerSpeechStarted();
    tracker.callerTranscribed("   ");
    const stats = tracker.finish();
    expect(stats.interruptions).toBe(0);
    expect(stats.false_triggers).toBe(1);
    expect(events).toEqual([{ type: "quality.false_trigger", payload: { during_assistant: true } }]);
  });

  it("pairs transcripts with speech segments in order", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(3000);
    advance(500);
    tracker.callerSpeechStarted(); // over the assistant
    advance(3000);
    tracker.callerSpeechStarted(); // after it
    tracker.callerTranscribed("první"); // interruption
    tracker.callerTranscribed("druhá"); // no interruption
    expect(tracker.finish().interruptions).toBe(1);
  });

  it("forgets the queued audio when the engine clears the caller's playback", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(5000);
    advance(500);
    tracker.playbackCleared();
    advance(100);
    tracker.callerSpeechStarted();
    tracker.callerTranscribed("ano");
    expect(tracker.finish().interruptions).toBe(0);
  });
});

describe("interruptions (Live, inferred from the transcript)", () => {
  it("counts the start of a caller utterance over the assistant, once per utterance", () => {
    const { tracker, advance, events } = setup();
    tracker.assistantAudio(4000);
    advance(1000);
    tracker.callerTextDelta("Po");
    advance(200);
    tracker.callerTextDelta("čkejte");
    const stats = tracker.finish();
    expect(stats.interruptions).toBe(1);
    expect(events[0]).toEqual({ type: "quality.interruption", payload: { assistant_remaining_ms: 3000, inferred: true } });
  });

  it("ignores empty deltas and utterances after the assistant stopped", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(1000);
    advance(500);
    tracker.callerTextDelta("  ");
    advance(2000);
    tracker.callerTextDelta("Dobrý den");
    expect(tracker.finish().interruptions).toBe(0);
  });
});

describe("dead air", () => {
  it("counts a silence of 5 s or more between two activities", () => {
    const { tracker, advance, events } = setup();
    tracker.assistantAudio(2000);
    advance(2000 + 7000); // the audio plays out, then 7 s of silence
    tracker.callerSpeechStarted();
    const stats = tracker.finish();
    expect(stats.dead_air_count).toBe(1);
    expect(stats.dead_air_ms).toBe(7000);
    expect(events[0]).toEqual({ type: "quality.dead_air", payload: { duration_ms: 7000 } });
  });

  it("ignores shorter silences", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(2000);
    advance(2000 + 4000);
    tracker.callerSpeechStarted();
    expect(tracker.finish().dead_air_count).toBe(0);
  });

  it("does not count the time before the first sound of the call", () => {
    const { tracker, advance } = setup();
    advance(20_000);
    tracker.callerSpeechStarted();
    expect(tracker.finish().dead_air_count).toBe(0);
  });

  it("does not count a tool that is still running as silence", () => {
    const { tracker, advance } = setup();
    tracker.assistantAudio(1000);
    advance(1000);
    tracker.toolStarted();
    advance(12_000);
    tracker.toolFinished("get_day_availability", 12_000, false);
    advance(500);
    tracker.assistantAudio(1000);
    expect(tracker.finish().dead_air_count).toBe(0);
  });

  it("counts silence at the end of the call", () => {
    const { tracker, advance } = setup();
    tracker.callerSpeechStarted();
    advance(9000);
    const stats = tracker.finish();
    expect(stats.dead_air_count).toBe(1);
    expect(stats.dead_air_ms).toBe(9000);
  });

  it("counts a silence between the end of a tool and the next sound", () => {
    const { tracker, advance } = setup();
    tracker.toolStarted();
    advance(1000);
    tracker.toolFinished("search_knowledge", 1000, false);
    advance(6000);
    tracker.assistantAudio(1000);
    expect(tracker.finish().dead_air_count).toBe(1);
  });
});

describe("tool problems", () => {
  it("counts a failed tool", () => {
    const { tracker, events } = setup();
    tracker.toolStarted();
    tracker.toolFinished("create_calendar_event", 400, true);
    expect(tracker.finish().tool_problems).toBe(1);
    expect(events).toEqual([{ type: "quality.tool_problem", payload: { tool: "create_calendar_event", duration_ms: 400, kind: "error" } }]);
  });

  it("counts a slow tool once, as slow", () => {
    const { tracker, events } = setup();
    tracker.toolStarted();
    tracker.toolFinished("search_knowledge", 3500, false);
    expect(tracker.finish().tool_problems).toBe(1);
    expect(events[0].payload.kind).toBe("slow");
  });

  it("ignores a fast, successful tool", () => {
    const { tracker, events } = setup();
    tracker.toolStarted();
    tracker.toolFinished("get_services", 800, false);
    expect(tracker.finish().tool_problems).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("connection", () => {
  it("counts a lost connection and a start on Standard after Live failed", () => {
    const { tracker, events } = setup();
    tracker.markFallback("live start failed");
    tracker.disconnected(1006);
    const stats = tracker.finish();
    expect(stats.disconnects).toBe(1);
    expect(stats.fallback).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["quality.engine_fallback", "quality.disconnect"]);
  });
});

describe("safety", () => {
  it("never throws, even when reporting fails", () => {
    const tracker = new CallQualityTracker(() => { throw new Error("db down"); }, () => 1);
    expect(() => {
      tracker.assistantAudio(1000);
      tracker.callerSpeechStarted();
      tracker.callerTranscribed("");
      tracker.toolFinished("x", 99_999, true);
      tracker.disconnected(1);
      tracker.finish();
    }).not.toThrow();
  });

  it("returns the same totals when finished twice", () => {
    const { tracker, advance } = setup();
    tracker.callerSpeechStarted();
    advance(9000);
    expect(tracker.finish()).toEqual(tracker.finish());
  });

  it("starts with all zeroes", () => {
    expect(setup().tracker.finish()).toEqual({
      interruptions: 0, false_triggers: 0, dead_air_count: 0, dead_air_ms: 0, tool_problems: 0, disconnects: 0, fallback: false,
      first_audio_ms: null, inbound_gaps: 0, caller_dbfs: null,
    });
  });
});

describe("time to the first sound", () => {
  it("is measured from the start of the call to the first audio of the assistant, once", () => {
    const { tracker, advance } = setup();
    advance(900);
    tracker.assistantAudio(500);
    advance(5000);
    tracker.assistantAudio(500);
    expect(tracker.finish().first_audio_ms).toBe(900);
  });
});

describe("line quality", () => {
  it("counts a jump of 100 ms or more in the caller's audio clock as a gap, not the normal 20 ms step", () => {
    const { tracker } = setup();
    for (const ts of [0, 20, 40, 160, 180, 200, 400]) tracker.inboundFrame(ts, -30);
    expect(tracker.finish().inbound_gaps).toBe(2); // 40 -> 160 and 200 -> 400
  });

  it("averages the loudness of frames with sound and ignores silence", () => {
    const { tracker } = setup();
    tracker.inboundFrame(0, -30);
    tracker.inboundFrame(20, -40);
    tracker.inboundFrame(40, -90); // line noise floor, not counted
    tracker.inboundFrame(60, -Infinity);
    expect(tracker.finish().caller_dbfs).toBe(-35);
  });

  it("has no level when the caller never made a sound", () => {
    const { tracker } = setup();
    tracker.inboundFrame(0, -80);
    expect(tracker.finish().caller_dbfs).toBeNull();
  });
});
