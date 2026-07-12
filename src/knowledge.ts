import { QdrantClient } from "@qdrant/js-client-rest";
import OpenAI from "openai";

const COLLECTION = "documents";

function qdrant(): QdrantClient {
  return new QdrantClient({
    url: process.env.QDRANT_URL!,
    apiKey: process.env.QDRANT_API_KEY,
  });
}

function openai(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

export interface KnowledgeChunk {
  text: string;
  filename: string;
  score: number;
}

export async function searchKnowledge(
  query: string,
  projectId: string,
  topN: number
): Promise<KnowledgeChunk[]> {
  const embeddingRes = await openai().embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const vector = embeddingRes.data[0].embedding;

  const results = await qdrant().search(COLLECTION, {
    vector,
    limit: topN,
    filter: {
      must: [{ key: "project_id", match: { value: projectId } }],
    },
    with_payload: true,
  });

  return results.map((r) => ({
    text: (r.payload?.text as string) ?? "",
    filename: (r.payload?.filename as string) ?? "",
    score: r.score,
  }));
}
