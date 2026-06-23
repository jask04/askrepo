import type { UIMessage } from "ai";

import { streamAnswer } from "@/lib/chat";
import { prisma } from "@/lib/db";
import { fetchLatestCommitSha } from "@/lib/ingest";
import { indexGithubRepo } from "@/lib/index-repo";
import { checkRateLimit } from "@/lib/ratelimit";
import { sanitiseError } from "@/lib/sanitise";
import { findTourRepo, getTourRepoUrl, type TourRepo } from "@/lib/tour";

export const maxDuration = 300;

const SMOKE_QUESTION = "Where is the main server entrypoint?";

type TourInspection = {
  repo: TourRepo | null;
  docCount: number;
  embeddedCount: number;
  latestSha: string | null;
  stale: boolean;
  reasons: string[];
};

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "GOOGLE_API_KEY is not configured" },
      { status: 500 },
    );
  }

  try {
    const before = await inspectTourRepo();
    const reindexUrl = before.repo?.url ?? getTourRepoUrl();
    const indexed = before.reasons.length
      ? await indexGithubRepo(reindexUrl, apiKey)
      : null;

    const after = await inspectTourRepo();
    if (!after.repo || after.reasons.length > 0) {
      return Response.json(
        {
          ok: false,
          error: "Tour repo is still unhealthy after maintenance.",
          before: summarizeInspection(before),
          after: summarizeInspection(after),
          indexed,
        },
        { status: 500 },
      );
    }

    // Touch the same Redis-backed limiter used by public tour chat so
    // the maintenance path covers Upstash availability too.
    if (process.env.NODE_ENV === "production" && !hasRedisEnv()) {
      return Response.json(
        { ok: false, error: "Upstash Redis environment is not configured." },
        { status: 500 },
      );
    }

    const rate = await checkRateLimit("cron-demo", "chat-tour");
    if (!rate.allowed) {
      return Response.json(
        {
          ok: false,
          error: "Maintenance smoke check hit the tour chat rate limit.",
          rate,
        },
        { status: 429 },
      );
    }

    const smoke = await runChatSmoke(after.repo.id, apiKey);

    return Response.json({
      ok: true,
      reindexed: Boolean(indexed),
      before: summarizeInspection(before),
      after: summarizeInspection(after),
      indexed,
      smoke: {
        answerChars: smoke.answerChars,
        citations: smoke.citations,
        rateRemaining: rate.remaining,
      },
    });
  } catch (err) {
    const s = sanitiseError(err, apiKey);
    console.error(
      `cron.demo request_id=${s.requestId} status=${s.status} message=${s.message.slice(0, 200)}`,
    );
    return Response.json(
      { ok: false, error: s.message, requestId: s.requestId },
      { status: s.status },
    );
  }
}

function hasRedisEnv(): boolean {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return Boolean(url && token);
}

async function inspectTourRepo(): Promise<TourInspection> {
  const repo = await findTourRepo();
  if (!repo) {
    return {
      repo,
      docCount: 0,
      embeddedCount: 0,
      latestSha: null,
      stale: false,
      reasons: ["missing"],
    };
  }

  const [docCount, embeddedCount, latestSha] = await Promise.all([
    prisma.document.count({ where: { repoId: repo.id } }),
    countEmbeddedDocuments(repo.id),
    fetchLatestCommitSha(repo.owner, repo.name),
  ]);

  const stale =
    latestSha !== null &&
    repo.commitSha.length > 0 &&
    latestSha !== repo.commitSha;
  const reasons: string[] = [];
  if (repo.status !== "READY") reasons.push(`status:${repo.status}`);
  if (repo.chunkCount === 0) reasons.push("zero-chunks");
  if (docCount === 0) reasons.push("zero-documents");
  if (embeddedCount === 0) reasons.push("zero-embeddings");
  if (stale) reasons.push("stale");

  return { repo, docCount, embeddedCount, latestSha, stale, reasons };
}

async function countEmbeddedDocuments(repoId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number | bigint }>>`
    SELECT COUNT(*)::int AS count
    FROM "Document"
    WHERE "repoId" = ${repoId} AND embedding IS NOT NULL
  `;
  return Number(rows[0]?.count ?? 0);
}

async function runChatSmoke(repoId: string, apiKey: string) {
  const messages = [
    {
      id: "demo-smoke",
      role: "user",
      parts: [{ type: "text", text: SMOKE_QUESTION }],
    },
  ] satisfies UIMessage[];

  const answer = await streamAnswer({ repoId, messages, apiKey });
  const text = await answer.result.text;
  if (!text.trim()) {
    throw new Error("Demo smoke check produced an empty answer.");
  }

  return {
    answerChars: text.length,
    citations: answer.citations.length,
  };
}

function summarizeInspection(inspection: TourInspection) {
  return {
    repoId: inspection.repo?.id ?? null,
    repo: inspection.repo
      ? `${inspection.repo.owner}/${inspection.repo.name}`
      : null,
    status: inspection.repo?.status ?? null,
    indexedSha: inspection.repo?.commitSha ?? null,
    latestSha: inspection.latestSha,
    docCount: inspection.docCount,
    embeddedCount: inspection.embeddedCount,
    stale: inspection.stale,
    reasons: inspection.reasons,
  };
}
