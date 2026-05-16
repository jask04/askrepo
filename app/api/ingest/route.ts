import { z } from "zod";

import { prisma } from "@/lib/db";
import { EMBED_BATCH_SIZE, EmbedError, embedBatch } from "@/lib/embed";
import {
  MAX_TOTAL_CHUNK_BYTES,
  cloneAndChunk,
  parseGithubUrl,
} from "@/lib/ingest";
import { resolveApiKey } from "@/lib/session";

// Ingestion is synchronous within the request. Repos are size-capped
// (MAX_TOTAL_CHUNK_BYTES, plus a 1MB-per-file limit) to keep the work
// comfortably inside Vercel's function timeout.
export const maxDuration = 300;

const BodySchema = z.object({
  url: z.string().url("url must be a valid URL"),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid body";
    return Response.json({ error: message }, { status: 400 });
  }

  const repoUrl = parseGithubUrl(parsed.data.url);
  if (!repoUrl) {
    return Response.json(
      { error: "url must point to a github.com repository" },
      { status: 400 },
    );
  }

  // Resolve the embedding key up front — no point cloning a repo we
  // can't afford to embed.
  const resolved = await resolveApiKey();
  if (!resolved.ok) {
    return Response.json(
      { error: "No Gemini API key. Set your key or start tour mode." },
      { status: 401 },
    );
  }

  // Upsert at INGESTING. Re-ingesting an existing repo replaces its
  // documents, so the row is reused but its chunks are dropped first.
  const repo = await prisma.repo.upsert({
    where: { url: repoUrl.normalizedUrl },
    create: {
      url: repoUrl.normalizedUrl,
      owner: repoUrl.owner,
      name: repoUrl.name,
      commitSha: "",
      status: "INGESTING",
    },
    update: {
      status: "INGESTING",
      errorMessage: null,
      fileCount: 0,
      chunkCount: 0,
    },
  });
  await prisma.document.deleteMany({ where: { repoId: repo.id } });

  const startedAt = Date.now();
  const result = await cloneAndChunk(repoUrl.normalizedUrl);

  if (!result.ok) {
    const errorMessage =
      result.kind === "size_exceeded"
        ? `Repo is too large after chunking (${result.totalBytes} bytes, limit ${MAX_TOTAL_CHUNK_BYTES}).`
        : `Clone failed: ${result.message}`;
    await prisma.repo.update({
      where: { id: repo.id },
      data: { status: "FAILED", errorMessage },
    });
    const status = result.kind === "size_exceeded" ? 413 : 400;
    return Response.json(
      { error: errorMessage, repoId: repo.id },
      { status },
    );
  }

  const docs = result.files.flatMap((file) =>
    file.chunks.map((chunk, idx) => ({
      repoId: repo.id,
      path: file.path,
      chunkIndex: idx,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    })),
  );

  if (docs.length > 0) {
    await prisma.document.createMany({ data: docs });
  }

  await prisma.repo.update({
    where: { id: repo.id },
    data: {
      commitSha: result.commitSha,
      fileCount: result.files.length,
      chunkCount: docs.length,
      status: "EMBEDDING",
    },
  });

  try {
    await backfillEmbeddings(repo.id, resolved.apiKey);
  } catch (err) {
    const errorMessage =
      err instanceof EmbedError
        ? `Embedding failed (${err.status}): ${err.message}`
        : err instanceof Error
          ? `Embedding failed: ${err.message}`
          : "Embedding failed";
    await prisma.repo.update({
      where: { id: repo.id },
      data: { status: "FAILED", errorMessage: errorMessage.slice(0, 500) },
    });
    const status = err instanceof EmbedError && err.status === 401 ? 401 : 502;
    return Response.json(
      { error: "Embedding failed", repoId: repo.id },
      { status },
    );
  }

  await prisma.repo.update({
    where: { id: repo.id },
    data: { status: "READY" },
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `ingest ok repo=${repo.id} owner=${repo.owner} name=${repo.name} files=${result.files.length} chunks=${docs.length} bytes=${result.totalBytes} elapsed_ms=${elapsedMs}`,
  );

  return Response.json({
    repoId: repo.id,
    fileCount: result.files.length,
    chunkCount: docs.length,
  });
}

/**
 * Page through Documents for this repo whose embedding is NULL, embed
 * each batch via Gemini, and write the vectors back. Filtering by
 * NULL on the Unsupported vector column requires raw SQL — Prisma's
 * typed client can't see it.
 */
async function backfillEmbeddings(repoId: string, apiKey: string) {
  while (true) {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; content: string }>
    >`
      SELECT id, content FROM "Document"
      WHERE "repoId" = ${repoId} AND embedding IS NULL
      ORDER BY id ASC
      LIMIT ${EMBED_BATCH_SIZE}
    `;
    if (rows.length === 0) return;

    const vectors = await embedBatch(
      rows.map((r) => r.content),
      apiKey,
      { taskType: "RETRIEVAL_DOCUMENT" },
    );

    await prisma.$transaction(
      rows.map((row, i) => {
        const vec = vectors[i];
        if (!vec) {
          throw new EmbedError(502, `missing embedding for row ${row.id}`);
        }
        const literal = `[${vec.join(",")}]`;
        return prisma.$executeRaw`
          UPDATE "Document"
          SET embedding = ${literal}::vector
          WHERE id = ${row.id}
        `;
      }),
    );
  }
}
