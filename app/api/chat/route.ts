import { z } from "zod";

import { ChatError, answerQuestion } from "@/lib/chat";
import { resolveApiKey } from "@/lib/session";

export const maxDuration = 60;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
});

const BodySchema = z.object({
  repoId: z.string().min(1, "repoId is required"),
  messages: z.array(MessageSchema).min(1).max(40),
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

  const resolved = await resolveApiKey();
  if (!resolved.ok) {
    return Response.json(
      { error: "No Gemini API key. Set your key or start tour mode." },
      { status: 401 },
    );
  }

  try {
    const answer = await answerQuestion({
      repoId: parsed.data.repoId,
      messages: parsed.data.messages,
      apiKey: resolved.apiKey,
    });
    return Response.json({
      content: answer.content,
      citations: answer.citations.map((c) => ({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        score: c.score,
      })),
    });
  } catch (err) {
    if (err instanceof ChatError) {
      const userMessage =
        err.status === 401
          ? "API key is invalid"
          : err.status === 429
            ? "API key is rate limited"
            : "Chat request failed";
      const status =
        err.status === 401 || err.status === 429 ? err.status : 502;
      console.error(
        `chat err status=${err.status} message=${err.message.slice(0, 200)}`,
      );
      return Response.json({ error: userMessage }, { status });
    }
    const message = err instanceof Error ? err.message : "chat failed";
    console.error(`chat err message=${message.slice(0, 200)}`);
    return Response.json({ error: "chat failed" }, { status: 502 });
  }
}
