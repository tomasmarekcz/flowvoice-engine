import { describe, it, expect, afterEach } from "vitest";
import type { AssistantSettings } from "../src/config";
import {
  LIVE_CONVERSATION_PROMPT,
  pickLiveVoice,
  buildLiveGreetingInstruction,
  buildLiveSessionStart,
  extractFunctionCall,
  buildToolResultMessages,
  TranscriptAccumulator,
} from "../src/live-protocol";

function settings(overrides: Record<string, unknown> = {}): AssistantSettings {
  return {
    project_id: "proj-1",
    system_prompt: "Be kind.",
    voice: "alloy",
    capabilities: { enquiries: true, end_call: true },
    _project_name: "Acme Plumbing",
    greeting_enabled: true,
    greeting_message: "Hello from Acme",
    ...overrides,
  } as unknown as AssistantSettings;
}

type StartSession = {
  model: string;
  instructions: string;
  audio: { format: { type: string; rate: number }; output: { voice: string } };
  delegation: {
    type: string;
    responses: {
      model: string;
      instructions: string;
      tools: Array<{ name: string }>;
      tool_choice: string;
      parallel_tool_calls: boolean;
    };
  };
};

describe("pickLiveVoice", () => {
  it("keeps any supported voice", () => {
    expect(pickLiveVoice("marin")).toBe("marin");
    expect(pickLiveVoice("alloy")).toBe("alloy");
    expect(pickLiveVoice("verse")).toBe("verse");
  });

  it("falls back for unknown or missing voices", () => {
    expect(pickLiveVoice("not-a-voice")).toBe("marin");
    expect(pickLiveVoice(null)).toBe("marin");
    expect(pickLiveVoice(undefined)).toBe("marin");
  });
});

describe("buildLiveSessionStart", () => {
  afterEach(() => {
    delete process.env.LIVE_MODEL;
    delete process.env.LIVE_BACKEND_MODEL;
  });

  it("targets gpt-live-1 with 8 kHz mu-law audio and responses delegation", () => {
    const { message } = buildLiveSessionStart(settings(), "+420111222333");
    const session = message["session"] as StartSession;

    expect(message["type"]).toBe("session.start");
    expect(session.model).toBe("gpt-live-1");
    expect(session.instructions).toBe(LIVE_CONVERSATION_PROMPT);
    expect(session.audio.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    expect(session.audio.output.voice).toBe("alloy");
    expect(session.delegation.type).toBe("responses");
    expect(session.delegation.responses.model).toBe("gpt-5.6-terra");
    expect(session.delegation.responses.tool_choice).toBe("auto");
    expect(session.delegation.responses.parallel_tool_calls).toBe(false);
  });

  it("registers the assistant's tools with the backend", () => {
    const { message, tools } = buildLiveSessionStart(settings(), null);
    const session = message["session"] as StartSession;
    const names = session.delegation.responses.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_enquiry", "end_call"]));
    expect(tools.map((t) => t.name)).toEqual(names);
  });

  it("gives the backend the business prompt without the greeting rule", () => {
    const { message } = buildLiveSessionStart(settings(), "+420111222333");
    const backend = (message["session"] as StartSession).delegation.responses.instructions;
    expect(backend).toContain("Acme Plumbing");
    expect(backend).toContain("Be kind.");
    expect(backend).toContain("+420111222333");
    expect(backend).not.toContain("===CALL START===");
  });

  it("tells the backend to call end_call when the conversation is finished", () => {
    const { message } = buildLiveSessionStart(settings(), null);
    const backend = (message["session"] as StartSession).delegation.responses.instructions;
    expect(backend).toContain("end_call");
  });

  it("does not mention end_call to the backend when that capability is off", () => {
    const { message } = buildLiveSessionStart(settings({ capabilities: { enquiries: true } }), null);
    const backend = (message["session"] as StartSession).delegation.responses.instructions;
    expect(backend).not.toContain("end_call");
  });

  it("sets tool_choice to none when there are no tools", () => {
    const { message } = buildLiveSessionStart(settings({ capabilities: {} }), null);
    expect((message["session"] as StartSession).delegation.responses.tool_choice).toBe("none");
  });

  it("lets env override the model names", () => {
    process.env.LIVE_MODEL = "gpt-live-2";
    process.env.LIVE_BACKEND_MODEL = "some-backend";
    const { message } = buildLiveSessionStart(settings(), null);
    const session = message["session"] as StartSession;
    expect(session.model).toBe("gpt-live-2");
    expect(session.delegation.responses.model).toBe("some-backend");
  });
});

describe("buildLiveGreetingInstruction", () => {
  it("quotes the configured greeting", () => {
    expect(buildLiveGreetingInstruction(settings())).toContain("Hello from Acme");
  });

  it("returns null when disabled, empty or missing", () => {
    expect(buildLiveGreetingInstruction(settings({ greeting_enabled: false }))).toBeNull();
    expect(buildLiveGreetingInstruction(settings({ greeting_message: "   " }))).toBeNull();
    expect(buildLiveGreetingInstruction(null)).toBeNull();
  });
});

describe("extractFunctionCall", () => {
  const event = (inner: Record<string, unknown>) => ({
    type: "response.event",
    delegation_id: "d1",
    event: inner,
  });

  it("extracts a completed function call from a response.event envelope", () => {
    const call = extractFunctionCall(
      event({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "get_services", arguments: "{}" },
      })
    );
    expect(call).toEqual({ callId: "call_1", name: "get_services", argumentsJson: "{}" });
  });

  it("defaults missing arguments to an empty object", () => {
    const call = extractFunctionCall(
      event({ type: "response.output_item.done", item: { type: "function_call", call_id: "c", name: "n" } })
    );
    expect(call?.argumentsJson).toBe("{}");
  });

  it("ignores everything else", () => {
    expect(extractFunctionCall({ type: "session.started" })).toBeNull();
    expect(extractFunctionCall(event({ type: "response.output_text.delta", delta: "hi" }))).toBeNull();
    expect(
      extractFunctionCall(event({ type: "response.output_item.done", item: { type: "message" } }))
    ).toBeNull();
  });
});

describe("buildToolResultMessages", () => {
  it("returns the result item and, when asked, a response.create", () => {
    const msgs = buildToolResultMessages("call_1", { ok: true }, true);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]["type"]).toBe("response.item.create");
    expect(msgs[0]["item"]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ ok: true }),
    });
    expect(msgs[1]["type"]).toBe("response.create");
  });

  it("omits response.create when the response should not continue", () => {
    expect(buildToolResultMessages("call_1", { status: "ok" }, false)).toHaveLength(1);
  });
});

describe("TranscriptAccumulator", () => {
  it("merges consecutive deltas of one speaker into one utterance", () => {
    const acc = new TranscriptAccumulator();
    acc.addDelta("user", "Hi, I need ", 100);
    acc.addDelta("user", "a plumber.", 200);
    acc.flush();
    expect(acc.entries).toEqual([{ role: "user", text: "Hi, I need a plumber.", timestamp_ms: 100 }]);
  });

  it("starts a new utterance when the speaker changes", () => {
    const acc = new TranscriptAccumulator();
    acc.addDelta("user", "Hello", 100);
    acc.addDelta("assistant", "Hi there", 200);
    acc.flush();
    expect(acc.entries.map((e) => [e.role, e.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi there"],
    ]);
  });

  it("ignores empty deltas and whitespace-only utterances", () => {
    const acc = new TranscriptAccumulator();
    acc.addDelta("user", "");
    acc.addDelta("assistant", "   ");
    acc.flush();
    expect(acc.entries).toEqual([]);
  });

  it("flush is safe to call repeatedly", () => {
    const acc = new TranscriptAccumulator();
    acc.addDelta("user", "Hi", 1);
    acc.flush();
    acc.flush();
    expect(acc.entries).toHaveLength(1);
  });
});
