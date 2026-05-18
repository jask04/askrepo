// Streaming Gemini chat with retrieved repo context, via the Vercel
// AI SDK. Retrieval and the system prompt are unchanged from the
// Day 6 non-streaming version — only the model call now streams.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { convertToModelMessages, streamText, type UIMessage } from "ai";

import { retrieveTopK, type RetrievedChunk } from "./retrieve";

export const CHAT_MODEL = "gemini-2.5-flash";

const SYSTEM_INSTRUCTIONS = `You answer questions about a specific GitHub repository.

Use only the file excerpts in the "Repository excerpts" section below. If the answer is not present in the excerpts, say so plainly rather than guessing. Do not invent files, line ranges, or APIs that are not in the excerpts. Prefer short, concrete answers grounded in the cited code over speculation.

Citations — whenever you reference code or describe behaviour, cite the source inline in this exact format:
- [path:start-end] for a line range, e.g. [src/index.ts:42-58]
- [path:line] for a single line, e.g. [src/index.ts:42]

Citation rules:
- Use the file path exactly as it appears in the excerpt's "path" attribute, relative to the repository root.
- Use line numbers that fall within the excerpt's "lines" attribute.
- Write the citation as plain text immediately after the claim it supports. Never wrap a citation in backticks, a code block, or a markdown link.
- Only cite paths and line ranges that actually appear in the excerpts.`;

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

function formatChunks(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `<file path="${c.path}" lines="${c.startLine}-${c.endLine}">\n${c.content}\n</file>`,
    )
    .join("\n\n");
}

/** Concatenate the text parts of a UI message into a plain string. */
function uiMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export type StreamAnswer = {
  result: ReturnType<typeof streamText>;
  citations: RetrievedChunk[];
};

/**
 * Retrieve top-K chunks for the latest user message, then stream a
 * Gemini Flash answer grounded in them. Returns the AI SDK stream
 * result (the route turns it into a streaming HTTP response) plus the
 * citations the model was given.
 */
export async function streamAnswer(params: {
  repoId: string;
  messages: UIMessage[];
  apiKey: string;
  abortSignal?: AbortSignal;
}): Promise<StreamAnswer> {
  const { repoId, messages, apiKey, abortSignal } = params;
  if (messages.length === 0) {
    throw new ChatError(400, "messages must not be empty");
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    throw new ChatError(400, "no user message found in messages");
  }
  const question = uiMessageText(lastUser).trim();
  if (!question) {
    throw new ChatError(400, "last user message has no text");
  }

  const citations = await retrieveTopK(repoId, question, apiKey);

  const contextSection =
    citations.length === 0
      ? "No repository excerpts matched this question. Tell the user that, and ask them to rephrase."
      : `Repository excerpts:\n\n${formatChunks(citations)}`;

  const system = `${SYSTEM_INSTRUCTIONS}\n\n${contextSection}`;

  const google = createGoogleGenerativeAI({ apiKey });
  const startedAt = Date.now();
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: google(CHAT_MODEL),
    system,
    messages: modelMessages,
    temperature: 0.2,
    maxOutputTokens: 2048,
    abortSignal,
    onFinish: ({ text, usage }) => {
      console.log(
        `chat ok repo=${repoId} model=${CHAT_MODEL} cited=${citations.length} chars=${text.length} tokens=${usage.totalTokens ?? "?"} elapsed_ms=${Date.now() - startedAt}`,
      );
    },
  });

  return { result, citations };
}
