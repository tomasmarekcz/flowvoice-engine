import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSearch = vi.fn();
const mockCreate = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn(() => ({ search: mockSearch })),
}));

vi.mock("openai", () => ({
  default: vi.fn(() => ({ embeddings: { create: mockCreate } })),
}));

import { searchKnowledge } from "../src/knowledge";

const FAKE_VECTOR = Array.from({ length: 1536 }, () => 0.1);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.QDRANT_URL = "https://fake.qdrant.io";
  process.env.QDRANT_API_KEY = "fake-key";
  process.env.OPENAI_API_KEY = "fake-openai-key";
});

describe("searchKnowledge", () => {
  it("returns mapped chunks with text, filename, and score", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([
      { score: 0.95, payload: { text: "Hello world", filename: "doc.pdf", project_id: "proj-1" } },
      { score: 0.82, payload: { text: "Second chunk", filename: "doc.pdf", project_id: "proj-1" } },
    ]);

    const results = await searchKnowledge("what are your hours?", "proj-1", 2);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ text: "Hello world", filename: "doc.pdf", score: 0.95 });
    expect(results[1]).toEqual({ text: "Second chunk", filename: "doc.pdf", score: 0.82 });
  });

  it("passes topN as limit to qdrant search", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);

    await searchKnowledge("query", "proj-1", 7);

    expect(mockSearch).toHaveBeenCalledWith(
      "documents",
      expect.objectContaining({ limit: 7 })
    );
  });

  it("filters by project_id", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);

    await searchKnowledge("query", "proj-abc", 3);

    expect(mockSearch).toHaveBeenCalledWith(
      "documents",
      expect.objectContaining({
        filter: {
          must: [{ key: "project_id", match: { value: "proj-abc" } }],
        },
      })
    );
  });

  it("uses text-embedding-3-small model", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);

    await searchKnowledge("test query", "proj-1", 5);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", input: "test query" })
    );
  });

  it("returns empty array when qdrant returns no results", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);

    const results = await searchKnowledge("obscure query", "proj-1", 5);
    expect(results).toEqual([]);
  });

  it("handles missing payload fields gracefully", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([
      { score: 0.7, payload: {} },
    ]);

    const results = await searchKnowledge("query", "proj-1", 5);
    expect(results[0]).toEqual({ text: "", filename: "", score: 0.7 });
  });
});
