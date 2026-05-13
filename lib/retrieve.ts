import { prisma } from "./db";
import { embedBatch } from "./embed";

export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 50;

export type RetrievedChunk = {
  id: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  /** pgvector cosine distance: 0 = identical, higher = less similar. */
  distance: number;
  /** 1 - distance for cosine; closer to 1 = more relevant. */
  score: number;
};

type Row = {
  id: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  distance: number;
};

/**
 * Embed the user's query, then pull the K nearest Document chunks
 * for the given repo from pgvector. Uses the `<=>` cosine-distance
 * operator, which matches the HNSW index created in the init migration.
 */
export async function retrieveTopK(
  repoId: string,
  query: string,
  apiKey: string,
  k: number = DEFAULT_TOP_K,
): Promise<RetrievedChunk[]> {
  const limit = Math.min(Math.max(1, Math.floor(k)), MAX_TOP_K);

  const [queryEmbedding] = await embedBatch([query], apiKey, {
    taskType: "RETRIEVAL_QUERY",
  });
  if (!queryEmbedding) {
    throw new Error("query embedding was not returned");
  }

  // pgvector expects a `[v1,v2,...]` string literal cast to vector.
  const queryVector = `[${queryEmbedding.join(",")}]`;

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, path, content, "startLine", "endLine",
      (embedding <=> ${queryVector}::vector) AS distance
    FROM "Document"
    WHERE "repoId" = ${repoId} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryVector}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    content: r.content,
    startLine: r.startLine,
    endLine: r.endLine,
    distance: r.distance,
    score: 1 - r.distance,
  }));
}
