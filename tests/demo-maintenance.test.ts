import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: vi.fn(), head: vi.fn(), index: vi.fn(), count: vi.fn(),
  embedded: vi.fn(), rate: vi.fn(), stream: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: {
  document: { count: mocks.count }, $queryRaw: mocks.embedded,
} }));
vi.mock("@/lib/tour", () => ({
  findTourRepo: mocks.repo,
  getTourRepoUrl: () => "https://github.com/example/tour",
}));
vi.mock("@/lib/ingest", () => ({ fetchLatestCommitSha: mocks.head }));
vi.mock("@/lib/index-repo", () => ({ indexGithubRepo: mocks.index }));
vi.mock("@/lib/ratelimit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/chat", () => ({ streamAnswer: mocks.stream }));

import { GET } from "@/app/api/cron/demo/route";

const repo = {
  id: "tour-id", url: "https://github.com/example/tour",
  owner: "example", name: "tour", commitSha: "indexed-head",
  status: "READY", chunkCount: 12, fileCount: 4,
};
const request = () => new Request("http://localhost/api/cron/demo", {
  headers: { authorization: "Bearer test_cron_secret" },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "test_cron_secret");
  vi.stubEnv("GOOGLE_API_KEY", "test_google_api_key");
  vi.stubEnv("NODE_ENV", "test");
  mocks.repo.mockResolvedValue(repo);
  mocks.head.mockResolvedValue("indexed-head");
  mocks.count.mockResolvedValue(12);
  mocks.embedded.mockResolvedValue([{ count: 12 }]);
  mocks.rate.mockResolvedValue({ allowed: true, remaining: 9 });
  mocks.stream.mockResolvedValue({
    result: { text: Promise.resolve("Grounded answer.") }, citations: [{}],
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("demo maintenance freshness", () => {
  it("preserves the index and fails when GitHub HEAD is unavailable", async () => {
    mocks.head.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
    expect(mocks.index).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("does not report a verified refresh when the final HEAD lookup fails", async () => {
    mocks.head.mockResolvedValueOnce("indexed-head").mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
    expect(mocks.index).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("refreshes a stale repo and verifies the resulting commit before chat", async () => {
    mocks.head.mockResolvedValue("current-head");
    mocks.repo.mockResolvedValueOnce(repo).mockResolvedValue({
      ...repo, commitSha: "current-head",
    });
    mocks.index.mockResolvedValue({ repoId: repo.id, commitSha: "current-head" });
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, reindexed: true,
      after: { indexedSha: "current-head", latestSha: "current-head", stale: false },
    });
    expect(mocks.index).toHaveBeenCalledExactlyOnceWith(repo.url, "test_google_api_key");
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it("exercises a healthy repo without rebuilding its index", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reindexed: false,
      after: { stale: false }, smoke: { citations: 1, answerChars: 16 },
    });
    expect(mocks.index).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it("fails a chat smoke answer that contains no validated evidence", async () => {
    mocks.stream.mockResolvedValue({ result: { text: Promise.resolve("Uncited answer.") }, citations: [] });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).ok).toBe(false);
  });
});
