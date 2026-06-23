import { getSession } from "@/lib/session";
import { findTourRepo } from "@/lib/tour";

// POST /api/tour — switch the session into tour mode, which makes
// chat/ingest use the host's GOOGLE_API_KEY (behind a strict per-IP
// rate limit, added on Day 12) instead of a visitor-supplied key.

export async function POST() {
  const repo = await findTourRepo();
  if (!repo) {
    return Response.json(
      { error: "The tour repo is not indexed." },
      { status: 404 },
    );
  }

  if (repo.status !== "READY" || repo.chunkCount === 0) {
    return Response.json(
      { error: "The tour repo is not ready." },
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
