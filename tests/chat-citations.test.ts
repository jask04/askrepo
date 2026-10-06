import { beforeEach, describe, expect, it, vi } from "vitest";
import { readUIMessageStream, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import type { CitationMetadata } from "@/lib/citations";
import readme from "./fixtures/realtime-readme.json";

const mocks = vi.hoisted(() => ({ model: null as LanguageModel | null, retrieve: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => () => mocks.model }));
vi.mock("@/lib/retrieve", () => ({ retrieveTopK: mocks.retrieve }));
vi.mock("@/lib/session", () => ({ resolveApiKey: async () => ({
  ok: true, mode: "tour", apiKey: "fixture-api-key",
}) }));
vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 9 }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { POST } from "@/app/api/chat/route";

const marker = (id: string, text: string) => "[cite:" + id + " " + JSON.stringify(text) + "]";
const entrypoint = "server.ts Production entrypoint (api + workers)";
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function modelFor(text: string, error = false) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "answer" });
          for (const char of text) {
            controller.enqueue({ type: "text-delta", id: "answer", delta: char });
          }
          if (error) controller.enqueue({ type: "error", error: new Error("fixture-api-key upstream failure") });
          controller.enqueue({ type: "text-end", id: "answer" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          controller.close();
        },
      }),
    }),
  });
  mocks.model = model;
  return model;
}

async function requestAnswer(text: string, error = false) {
  const model = modelFor(text, error);
  const response = await POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId: "fixture", messages: [{
      id: "question", role: "user", parts: [{ type: "text", text: "Where is the main server entrypoint?" }],
    }] }),
  }));
  const sse = await response.text();
  const parts = sse.split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk<CitationMetadata>);
  return { response, sse, parts, model };
}

async function clientMessage(parts: UIMessageChunk<CitationMetadata>[]) {
  let message: UIMessage<CitationMetadata> | undefined;
  const stream = new ReadableStream<UIMessageChunk<CitationMetadata>>({
    start(controller) { parts.forEach((part) => controller.enqueue(part)); controller.close(); },
  });
  for await (const next of readUIMessageStream<UIMessage<CitationMetadata>>({ stream })) message = next;
  return message;
}

beforeEach(() => {
  mocks.retrieve.mockResolvedValue([{ ...readme, id: "readme", score: 1, distance: 0 }]);
});

describe("citation streaming route and actual AI SDK client playback", () => {
  it("resolves the known README case and delivers its evidence in message metadata", async () => {
    const { response, parts, model } = await requestAnswer("The entrypoint is server.ts. " + marker("S1", entrypoint));
    expect(response.status).toBe(200);
    const message = await clientMessage(parts);
    expect(message?.parts).toContainEqual({ type: "text", text: "The entrypoint is server.ts. [C1]", state: "done" });
    expect(message?.metadata?.citations).toMatchObject([{
      id: "C1", sourceId: "S1", path: "README.md", startLine: 233, endLine: 233,
      url: "https://github.com/jask04/realtime-notifications/blob/" + readme.repo.commitSha + "/README.md#L233",
    }]);
    expect(parts.some((part) => part.type === "message-metadata")).toBe(true);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("exact text copied from source S1");
  });

  it("streams multiple valid citations while rejecting fabricated IDs, quotes and line guesses", async () => {
    mocks.retrieve.mockResolvedValue([
      { ...readme, id: "readme", score: 1, distance: 0 },
      { repo: readme.repo, id: "server", path: "server.ts", content: "await app.listen({ port: 3000 });\nawait startWorkers();",
        startLine: 18, endLine: 19, score: 0.9, distance: 0.1 },
    ]);
    const { parts } = await requestAnswer(
      marker("S1", entrypoint) + " " +
      marker("S2", "await app.listen({ port: 3000 });\nawait startWorkers();") + " " +
      marker("S1", entrypoint) + " " + marker("S2", entrypoint) + " [README.md:214] [C1]",
    );
    const message = await clientMessage(parts);
    expect(message?.metadata?.citations).toHaveLength(2);
    const text = message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    expect(text).toBe("[C1] [C2] [C1] [unverified source] [unverified source] [unverified source]");
  });

  it("finishes an incomplete streamed reference without publishing a citation", async () => {
    const { parts } = await requestAnswer('Some text [cite:S1 "unfinished');
    const message = await clientMessage(parts);
    expect(message?.metadata?.citations).toEqual([]);
    expect(message?.parts).toContainEqual({ type: "text", text: "Some text [unverified source]", state: "done" });
  });

  it("preserves streamed error handling without exposing the key", async () => {
    const { sse, parts } = await requestAnswer("Some text", true);
    expect(parts.some((part) => part.type === "error")).toBe(true);
    expect(sse).not.toContain("fixture-api-key");
    expect(sse).toContain("Something went wrong on our end.");
  });
});
