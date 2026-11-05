import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  executeTool: vi.fn(),
  finishCall: vi.fn(),
}));

vi.mock("../src/call-logger", () => ({
  CallLogger: class {
    callId = "call-1";
    openaiPayload: unknown = null;
    callDurationSeconds = 42;
    async createCall() {}
    logEvent() {}
    handleOpenAIEvent() {}
    handleClientEvent() {}
    async discardCall() {}
  },
}));
vi.mock("../src/call-finish", () => ({ finishCall: h.finishCall }));
vi.mock("../src/tools", () => ({ executeTool: h.executeTool }));
vi.mock("../src/ical-refresh", () => ({ refreshExternalCalendars: () => {} }));

import { PipelineCallSession } from "../src/pipeline-session";
import { emptySnapshot } from "../src/prompts/core";
import { fixedTexts } from "../src/call-ending";
import type { LlmEvent, LlmRequest } from "../src/pipeline/responses-llm";
import type { VoiceEvents, VoiceProvider } from "../src/voice/types";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.type === "session.update") setImmediate(() => this.emit("message", JSON.stringify({ type: "session.updated" })));
  }
  close() { this.readyState = 3; this.emit("close", 1000); }
  drop(code = 1006) { this.readyState = 3; this.emit("close", code); }
  say(msg: Record<string, unknown>) { this.emit("message", JSON.stringify(msg)); }
}

class FakeVoice implements VoiceProvider {
  readonly format = "mulaw8" as const;
  readonly name = "fake";
  readonly model = "fake";
  spoken: string[] = [];
  events: VoiceEvents | null = null;
  constructor(private readonly autoFinish: boolean) {}
  async start(events: VoiceEvents) { this.events = events; }
  speak(id: number, text: string) {
    this.spoken.push(text);
    if (this.autoFinish) queueMicrotask(() => this.events?.onSentenceDone(id));
  }
  cancel() {}
  close() {}
}

const flush = async (ms = 5) => { await new Promise((r) => setTimeout(r, ms)); };

function setup(opts: { script: LlmEvent[][]; autoFinishVoice?: boolean; language?: "cs" | "en"; endCheck?: string }) {
  const sockets: FakeSocket[] = [];
  const voice = new FakeVoice(opts.autoFinishVoice ?? true);
  const requests: LlmRequest[] = [];
  const checks: LlmRequest[] = []; // the small "is the call over?" question (no tools)
  let round = 0;
  const sent = { json: [] as Array<Record<string, unknown>>, endCall: 0, marks: [] as string[] };
  const callbacks = {
    sendAudio: vi.fn(),
    sendJson: (o: unknown) => { sent.json.push(o as Record<string, unknown>); },
    sendMark: (n: string) => { sent.marks.push(n); },
    endCall: () => { sent.endCall++; },
    clearAudio: vi.fn(),
  };
  const session = new PipelineCallSession(
    "project-1", "+420123456789", "CA1", callbacks,
    { project_id: "project-1", system_prompt: "Be helpful.", voice: null, is_active: true, capabilities: {}, language: opts.language ?? "cs", greeting_enabled: false } as never,
    emptySnapshot(),
    {
      audio: "pcmu",
      voice: () => voice,
      llm: async function* (req) {
        if (req.tools.length === 0 && req.instructions.startsWith("You watch a phone call")) { checks.push(req); yield { type: "text", delta: opts.endCheck ?? "CONTINUE" }; return; }
        requests.push({ ...req, input: [...req.input] }); for (const e of opts.script[round++] ?? []) yield e; },
      connect: () => { const s = new FakeSocket(); sockets.push(s); setImmediate(() => s.emit("open")); return s as never; },
    },
  );
  return { session, sockets, voice, requests, checks, sent, callbacks };
}

const transcribed = (text: string) => ({ type: "conversation.item.input_audio_transcription.completed", transcript: text });

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  h.executeTool.mockReset().mockResolvedValue({ result: { ok: true }, embeddingTokens: 0 });
  h.finishCall.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("PipelineCallSession", () => {
  it("answers a caller turn: transcript goes to the model, the answer to the voice", async () => {
    const { session, sockets, voice, requests } = setup({
      script: [[{ type: "text", delta: "Dobrý den, " }, { type: "text", delta: "jak vám mohu pomoci?" }, { type: "usage", inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }]],
    });
    await session.start();
    sockets[0].say(transcribed("Ahoj, potřebuju objednat."));
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual([{ role: "user", content: "Ahoj, potřebuju objednat." }]);
    expect(voice.spoken.join(" ")).toContain("jak vám mohu pomoci?");
    await session.end();
    const detail = h.finishCall.mock.calls[0][0].usageDetail;
    expect(detail).toMatchObject({ engine: "pipeline", llm_input_tokens: 100, llm_cached_input_tokens: 20, llm_output_tokens: 10, stt_seconds: 42 });
  });

  it("runs a tool and feeds the result back to the model", async () => {
    const { session, sockets, requests, voice } = setup({
      script: [
        [{ type: "tool_call", callId: "c1", name: "get_day_availability", arguments: "{\"date\":\"2026-11-04\"}" }],
        [{ type: "text", delta: "Máme volno ve tři." }],
      ],
    });
    await session.start();
    sockets[0].say(transcribed("Kdy máte volno?"));
    await flush(20);
    expect(h.executeTool).toHaveBeenCalledWith("get_day_availability", { date: "2026-11-04" }, "project-1", expect.anything(), "call-1", expect.anything(), "+420123456789", expect.anything());
    expect(requests).toHaveLength(2);
    const second = requests[1].input as Array<Record<string, unknown>>;
    expect(second.map((i) => i["type"] ?? i["role"])).toEqual(["user", "function_call", "function_call_output"]);
    expect(voice.spoken.join(" ")).toContain("volno ve tři");
  });

  it("says a goodbye and hangs up after end_call", async () => {
    const { session, sockets, sent } = setup({
      script: [[{ type: "text", delta: "Na shledanou." }, { type: "tool_call", callId: "e1", name: "end_call", arguments: "{}" }]],
    });
    await session.start();
    sockets[0].say(transcribed("To je vše, děkuji."));
    await flush(20);
    expect(sent.marks).toHaveLength(1);
    session.handleTwilioMark(sent.marks[0]);
    expect(sent.endCall).toBe(1);
    expect(h.finishCall).toHaveBeenCalledTimes(1);
  });

  describe("safety net for end_call (LEA-174)", () => {
    it("hangs up when the small model says the call is over, although the main model forgot end_call", async () => {
      const { session, sockets, sent, checks } = setup({
        script: [[{ type: "text", delta: "Na shledanou, Šimone." }]],
        endCheck: "END",
      });
      await session.start();
      sockets[0].say(transcribed("Už ne, děkuju. Na shledanou."));
      await flush(30);
      expect(checks).toHaveLength(1);
      expect(sent.marks).toHaveLength(1);
      session.handleTwilioMark(sent.marks[0]);
      expect(sent.endCall).toBe(1);
    });

    it("keeps the call open when the small model says it goes on", async () => {
      const { session, sockets, sent, checks } = setup({
        script: [[{ type: "text", delta: "Mohu vám ještě s něčím pomoci?" }]],
        endCheck: "CONTINUE",
      });
      await session.start();
      sockets[0].say(transcribed("Děkuju."));
      await flush(30);
      expect(checks).toHaveLength(1);
      expect(sent.marks).toHaveLength(0);
    });

    it("does not ask when the main model ended the call itself", async () => {
      const { session, sockets, checks } = setup({
        script: [[{ type: "text", delta: "Na shledanou." }, { type: "tool_call", callId: "e1", name: "end_call", arguments: "{}" }]],
      });
      await session.start();
      sockets[0].say(transcribed("To je vše."));
      await flush(30);
      expect(checks).toHaveLength(0);
    });
  });

  it("drops an interrupted answer that the caller never heard", async () => {
    const { session, sockets, requests } = setup({
      script: [[{ type: "text", delta: "Dobrý den, tohle je dlouhá odpověď." }], [{ type: "text", delta: "Ano?" }]],
      autoFinishVoice: false, // the voice is still working on the sentence, so the caller interrupts a live answer
    });
    await session.start();
    sockets[0].say(transcribed("První otázka"));
    await flush();
    sockets[0].say({ type: "input_audio_buffer.speech_started" });
    await flush(1100); // the caller keeps talking for a full second: that cuts the answer
    sockets[0].say(transcribed("Počkejte, druhá otázka"));
    await flush();
    const input = requests[1].input as Array<{ role?: string; content?: string }>;
    expect(input.filter((i) => i.role === "assistant")).toEqual([]);
    expect(input.map((i) => i.content)).toEqual(["První otázka", "Počkejte, druhá otázka"]);
  });

  describe("what counts as the caller speaking (LEA-166)", () => {
    it("tells speech recognition the expected language softly, without a word list and without locking it", async () => {
      const { session, sockets } = setup({ script: [] });
      await session.start();
      const update = sockets[0].sent.find((m) => m["type"] === "session.update") as { session: { audio: { input: { transcription: Record<string, unknown> } } } };
      const tr = update.session.audio.input.transcription;
      expect(tr).not.toHaveProperty("language");
      expect(tr["prompt"]).toBe("The caller speaks Czech. Transcribe the speech in Czech. Use another language only when the caller clearly speaks another language.");
    });

    it("does not cut the assistant for a sound shorter than one second", async () => {
      const { session, sockets, callbacks } = setup({ script: [[{ type: "text", delta: "Dobrý den, tohle je dlouhá odpověď." }]], autoFinishVoice: false });
      await session.start();
      sockets[0].say(transcribed("Otázka"));
      await flush();
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      await flush(100);
      sockets[0].say({ type: "input_audio_buffer.speech_stopped" });
      await flush(600);
      expect(callbacks.clearAudio).not.toHaveBeenCalled();
    });

    it("cuts the assistant when the sound lasts one second", async () => {
      const { session, sockets, callbacks } = setup({ script: [[{ type: "text", delta: "Dobrý den, tohle je dlouhá odpověď." }]], autoFinishVoice: false });
      await session.start();
      sockets[0].say(transcribed("Otázka"));
      await flush();
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      await flush(1100);
      expect(callbacks.clearAudio).toHaveBeenCalledTimes(1);
    });

    it("lets a very short answer finish instead of cutting it off", async () => {
      const { session, sockets, callbacks } = setup({ script: [[{ type: "text", delta: "Rozumím." }]], autoFinishVoice: false });
      await session.start();
      sockets[0].say(transcribed("Otázka"));
      await flush();
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      await flush(1100);
      expect(callbacks.clearAudio).not.toHaveBeenCalled();
    });

    it("does not cut the assistant for words that are only in the transcript (\"uh\", \"um\"), LEA-179", async () => {
      const { session, sockets, callbacks } = setup({ script: [[{ type: "text", delta: "Dobrý den, tohle je dlouhá odpověď." }], [{ type: "text", delta: "Ano." }]], autoFinishVoice: false });
      await session.start();
      sockets[0].say(transcribed("Otázka"));
      await flush();
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      await flush(100);
      sockets[0].say({ type: "input_audio_buffer.speech_stopped" });
      sockets[0].say(transcribed("Uh"));
      await flush();
      expect(callbacks.clearAudio).not.toHaveBeenCalled();
    });
  });

  describe("silence and limit sentences said by the model (LEA-175)", () => {
    it("asks the model to say the silence question and does not add the hint to the conversation", async () => {
      const { session, voice, requests } = setup({ script: [[{ type: "text", delta: "Jste ještě na lince?" }]] });
      await session.start();
      const fixed = fixedTexts({ language: "cs" } as never, emptySnapshot());
      await (session as unknown as { speakHint(t: string): Promise<void> }).speakHint(fixed.silenceAsk);
      expect(requests).toHaveLength(1);
      const input = requests[0].input as Array<{ role?: string; content?: string }>;
      expect(input[input.length - 1].role).toBe("developer");
      expect(requests[0].tools).toEqual([]);
      expect(voice.spoken.join(" ")).toContain("Jste ještě na lince?");
      expect((session as unknown as { history: Array<{ role?: string }> }).history.some((h) => h.role === "developer")).toBe(false);
    });

    it("falls back to the recorded sentence when the model says nothing", async () => {
      const { session, voice } = setup({ script: [[]] });
      await session.start();
      const fixed = fixedTexts({ language: "cs" } as never, emptySnapshot());
      await (session as unknown as { speakHint(t: string): Promise<void> }).speakHint(fixed.silenceAsk);
      expect(voice.spoken.join(" ")).toContain(fixed.silenceAsk);
    });
  });

  describe("quiet silence handling (LEA-181)", () => {
    it("never asks 'still there?': the silent line ends the call after 30 s without a word", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { session, voice, sent, checks } = setup({ script: [] });
      await session.start();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(sent.marks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(voice.spoken).toEqual([]);
      expect(checks).toEqual([]);
      expect(sent.marks).toHaveLength(1); // the line closes once the (empty) queue has played
      session.handleTwilioMark(sent.marks[0]);
      expect(sent.endCall).toBe(1);
    });

    it("a caller who talks keeps the line open however long the sentence is", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { session, sockets, sent } = setup({ script: [] });
      await session.start();
      await vi.advanceTimersByTimeAsync(20_000);
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sent.marks).toHaveLength(0);
    });
  });

  describe("speech not understood (switched on with PIPELINE_BRIDGE_SENTENCES, off by default, LEA-180)", () => {
    beforeEach(() => { process.env.PIPELINE_BRIDGE_SENTENCES = "on"; });
    afterEach(() => { delete process.env.PIPELINE_BRIDGE_SENTENCES; });

    const talk = (s: FakeSocket, ms: number, now: { t: number }) => {
      s.say({ type: "input_audio_buffer.speech_started" });
      now.t += ms;
      s.say({ type: "input_audio_buffer.speech_stopped" });
      s.say(transcribed("  "));
    };

    it("asks to repeat after real speech with an empty transcript, but not after a click", async () => {
      const now = { t: 1_000_000 };
      vi.spyOn(Date, "now").mockImplementation(() => now.t);
      const { session, sockets, voice, requests } = setup({ script: [] });
      await session.start();
      talk(sockets[0], 150, now); // too short: noise
      await flush();
      expect(voice.spoken).toEqual([]);
      talk(sockets[0], 1500, now);
      await flush();
      expect(voice.spoken.join(" ")).toBe("Promiňte, nerozuměl jsem. Můžete to prosím zopakovat?");
      expect(requests).toHaveLength(0); // the model was not asked
      vi.restoreAllMocks();
    });

    it("asks in English for an English assistant, and stops asking after two in a row", async () => {
      const now = { t: 1_000_000 };
      vi.spyOn(Date, "now").mockImplementation(() => now.t);
      const { session, sockets, voice } = setup({ script: [], language: "en" });
      await session.start();
      for (let i = 0; i < 4; i++) { talk(sockets[0], 1500, now); await flush(); }
      const said = voice.spoken.join(" ");
      expect(said.match(/didn't catch/g)).toHaveLength(2);
      vi.restoreAllMocks();
    });
  });

  describe("fixed mid-call sentences are off by default (LEA-180)", () => {
    it("says nothing after real speech with an empty transcript", async () => {
      const now = { t: 1_000_000 };
      vi.spyOn(Date, "now").mockImplementation(() => now.t);
      const { session, sockets, voice, requests } = setup({ script: [] });
      await session.start();
      sockets[0].say({ type: "input_audio_buffer.speech_started" });
      now.t += 1500;
      sockets[0].say({ type: "input_audio_buffer.speech_stopped" });
      sockets[0].say(transcribed("  "));
      await flush();
      expect(voice.spoken).toEqual([]);
      expect(requests).toHaveLength(0);
      vi.restoreAllMocks();
    });
  });

  describe("speech recognition drops during the call", () => {
    it("reconnects once and goes on listening, keeping the caller's audio meanwhile", async () => {
      const { session, sockets, sent } = setup({ script: [[{ type: "text", delta: "Ano." }]] });
      await session.start();
      sockets[0].drop();
      session.handleClientAudio("AAAA"); // arrives while reconnecting
      await flush(20);
      expect(sockets).toHaveLength(2);
      expect(sockets[1].sent.some((m) => m["type"] === "input_audio_buffer.append" && m["audio"] === "AAAA")).toBe(true);
      expect(sent.endCall).toBe(0);
      sockets[1].say(transcribed("Slyšíte mě?"));
      await flush();
      await session.end();
      expect(h.finishCall.mock.calls[0][0].quality).toBeDefined();
    });

    it("apologises and ends the call properly when the second connection drops too", async () => {
      const { session, sockets, voice, sent } = setup({ script: [] });
      await session.start();
      sockets[0].drop();
      await flush(20);
      sockets[1].drop();
      await flush(20);
      expect(voice.spoken.join(" ")).toContain("technická chyba");
      expect(sent.marks).toHaveLength(1);
      session.handleTwilioMark(sent.marks[0]);
      await flush(20);
      expect(h.finishCall).toHaveBeenCalledTimes(1); // the call is still saved with a summary, and marked as ended by a technical problem
      expect(h.finishCall.mock.calls[0][0].endReason).toBe("technical_error");
      expect(sent.endCall).toBe(1);
    });

    it("does nothing when the session was already ended on purpose", async () => {
      const { session, sockets, sent } = setup({ script: [] });
      await session.start();
      await session.end();
      expect(sockets).toHaveLength(1);
      expect(sent.json.some((m) => m["type"] === "error")).toBe(false);
    });
  });
});
