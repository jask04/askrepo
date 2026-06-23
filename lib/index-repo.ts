import { prisma } from "@/lib/db";
import { EMBED_BATCH_SIZE, EmbedError, embedBatch } from "@/lib/embed";
import {
  MAX_REPO_SIZE_KB,
  MAX_TOTAL_CHUNK_BYTES,
  checkGithubRepoSize,
  cloneAndChunk,
  parseGithubUrl,
} from "@/lib/ingest";

export class IndexRepoError extends Error {
  readonly status: number;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IndexRepoError";
    this.status = status;
    this.extra = extra;
  }
}

export type IndexRepoResult = {
  repoId: string;
  owner: string;
  name: string;
  commitSha: string;
  fileCount: number;
  chunkCount: number;
  totalBytes: number;
  elapsedMs: number;
};

export async function indexGithubRepo(
  inputUrl: string,
  apiKey: string,
): Promise<IndexRepoResult> {
  const repoUrl = parseGithubUrl(inputUrl);
  if (!repoUrl) {
    throw new IndexRepoError(
      400,
      "url must point to a github.com repository",
    );
  }

  const sizeCheck = await checkGithubRepoSize(repoUrl.owner, repoUrl.name);
  if (!sizeCheck.ok) {
    if (sizeCheck.kind === "too_large") {
      throw new IndexRepoError(
        413,
        `That repository is too large (${sizeCheck.sizeKb} KB > ${MAX_REPO_SIZE_KB} KB).`,
      );
    }
    if (sizeCheck.kind === "not_found") {
      throw new IndexRepoError(
        404,
        "That repository was not found, or it is private.",
      );
    }
    console.warn(
      `ingest github-size unavailable owner=${repoUrl.owner} name=${repoUrl.name}`,
    );
  }

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
      owner: repoUrl.owner,
      name: repoUrl.name,
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
    throw new IndexRepoError(
      result.kind === "size_exceeded" ? 413 : 400,
      errorMessage,
      { repoId: repo.id },
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
    await backfillEmbeddings(repo.id, apiKey);
  } catch (err) {
    await prisma.repo.update({
      where: { id: repo.id },
      data: {
        status: "FAILED",
        errorMessage:
          err instanceof EmbedError
            ? `Embedding failed (${err.status})`
            : "Embedding failed",
      },
    });
    throw err;
  }

  await prisma.repo.update({
    where: { id: repo.id },
    data: { status: "READY" },
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `ingest ok repo=${repo.id} owner=${repo.owner} name=${repo.name} files=${result.files.length} chunks=${docs.length} bytes=${result.totalBytes} elapsed_ms=${elapsedMs}`,
  );

  return {
    repoId: repo.id,
    owner: repoUrl.owner,
    name: repoUrl.name,
    commitSha: result.commitSha,
    fileCount: result.files.length,
    chunkCount: docs.length,
    totalBytes: result.totalBytes,
    elapsedMs,
  };
}

/**
 * Page through Documents for this repo whose embedding is NULL, embed
 * each batch via Gemini, and write the vectors back. Filtering by
 * NULL on the Unsupported vector column requires raw SQL because
 * Prisma's typed client can't see it.
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
