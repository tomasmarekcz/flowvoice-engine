import { describe, it, expect, beforeEach } from "vitest";
import { TurnGate, TURN_TIMING, type TurnTiming, type SentTurn } from "../src/turn-gate";

// A fake clock and a hand-driven poll: the tests move time and call tick() themselves.
function setup(timing: Partial<TurnTiming> = {}) {
  const clock = { t: 1_000_000 };
  const state = { busy: false };
  const sent: Array<{ text: string; info: SentTurn }> = [];
  const gate = new TurnGate(
    { send: (text, info) => sent.push({ text, info }), assistantBusy: () => state.busy, now: () => clock.t, autoPoll: false },
    { ...TURN_TIMING, ...timing },
  );
  const advance = (ms: number) => { clock.t += ms; gate.tick(); };
  /** The caller says something: sound for `soundMs`, the transcript arrives 500 ms later. */
  const say = (text: string, soundMs: number, accept = true) => {
    gate.speechStarted();
    clock.t += soundMs + TURN_TIMING.vadSilenceMs;
    gate.speechStopped();
    clock.t += 500;
    gate.transcript(text, accept);
    gate.tick();
  };
  return { gate, clock, state, sent, advance, say };
}

describe("TurnGate", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("sends a long finished sentence 1 s after the transcript", () => {
    t.say("Chtěl bych se objednat na pátek.", 2500);
    t.advance(900);
    expect(t.sent).toHaveLength(0);
    t.advance(150);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toBe("Chtěl bych se objednat na pátek.");
    expect(t.sent[0].info.kind).toBe("long-complete");
  });

  it("waits 1.5 s after a long fragment that stops without an end of sentence", () => {
    t.say("Chtěl bych se objednat na", 2500);
    t.advance(1400);
    expect(t.sent).toHaveLength(0);
    t.advance(150);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].info.kind).toBe("long-fragment");
  });

  it("sends a short answer (under one second of sound) only after 3 s of quiet", () => {
    t.say("Ano.", 500);
    t.advance(2900);
    expect(t.sent).toHaveLength(0);
    t.advance(150);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].info.kind).toBe("short");
  });

  it("merges a short answer with what the caller says next", () => {
    t.say("Buď.", 400);
    t.advance(1500);
    t.say("Určitě Bělohorský.", 1300);
    expect(t.sent).toHaveLength(0);
    t.advance(1100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toBe("Buď. Určitě Bělohorský.");
    expect(t.sent[0].info.pieces).toBe(2);
  });

  it("counts two short pieces together: enough sound makes them a long answer", () => {
    t.say("Pátek.", 700);
    t.advance(500);
    t.say("Jedenáct.", 600);
    t.advance(1100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].info.kind).toBe("long-complete");
  });

  it("never sends while the caller is still talking, however long", () => {
    t.say("Chtěl bych se objednat.", 2000);
    t.gate.speechStarted();
    t.advance(30_000);
    expect(t.sent).toHaveLength(0);
  });

  it("does not send while a transcript is still on its way", () => {
    t.say("Chtěl bych se objednat.", 2000);
    t.gate.speechStarted();
    t.clock.t += 800;
    t.gate.speechStopped(); // the second utterance is not transcribed yet
    t.advance(5000);
    expect(t.sent).toHaveLength(0);
    t.gate.transcript("a ještě na pátek.");
    t.advance(1100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toBe("Chtěl bych se objednat. a ještě na pátek.");
  });

  it("sends nothing while the assistant is busy and counts the wait from the moment she is done", () => {
    t.say("Chtěl bych se objednat.", 2000);
    t.state.busy = true;
    t.advance(20_000);
    expect(t.sent).toHaveLength(0);
    t.state.busy = false;
    t.advance(900);
    expect(t.sent).toHaveLength(0);
    t.advance(200);
    expect(t.sent).toHaveLength(1);
  });

  it("treats speech over the assistant as a short answer, however long it was", () => {
    t.state.busy = true;
    t.say("Chtěl bych se objednat na pátek ráno.", 3000); // started while she was talking
    t.state.busy = false;
    t.advance(2900);
    expect(t.sent).toHaveLength(0);
    t.advance(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].info.kind).toBe("short");
  });

  it("merges speech over the assistant with the caller's next sentence", () => {
    t.state.busy = true;
    t.say("Ano.", 400);
    t.state.busy = false;
    t.advance(1000);
    t.say("Určitě Bělohorský.", 1500);
    t.advance(1100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toBe("Ano. Určitě Bělohorský.");
    expect(t.sent[0].info.kind).toBe("long-complete");
  });

  it("drops a rejected transcript without sending anything", () => {
    t.say("Dobrý den, jak se máte?", 600, false);
    t.advance(10_000);
    expect(t.sent).toHaveLength(0);
  });

  it("ignores an empty transcript", () => {
    t.say("   ", 1500);
    t.advance(10_000);
    expect(t.sent).toHaveLength(0);
  });

  it("treats a transcript without any speech events as a long one (nothing is known about its length)", () => {
    t.gate.transcript("Ahoj.");
    t.advance(1100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].info.kind).toBe("long-complete");
  });

  it("measures the sound from the audio times of the events, minus the silence the detector waits for", () => {
    t.gate.speechStarted();
    t.clock.t += 5000; // the wall clock would say 5 s, the audio says 1.9 s of sound + 0.4 s silence
    t.gate.speechStopped({ startMs: 10_000, endMs: 12_300 });
    const heard = t.gate.transcript("Ano, prosím.");
    expect(heard.soundMs).toBe(1900);
  });

  it("forgets a transcript that never arrives, so the next one is not mixed up with it", () => {
    t.gate.speechStarted();
    t.clock.t += 1000;
    t.gate.speechStopped();
    t.clock.t += 10_000;
    t.say("Ano.", 400);
    t.advance(3100);
    expect(t.sent).toHaveLength(1);
  });

  it("sends nothing after dispose", () => {
    t.say("Chtěl bych se objednat.", 2000);
    t.gate.dispose();
    t.advance(10_000);
    expect(t.sent).toHaveLength(0);
  });
});
