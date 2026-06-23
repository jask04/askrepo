import { z } from "zod";

import { indexGithubRepo, IndexRepoError } from "@/lib/index-repo";
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

    try {
      const indexed = await indexGithubRepo(
        parsed.data.url,
        resolved.apiKey,
      );
      return Response.json({
        repoId: indexed.repoId,
        fileCount: indexed.fileCount,
        chunkCount: indexed.chunkCount,
      });
    } catch (err) {
      if (err instanceof IndexRepoError) {
        return errorJson({
          status: err.status,
          message: err.message,
          extra: err.extra,
        });
      }
      return errorResponse(err, {
        apiKey: resolved.apiKey,
        logTag: "ingest.index",
      });
    }
  } catch (err) {
    return errorResponse(err, { logTag: "ingest" });
  }
}
