import { prisma } from "@/lib/db";
import { fetchLatestCommitSha } from "@/lib/ingest";
import { errorJson, errorResponse } from "@/lib/sanitise";

// GET /api/freshness?repoId=... — compare the indexed commit against
// the repo's current default-branch HEAD so the chat header can offer
// a re-index when the repo has moved on.

export async function GET(req: Request) {
  try {
    const repoId = new URL(req.url).searchParams.get("repoId");
    if (!repoId) {
      return errorJson({ status: 400, message: "repoId is required" });
    }

    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
      select: { owner: true, name: true, commitSha: true },
    });
    if (!repo) {
      return errorJson({ status: 404, message: "repo not found" });
    }

    const latestSha = await fetchLatestCommitSha(repo.owner, repo.name);
    // Only call it stale when we actually know both SHAs and they differ.
    const stale =
      latestSha !== null &&
      repo.commitSha.length > 0 &&
      latestSha !== repo.commitSha;

    return Response.json({
      indexedSha: repo.commitSha,
      latestSha,
      stale,
    });
  } catch (err) {
    return errorResponse(err, { logTag: "freshness" });
  }
}
