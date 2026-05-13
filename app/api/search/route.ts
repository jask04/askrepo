import { z } from "zod";

import { MAX_TOP_K, retrieveTopK } from "@/lib/retrieve";

// Thin wrapper around retrieveTopK for manual testing. Day 6 will use
// the underlying function from inside the chat handler; this endpoint
// stays around as a debug surface.

const QuerySchema = z.object({
  repoId: z.string().min(1, "repoId is required"),
  q: z.string().min(1, "q is required"),
  k: z.coerce.number().int().min(1).max(MAX_TOP_K).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    repoId: url.searchParams.get("repoId"),
    q: url.searchParams.get("q"),
    k: url.searchParams.get("k") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    );
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "GOOGLE_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const startedAt = Date.now();
  try {
    const results = await retrieveTopK(
      parsed.data.repoId,
      parsed.data.q,
      apiKey,
      parsed.data.k,
    );
    console.log(
      `search ok repo=${parsed.data.repoId} k=${results.length} elapsed_ms=${Date.now() - startedAt}`,
    );
    return Response.json({
      results: results.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        distance: r.distance,
        content: r.content,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "search failed";
    console.error(`search err repo=${parsed.data.repoId} msg=${message}`);
    return Response.json({ error: "search failed" }, { status: 502 });
  }
}
