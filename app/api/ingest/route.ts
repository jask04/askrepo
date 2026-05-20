import { z } from "zod";

import { prisma } from "@/lib/db";
import { EMBED_BATCH_SIZE, EmbedError, embedBatch } from "@/lib/embed";
import {
  MAX_REPO_SIZE_KB,
  MAX_TOTAL_CHUNK_BYTES,
  checkGithubRepoSize,
  cloneAndChunk,
  parseGithubUrl,
} from "@/lib/ingest";
import { getClientIp } from "@/lib/ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/ratelimit";
import { errorJson, errorResponse } from "@/lib/sanitise";
import { resolveApiKey } from "@/lib/session";

// Ingestion is synchronous within the request. Repos are size-capped
// (MAX_REPO_SIZE_KB pre-flight, then MAX_TOTAL_CHUNK_BYTES of chunked
// text, plus a 1MB-per-file limit) to keep the work comfortably inside
// Vercel's function timeout.
export const maxDuration = 300;

const BodySchema = z.object({
  url: z.string().url("url must be a valid URL"),
});

export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorJson({ status: 400, message: "invalid JSON body" });
    }

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorJson({
        status: 400,
        message: parsed.error.issues[0]?.message ?? "invalid body",
      });
    }

    const repoUrl = parseGithubUrl(parsed.data.url);
    if (!repoUrl) {
      return errorJson({
        status: 400,
        message: "url must point to a github.com repository",
      });
    }

    // Resolve the embedding key up front — no point cloning a repo we
    // can't afford to embed.
    const resolved = await resolveApiKey();
    if (!resolved.ok) {
      return errorJson({
        status: 401,
        message: "No Gemini API key. Set your key or start tour mode.",
      });
    }

    // Per-IP rate limit before we do any expensive work.
    const ip = getClientIp(req);
    const rate = await checkRateLimit(
      ip,
      resolved.mode === "tour" ? "ingest-tour" : "ingest-byok",
    );
    if (!rate.allowed) return rateLimitResponse(rate);

    // Pre-flight GitHub size check. Unavailable is non-fatal: we log
    // and proceed, since the post-clone chunked-size cap is the real
    // backstop.
    const sizeCheck = await checkGithubRepoSize(repoUrl.owner, repoUrl.name);
    if (!sizeCheck.ok) {
      if (sizeCheck.kind === "too_large") {
        return errorJson({
          status: 413,
          message: `That repository is too large (${sizeCheck.sizeKb} KB > ${MAX_REPO_SIZE_KB} KB).`,
        });
      }
      if (sizeCheck.kind === "not_found") {
        return errorJson({
          status: 404,
          message: "That repository was not found, or it is private.",
        });
      }
      // unavailable — log and continue.
      console.warn(
        `ingest github-size unavailable owner=${repoUrl.owner} name=${repoUrl.name}`,
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
      return errorJson({
        status,
        message: errorMessage,
        extra: { repoId: repo.id },
      });
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
      return errorResponse(err, {
        apiKey: resolved.apiKey,
        logTag: "ingest.embed",
      });
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
  } catch (err) {
    return errorResponse(err, { logTag: "ingest" });
  }
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
