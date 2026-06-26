import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch before any import so createCall doesn't hit real network
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  json: async () => [{ id: "call-test-123" }],
}));

// Provide env so config doesn't throw
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

const { CallLogger } = await import("../src/call-logger");

describe("CallLogger transcript tracking", () => {
  let log: InstanceType<typeof CallLogger>;

  beforeEach(() => {
    log = new CallLogger("test-project");
  });

  it("appends assistant entry from output_audio_transcript.done", () => {
    log.handleOpenAIEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Hello, how can I help?",
    });
    expect(log.transcript).toHaveLength(1);
    expect(log.transcript[0].role).toBe("assistant");
    expect(log.transcript[0].text).toBe("Hello, how can I help?");
  });

  it("appends user entry from input_audio_transcription.completed", () => {
    log.handleOpenAIEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "I need an appointment.",
    });
    expect(log.transcript).toHaveLength(1);
    expect(log.transcript[0].role).toBe("user");
    expect(log.transcript[0].text).toBe("I need an appointment.");
  });

  it("builds multi-turn transcript in order", () => {
    log.handleOpenAIEvent({ type: "response.output_audio_transcript.done", transcript: "Hi there!" });
    log.handleOpenAIEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hello." });
    log.handleOpenAIEvent({ type: "response.output_audio_transcript.done", transcript: "How can I help?" });

    expect(log.transcript).toHaveLength(3);
    expect(log.transcript[0].role).toBe("assistant");
    expect(log.transcript[1].role).toBe("user");
    expect(log.transcript[2].role).toBe("assistant");
  });

  it("ignores audio buffer append events", () => {
    log.handleClientEvent({ type: "input_audio_buffer.append", audio: "base64data" });
    expect(log.transcript).toHaveLength(0);
  });

  it("does not add transcript entries for non-transcript OpenAI events", () => {
    log.handleOpenAIEvent({ type: "session.created" });
    log.handleOpenAIEvent({ type: "rate_limits.updated" });
    log.handleOpenAIEvent({ type: "response.output_audio.delta", delta: "abc" });
    expect(log.transcript).toHaveLength(0);
  });

  it("tracks pending tool call and resolves it when output arrives", () => {
    log.handleOpenAIEvent({
      type: "response.function_call_arguments.done",
      name: "get_available_slots",
      call_id: "call-abc",
      arguments: JSON.stringify({ from_date: "2026-07-01" }),
    });

    log.handleClientEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-abc",
        output: JSON.stringify({ slots: ["2026-07-01T09:00:00Z"] }),
      },
    });

    // No crash, transcript is still empty (tool calls don't add to transcript)
    expect(log.transcript).toHaveLength(0);
  });

  it("each transcript entry has a timestamp_ms", () => {
    log.handleOpenAIEvent({ type: "response.output_audio_transcript.done", transcript: "Hi" });
    expect(typeof log.transcript[0].timestamp_ms).toBe("number");
    expect(log.transcript[0].timestamp_ms).toBeGreaterThan(0);
  });

  it("does not add entry when transcript field is missing", () => {
    log.handleOpenAIEvent({ type: "response.output_audio_transcript.done" }); // no transcript key
    expect(log.transcript).toHaveLength(0);
  });
});
