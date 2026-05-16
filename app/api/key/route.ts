import { z } from "zod";

import { EmbedError, embedBatch } from "@/lib/embed";
import { getSession } from "@/lib/session";

// POST /api/key  — validate a visitor-supplied Gemini key with one
//                  cheap embed call, then store it in the encrypted
//                  session cookie. The key is never echoed back.
// DELETE /api/key — clear the session.

const BodySchema = z.object({
  apiKey: z.string().min(1, "apiKey is required").max(200),
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
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const apiKey = parsed.data.apiKey.trim();

  // Validate the key with a single, tiny embed call. If Google accepts
  // it we know it works for both embedding and chat.
  try {
    await embedBatch(["askrepo key check"], apiKey, {
      taskType: "RETRIEVAL_QUERY",
    });
  } catch (err) {
    let message = "Could not validate that API key.";
    if (err instanceof EmbedError) {
      if (err.status === 401 || err.status === 403) {
        message = "That API key was rejected by Google.";
      } else if (err.status === 429) {
        message = "That API key is currently rate limited.";
      }
    }
    // Note: err.message may contain upstream detail but never the key
    // itself (embed.ts scrubs it). We still don't forward it verbatim.
    return Response.json({ error: message }, { status: 400 });
  }

  const session = await getSession();
  session.apiKey = apiKey;
  session.mode = "byok";
  await session.save();

  console.log("key set mode=byok");
  return Response.json({ ok: true });
}

export async function DELETE() {
  const session = await getSession();
  session.destroy();
  console.log("key cleared");
  return Response.json({ ok: true });
}
