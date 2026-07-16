import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateCallSummary } from "../src/call-logger";
import type { TranscriptEntry } from "../src/call-logger";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TRANSCRIPT: TranscriptEntry[] = [
  { role: "user", text: "Hello", timestamp_ms: 1000 },
  { role: "assistant", text: "Hi there", timestamp_ms: 2000 },
];

beforeEach(() => {
  mockFetch.mockReset();
  process.env.OPENAI_API_KEY = "sk-test";
});

describe("generateCallSummary token tracking", () => {
  it("returns summaryInputTokens and summaryOutputTokens from API response", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{ message: { content: '{"title":"Test call","summary":"A test."}' } }],
        usage: { prompt_tokens: 150, completion_tokens: 30 },
      }),
    });

    const result = await generateCallSummary("sk-test", TRANSCRIPT);
    expect(result.summaryInputTokens).toBe(150);
    expect(result.summaryOutputTokens).toBe(30);
  });

  it("returns 0 tokens when usage is missing from response", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{ message: { content: '{"title":"T","summary":"S."}' } }],
      }),
    });

    const result = await generateCallSummary("sk-test", TRANSCRIPT);
    expect(result.summaryInputTokens).toBe(0);
    expect(result.summaryOutputTokens).toBe(0);
  });

  it("returns 0 tokens when transcript is empty (early return)", async () => {
    const result = await generateCallSummary("sk-test", []);
    expect(result.summaryInputTokens).toBe(0);
    expect(result.summaryOutputTokens).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("still returns title and summary correctly alongside tokens", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{ message: { content: '{"title":"Plumbing inquiry","summary":"Customer needs a quote."}' } }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }),
    });

    const result = await generateCallSummary("sk-test", TRANSCRIPT);
    expect(result.title).toBe("Plumbing inquiry");
    expect(result.summary).toBe("Customer needs a quote.");
    expect(result.summaryInputTokens).toBe(200);
    expect(result.summaryOutputTokens).toBe(50);
  });
});
