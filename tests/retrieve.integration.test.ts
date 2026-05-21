import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock embedBatch to produce deterministic 768-dim vectors so the
// nearest-neighbour query is reproducible. retrieveTopK uses
// embedBatch under the hood to embed the query.
vi.mock("@/lib/embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed")>();
  return {
    ...actual,
    embedBatch: vi.fn(async (texts: string[]) => texts.map(fakeVector)),
  };
});

import { prisma } from "@/lib/db";
import { retrieveTopK } from "@/lib/retrieve";

const integrationOn =
  process.env.RUN_INTEGRATION === "1" || process.env.CI === "true";

function fakeVector(text: string): number[] {
  // 768-dim 1-hot vector keyed by a stable hash of the text. Two
  // matching strings map to identical vectors → cosine distance 0,
  // which is what retrieveTopK orders by.
  let h = 0;
  for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  const dim = Math.abs(h) % 768;
  const v = new Array(768).fill(0);
  v[dim] = 1;
  return v;
}

describe.runIf(integrationOn)("retrieveTopK (integration)", () => {
  const testUrl = `https://test.example/${randomUUID()}`;
  let repoId = "";

  beforeAll(async () => {
    const repo = await prisma.repo.create({
      data: {
        url: testUrl,
        owner: "test",
        name: "fixture",
        commitSha: "0".repeat(40),
        status: "READY",
      },
    });
    repoId = repo.id;

    const seeds = [
      { path: "alpha.ts", content: "alpha auth handler" },
      { path: "beta.ts", content: "beta data layer" },
      { path: "gamma.ts", content: "gamma rendering engine" },
    ];
    for (const s of seeds) {
      const literal = `[${fakeVector(s.content).join(",")}]`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Document"
           (id, "repoId", path, "chunkIndex", content, "tokenCount",
            "startLine", "endLine", embedding, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, NOW())`,
        randomUUID(),
        repoId,
        s.path,
        0,
        s.content,
        10,
        1,
        5,
        literal,
      );
    }
  });

  afterAll(async () => {
    if (repoId) {
      // Cascade delete drops the seeded Documents.
      await prisma.repo.delete({ where: { id: repoId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("returns the document whose embedding is closest to the query", async () => {
    const results = await retrieveTopK(
      repoId,
      "alpha auth handler",
      "fake-key",
      3,
    );
    expect(results).toHaveLength(3);
    expect(results[0]?.path).toBe("alpha.ts");
    // distance 0 because the mock returns the same vector for identical
    // text → score 1.
    expect(results[0]?.distance).toBeCloseTo(0);
  });
});
