import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SentenceChunker } from "../src/voice/sentence-chunker";
import { SpeechOutput } from "../src/voice/speech-output";
import { PlaybackClock } from "../src/playback-clock";
import type { VoiceEvents, VoiceProvider } from "../src/voice/types";

const feed = (c: SentenceChunker, text: string, step = 5): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)));
  return out;
};

describe("SentenceChunker", () => {
  it("cuts a text into sentences as the words arrive", () => {
    const c = new SentenceChunker();
    const out = feed(c, "Dobrý den, tady recepce. Čím vám mohu pomoci? Máte dotaz na termín.");
    out.push(...c.flush());
    expect(out).toEqual(["Dobrý den, tady recepce.", "Čím vám mohu pomoci?", "Máte dotaz na termín."]);
  });

  it("lets the first piece of an answer end at a comma once it is long enough, to start speaking sooner", () => {
    const c = new SentenceChunker();
    const out = feed(c, "Dobrý den, děkuji za váš dotaz, rád vám s tím pomohu. Další věta.");
    expect(out[0]).toBe("Dobrý den, děkuji za váš dotaz,");
    expect(out[1]).toBe("rád vám s tím pomohu.");
  });

  it("does not cut a short first clause (a bare 'Dobrý den,')", () => {
    const c = new SentenceChunker();
    const out = feed(c, "Dobrý den, jak vám mohu pomoci?");
    expect(out).toEqual(["Dobrý den, jak vám mohu pomoci?"].slice(0, out.length));
    expect(out.join(" ")).not.toContain("Dobrý den,\n");
  });

  it("keeps dates, times and abbreviations in one piece", () => {
    const c = new SentenceChunker();
    const out = feed(c, "Máte termín ve středu 4. listopadu ve 14. 30 hodin, tj. odpoledne. Platí to.", 4);
    out.push(...c.flush());
    expect(out).toEqual(["Máte termín ve středu 4. listopadu ve 14. 30 hodin,", "tj. odpoledne.", "Platí to."]);
  });

  it("returns whatever is left when the answer ends, even without punctuation", () => {
    const c = new SentenceChunker();
    expect(c.push("Ano, rozumím")).toEqual([]);
    expect(c.flush()).toEqual(["Ano, rozumím"]);
    expect(c.flush()).toEqual([]);
  });

  it("starts the next answer fresh after reset", () => {
    const c = new SentenceChunker();
    c.push("Nedokončená věta bez konce");
    c.reset();
    expect(c.flush()).toEqual([]);
  });

  it("does not split a very short sentence from the next one", () => {
    const c = new SentenceChunker();
    const out = feed(c, "Ano. Termín je volný ve středu.");
    out.push(...c.flush());
    expect(out).toEqual(["Ano. Termín je volný ve středu."]);
  });
});

class FakeVoice implements VoiceProvider {
  readonly format = "mulaw8" as const;
  readonly name = "fake";
  readonly model = "fake-1";
  events!: VoiceEvents;
  spoken: Array<[number, string]> = [];
  cancelled = 0;
  closed = false;
  async start(events: VoiceEvents) { this.events = events; }
  speak(id: number, text: string) { this.spoken.push([id, text]); }
  cancel() { this.cancelled++; }
  close() { this.closed = true; }
  // 1 second of audio for a sentence
  audio(id: number, seconds = 1) { this.events.onAudio(Buffer.alloc(8000 * seconds).toString("base64"), id); }
}

describe("SpeechOutput", () => {
  let now = 1_000_000;
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(now); });
  afterEach(() => vi.useRealTimers());

  function setup(extra: Partial<ConstructorParameters<typeof SpeechOutput>[1]> = {}) {
    const voice = new FakeVoice();
    const sent: string[] = [];
    const speech = new SpeechOutput(voice, { sendAudio: (a) => sent.push(a), clock: new PlaybackClock(() => Date.now()), ...extra });
    return { voice, speech, sent, advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
  }

  it("gives the voice one sentence at a time and passes its audio on", async () => {
    const { voice, speech, sent } = setup();
    await speech.start();
    speech.pushText("Dobrý den, tady recepce. Čím vám ");
    speech.pushText("mohu pomoci?");
    speech.endText();
    expect(voice.spoken).toEqual([[1, "Dobrý den, tady recepce."], [2, "Čím vám mohu pomoci?"]]);
    voice.audio(1);
    expect(sent).toHaveLength(1);
  });

  it("is drained once every sentence is done", async () => {
    const { voice, speech } = setup();
    await speech.start();
    speech.say("Dobrý den. Jak se máte?");
    let drained = false;
    void speech.drained().then(() => { drained = true; });
    voice.events.onSentenceDone(1);
    await Promise.resolve();
    expect(drained).toBe(false);
    voice.events.onSentenceDone(2);
    await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(true);
  });

  it("on cancel drops the rest, stops the voice and reports what was heard", async () => {
    const { voice, speech, sent, advance } = setup();
    await speech.start();
    speech.say("První věta je tady. Druhá věta je delší než ta první.");
    voice.audio(1, 2); voice.events.onSentenceDone(1);
    voice.audio(2, 4); voice.events.onSentenceDone(2);
    advance(3000); // sentence 1 (2 s) heard fully, 1 s of sentence 2 (4 s) heard
    const heard = speech.cancel();
    expect(heard.startsWith("První věta je tady.")).toBe(true);
    expect(heard.endsWith("…")).toBe(true);
    expect(heard).not.toContain("první.");
    expect(voice.cancelled).toBe(1);
    const before = sent.length;
    voice.audio(2, 1); // late audio of a cancelled sentence
    expect(sent.length).toBe(before);
  });

  it("reports nothing as heard when nothing had started to play", async () => {
    const { speech, voice } = setup();
    await speech.start();
    speech.say("Věta.");
    expect(speech.cancel()).toBe("");
    expect(voice.cancelled).toBe(1);
  });

  it("calls onStall when a busy voice stays silent too long, but not when audio keeps coming", async () => {
    const onStall = vi.fn();
    const { voice, speech } = setup({ onStall, stallMs: 3000 });
    await speech.start();
    speech.say("Dobrý den, jak vám mohu pomoci s rezervací?");
    vi.advanceTimersByTime(2000);
    voice.audio(1);
    vi.advanceTimersByTime(2000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(onStall).toHaveBeenCalledOnce();
  });
});
