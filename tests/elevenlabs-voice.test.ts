// LEA-166: the ElevenLabs voice, the spare voice and the choice of voice by name.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ElevenLabsVoice } from "../src/voice/elevenlabs-voice";
import { FallbackVoice } from "../src/voice/fallback-voice";
import { makeVoice } from "../src/voice/make-voice";
import { ELEVEN_VOICES, isElevenVoice } from "../src/voice/eleven-voices";
import { VOICE_GENDER, resolveVoice } from "../src/persona";
import { emptySnapshot } from "../src/prompts/core";
import type { VoiceEvents, VoiceProvider } from "../src/voice/types";

const stream = (parts: string[]) => new Response(new ReadableStream({
  start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
}), { status: 200 });

function collect() {
  const log: string[] = [];
  const events: VoiceEvents = {
    onAudio: (a, id) => log.push(`audio${id}:${Buffer.from(a, "base64").toString()}`),
    onSentenceDone: (id) => log.push(`done${id}`),
    onUsage: (u) => log.push(`chars${u.characters}`),
    onError: (e) => log.push(`error:${e.message.slice(0, 20)}`),
  };
  return { log, events };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("ElevenLabsVoice", () => {
  it("asks for phone-line audio with the chosen voice, model and language, and passes the audio on", async () => {
    const fetchImpl = vi.fn(async () => stream(["ab", "cd"]));
    const voice = new ElevenLabsVoice({ voiceId: "V1", language: "cs", apiKey: "k", fetchImpl: fetchImpl as never });
    const { log, events } = collect();
    await voice.start(events);
    voice.speak(1, "Dobrý den.");
    await tick();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/V1/stream?output_format=ulaw_8000");
    expect(init.headers["xi-api-key"]).toBe("k");
    expect(JSON.parse(init.body)).toMatchObject({ text: "Dobrý den.", model_id: "eleven_v4_turbo", language_code: "cs" });
    expect(log).toEqual(["audio1:ab", "audio1:cd", "chars10", "done1"]);
  });

  it("keeps the sentences in order and gives the sentence before it as context", async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body); bodies.push(body);
      if (body.text === "Jedna.") { await first; return stream(["1"]); }
      return stream(["2"]);
    });
    const voice = new ElevenLabsVoice({ voiceId: "V1", apiKey: "k", fetchImpl: fetchImpl as never });
    const { log, events } = collect();
    await voice.start(events);
    voice.speak(1, "Jedna.");
    voice.speak(2, "Dva.");
    await tick();
    expect(log).toEqual([]); // sentence 2 is ready but waits for sentence 1
    release();
    await tick();
    expect(log.filter((l) => l.startsWith("audio") || l.startsWith("done"))).toEqual(["audio1:1", "done1", "audio2:2", "done2"]);
    expect(bodies[0]).not.toHaveProperty("previous_text");
    expect(bodies[1]["previous_text"]).toBe("Jedna.");
    expect(bodies[0]).not.toHaveProperty("language_code"); // not known: the model decides
  });

  it("reports an error when ElevenLabs refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("paid plan required", { status: 402 }));
    const voice = new ElevenLabsVoice({ voiceId: "V1", apiKey: "k", fetchImpl: fetchImpl as never });
    const { log, events } = collect();
    await voice.start(events);
    voice.speak(1, "Dobrý den.");
    await tick();
    expect(log[0]).toMatch(/^error:ElevenLabs answered/);
  });

  it("cancel drops what is queued and says nothing about it", async () => {
    const fetchImpl = vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const voice = new ElevenLabsVoice({ voiceId: "V1", apiKey: "k", fetchImpl: fetchImpl as never });
    const { log, events } = collect();
    await voice.start(events);
    voice.speak(1, "Dobrý den.");
    await tick();
    voice.cancel();
    await tick();
    expect(log).toEqual([]);
  });

  it("will not start without a key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(new ElevenLabsVoice({ voiceId: "V1" }).start(collect().events)).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

class FakeVoice implements VoiceProvider {
  readonly format = "mulaw8" as const; readonly model = "fake";
  spoken: Array<[number, string]> = []; events!: VoiceEvents; closed = false;
  constructor(readonly name: string, private readonly failStart = false) {}
  async start(e: VoiceEvents) { this.events = e; if (this.failStart) throw new Error("cannot start"); }
  speak(id: number, text: string) { this.spoken.push([id, text]); }
  cancel() {} close() { this.closed = true; }
}

describe("FallbackVoice", () => {
  it("reads the unfinished sentences with the spare when the main voice fails, and the rest of the call too", async () => {
    const main = new FakeVoice("main"); const spare = new FakeVoice("spare");
    const voice = new FallbackVoice(main, () => spare);
    const { log, events } = collect();
    await voice.start(events);
    voice.speak(1, "Jedna."); voice.speak(2, "Dva.");
    main.events.onSentenceDone(1);
    main.events.onError(new Error("boom"));
    await tick();
    expect(spare.spoken).toEqual([[2, "Dva."]]); // sentence 1 was finished, sentence 2 is read again
    expect(main.closed).toBe(true);
    voice.speak(3, "Tři.");
    expect(spare.spoken.at(-1)).toEqual([3, "Tři."]);
    expect(voice.usingSpare).toBe(true);
    spare.events.onAudio(Buffer.from("x").toString("base64"), 2);
    main.events.onAudio(Buffer.from("late").toString("base64"), 2); // a late sound of the broken voice is ignored
    expect(log.filter((l) => l.startsWith("audio"))).toEqual(["audio2:x"]);
  });

  it("goes straight to the spare when the main voice cannot start", async () => {
    const spare = new FakeVoice("spare");
    const voice = new FallbackVoice(new FakeVoice("main", true), () => spare);
    await voice.start(collect().events);
    voice.speak(1, "Jedna.");
    expect(spare.spoken).toEqual([[1, "Jedna."]]);
  });
});

describe("the voice list", () => {
  beforeEach(() => { process.env.OPENAI_API_KEY = "x"; });
  afterEach(() => { delete process.env.ELEVENLABS_API_KEY; });

  it("the four ElevenLabs voices are known, with their gender", () => {
    expect(Object.keys(ELEVEN_VOICES)).toEqual(["el-adam", "el-jarnathan", "el-hope", "el-jana"]);
    expect(VOICE_GENDER["el-adam"]).toBe("male");
    expect(VOICE_GENDER["el-jana"]).toBe("female");
    expect(isElevenVoice("el-hope")).toBe(true);
    expect(isElevenVoice("marin")).toBe(false);
  });

  it("a chosen ElevenLabs voice is kept only when it fits the gender of the assistant", () => {
    expect(resolveVoice({ voice: "el-jana", persona_gender: "female" } as never)).toBe("el-jana");
    expect(resolveVoice({ voice: "el-jana", persona_gender: "male" } as never)).toBe("cedar");
  });

  it("an OpenAI voice is read by OpenAI, an ElevenLabs voice by ElevenLabs with a spare, and without a key by OpenAI", () => {
    expect(makeVoice("marin", emptySnapshot(), null).name).toBe("openai-realtime");
    expect(makeVoice("el-jana", emptySnapshot(), null).name).toBe("openai-realtime"); // no key yet
    process.env.ELEVENLABS_API_KEY = "k";
    const v = makeVoice("el-jana", emptySnapshot(), { language: "cs" } as never);
    expect(v).toBeInstanceOf(FallbackVoice);
    expect(v.name).toBe("elevenlabs");
  });
});
