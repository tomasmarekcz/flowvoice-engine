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
  it("returns mapped chunks with text, filename, score, and embeddingTokens", async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: FAKE_VECTOR }],
      usage: { total_tokens: 42 },
    });
    mockSearch.mockResolvedValue([
      { score: 0.95, payload: { text: "Hello world", filename: "doc.pdf", project_id: "proj-1" } },
      { score: 0.82, payload: { text: "Second chunk", filename: "doc.pdf", project_id: "proj-1" } },
    ]);

    const { chunks, embeddingTokens } = await searchKnowledge("what are your hours?", "proj-1", 2);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ text: "Hello world", filename: "doc.pdf", score: 0.95 });
    expect(chunks[1]).toEqual({ text: "Second chunk", filename: "doc.pdf", score: 0.82 });
    expect(embeddingTokens).toBe(42);
  });

  it("returns 0 embeddingTokens when usage is missing from response", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);

    const { embeddingTokens } = await searchKnowledge("query", "proj-1", 5);
    expect(embeddingTokens).toBe(0);
  });

  it("passes topN as limit to qdrant search", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }], usage: { total_tokens: 5 } });
    mockSearch.mockResolvedValue([]);

    await searchKnowledge("query", "proj-1", 7);

    expect(mockSearch).toHaveBeenCalledWith(
      "documents",
      expect.objectContaining({ limit: 7 })
    );
  });

  it("filters by project_id", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }], usage: { total_tokens: 5 } });
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
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }], usage: { total_tokens: 5 } });
    mockSearch.mockResolvedValue([]);

    await searchKnowledge("test query", "proj-1", 5);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", input: "test query" })
    );
  });

  it("returns empty chunks when qdrant returns no results", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }], usage: { total_tokens: 5 } });
    mockSearch.mockResolvedValue([]);

    const { chunks } = await searchKnowledge("obscure query", "proj-1", 5);
    expect(chunks).toEqual([]);
  });

  it("handles missing payload fields gracefully", async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }], usage: { total_tokens: 5 } });
    mockSearch.mockResolvedValue([
      { score: 0.7, payload: {} },
    ]);

    const { chunks } = await searchKnowledge("query", "proj-1", 5);
    expect(chunks[0]).toEqual({ text: "", filename: "", score: 0.7 });
  });
});

describe("Qdrant collection", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ data: [{ embedding: FAKE_VECTOR }] });
    mockSearch.mockResolvedValue([]);
  });

  it("searches the shared 'documents' collection by default (production)", async () => {
    delete process.env.QDRANT_COLLECTION;
    await searchKnowledge("q", "proj-1", 3);
    expect(mockSearch.mock.calls[0][0]).toBe("documents");
  });

  it("searches the collection named in QDRANT_COLLECTION (staging keeps its own)", async () => {
    process.env.QDRANT_COLLECTION = "documents_staging";
    await searchKnowledge("q", "proj-1", 3);
    expect(mockSearch.mock.calls[0][0]).toBe("documents_staging");
    delete process.env.QDRANT_COLLECTION;
  });
});

