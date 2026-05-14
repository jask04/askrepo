// Non-streaming Gemini chat with retrieved repo context. Day 8 will
// swap the underlying call for the Vercel AI SDK's streamText; the
// shape of answerQuestion and the system prompt stay the same.

import { retrieveTopK, type RetrievedChunk } from "./retrieve";

export const CHAT_MODEL = "gemini-2.5-flash";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`;

const SYSTEM_INSTRUCTIONS = `You answer questions about a specific GitHub repository.

Use only the file excerpts in the "Repository excerpts" section below. When you reference code or describe behaviour, cite the source inline using the exact format [path:start-end] — for example [src/index.ts:42-58]. The path and line range must be one that appears in the excerpts.

If the answer is not present in the excerpts, say so plainly rather than guessing. Do not invent files, line ranges, or APIs that are not in the excerpts. Prefer short, concrete answers grounded in the cited code over speculation.`;

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatAnswer = {
  content: string;
  citations: RetrievedChunk[];
};

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

function formatChunks(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `<file path="${c.path}" lines="${c.startLine}-${c.endLine}">\n${c.content}\n</file>`,
    )
    .join("\n\n");
}

/**
 * Retrieve top-K chunks for the latest user message, hand them to
 * Gemini Flash alongside the chat history, and return the assistant's
 * reply plus the citations the model was given.
 */
export async function answerQuestion(params: {
  repoId: string;
  messages: ChatMessage[];
  apiKey: string;
}): Promise<ChatAnswer> {
  const { repoId, messages, apiKey } = params;
  if (messages.length === 0) {
    throw new ChatError(400, "messages must not be empty");
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    throw new ChatError(400, "no user message found in messages");
  }

  const citations = await retrieveTopK(repoId, lastUser.content, apiKey);

  const contextSection =
    citations.length === 0
      ? "No repository excerpts matched this question. Tell the user that, and ask them to rephrase."
      : `Repository excerpts:\n\n${formatChunks(citations)}`;

  const systemInstruction = `${SYSTEM_INSTRUCTIONS}\n\n${contextSection}`;

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const startedAt = Date.now();
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 500);
    } catch {
      detail = resp.statusText;
    }
    detail = detail.split(apiKey).join("[redacted]");
    throw new ChatError(resp.status, `Gemini chat error: ${detail}`);
  }

  const json = (await resp.json()) as GeminiResponse;
  const block = json.promptFeedback?.blockReason;
  if (block) {
    throw new ChatError(400, `Gemini blocked the request: ${block}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `chat ok repo=${repoId} model=${CHAT_MODEL} cited=${citations.length} chars=${text.length} elapsed_ms=${elapsedMs}`,
  );

  return { content: text, citations };
}
