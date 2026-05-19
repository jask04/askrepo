import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

// POST /api/tour — switch the session into tour mode, which makes
// chat/ingest use the host's GOOGLE_API_KEY (behind a strict per-IP
// rate limit, added on Day 12) instead of a visitor-supplied key.

export async function POST() {
  const repoId = config.TOUR_REPO_ID;
  if (!repoId) {
    return Response.json(
      { error: "Tour mode is not available yet." },
      { status: 404 },
    );
  }

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { id: true },
  });
  if (!repo) {
    return Response.json(
      { error: "The tour repo is not indexed." },
      { status: 404 },
    );
  }

  const session = await getSession();
  session.mode = "tour";
  // Tour mode uses the host key, never a stored visitor key.
  delete session.apiKey;
  await session.save();

  console.log("tour started");
  return Response.json({ ok: true, repoId: repo.id });
}
