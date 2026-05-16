import { z } from "zod";

import { ChatError, streamAnswer } from "@/lib/chat";
import { EmbedError } from "@/lib/embed";
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

  // Retrieval runs before the stream opens, so retrieval/embedding
  // failures surface as a plain JSON error. Failures during the model
  // call surface inside the stream via onError.
  let answer;
  try {
    answer = await streamAnswer({
      repoId: parsed.data.repoId,
      messages: parsed.data.messages,
      apiKey: resolved.apiKey,
      abortSignal: req.signal,
    });
  } catch (err) {
    return preStreamError(err);
  }

  return answer.result.toUIMessageStreamResponse({
    onError: (error) => {
      const status = errorStatus(error);
      console.error(`chat stream err status=${status ?? "?"}`);
      if (status === 401 || status === 403) {
        return "Your API key was rejected by Google.";
      }
      if (status === 429) {
        return "Your API key is rate limited.";
      }
      return "The chat request failed.";
    },
  });
}

/** Extract an HTTP status from an AI SDK APICallError, if present. */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function preStreamError(err: unknown): Response {
  // ChatError validation messages are ours and safe to surface.
  if (err instanceof ChatError && err.status === 400) {
    return Response.json({ error: err.message }, { status: 400 });
  }

  const status =
    err instanceof ChatError
      ? err.status
      : err instanceof EmbedError
        ? err.status
        : 502;
  console.error(`chat err status=${status}`);

  if (status === 401 || status === 403) {
    return Response.json(
      { error: "Your API key was rejected by Google." },
      { status: 401 },
    );
  }
  if (status === 429) {
    return Response.json(
      { error: "Your API key is rate limited." },
      { status: 429 },
    );
  }
  return Response.json({ error: "Chat request failed." }, { status: 502 });
}
