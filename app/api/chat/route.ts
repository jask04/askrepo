import { validateUIMessages } from "ai";
import { z } from "zod";

import { streamAnswer } from "@/lib/chat";
import { getClientIp } from "@/lib/ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/ratelimit";
import { errorJson, errorResponse, sanitiseError } from "@/lib/sanitise";
import { resolveApiKey } from "@/lib/session";

export const maxDuration = 60;

// useChat posts { repoId, messages: UIMessage[] }. We validate the
// envelope with Zod, then validateUIMessages checks the message shape.
const BodySchema = z.object({
  repoId: z.string().min(1, "repoId is required"),
  messages: z.array(z.unknown()).min(1, "messages must not be empty").max(40),
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

    let messages;
    try {
      messages = await validateUIMessages({ messages: parsed.data.messages });
    } catch {
      return errorJson({ status: 400, message: "invalid messages" });
    }

    const resolved = await resolveApiKey();
    if (!resolved.ok) {
      return errorJson({
        status: 401,
        message: "No Gemini API key. Set your key or start tour mode.",
      });
    }

    // Per-IP rate limit before any embedding/LLM work.
    const ip = getClientIp(req);
    const rate = await checkRateLimit(
      ip,
      resolved.mode === "tour" ? "chat-tour" : "chat-byok",
    );
    if (!rate.allowed) return rateLimitResponse(rate);

    // Retrieval runs before the stream opens, so retrieval/embedding
    // failures surface as a plain JSON error. Failures during the model
    // call surface inside the stream via onError.
    const apiKey = resolved.apiKey;
    let answer;
    try {
      answer = await streamAnswer({
        repoId: parsed.data.repoId,
        messages,
        apiKey,
        abortSignal: req.signal,
      });
    } catch (err) {
      return errorResponse(err, { apiKey, logTag: "chat.pre-stream" });
    }

    return answer.result.toUIMessageStreamResponse({
      onError: (error) => {
        const s = sanitiseError(error, apiKey);
        console.error(
          `chat.stream err request_id=${s.requestId} status=${s.status}`,
        );
        return s.message;
      },
    });
  } catch (err) {
    return errorResponse(err, { logTag: "chat" });
  }
}
