import { describe, expect, it } from "vitest";

import { chunkText } from "@/lib/chunk";

describe("chunkText", () => {
  it("returns no chunks for an empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns one chunk for a single short line", () => {
    const chunks = chunkText("hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("hello world");
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(1);
    expect(chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it("tracks 1-indexed line ranges per chunk", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    // First chunk always starts at line 1.
    expect(chunks[0]?.startLine).toBe(1);
    // Last chunk must end at the final line.
    expect(chunks.at(-1)?.endLine).toBe(lines.length);
    // The content of each chunk equals slice(startLine-1, endLine).
    for (const c of chunks) {
      const expected = lines.slice(c.startLine - 1, c.endLine).join("\n");
      expect(c.content).toBe(expected);
    }
  });

  it("respects the chunk token limit", () => {
    // Long input, small budget — forces several chunks.
    const text = Array.from({ length: 200 }, (_, i) =>
      `word${i} `.repeat(5).trim(),
    ).join("\n");
    const chunks = chunkText(text, { chunkTokens: 60, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // The chunker allows one-line overrun for forward progress,
      // so the assertion is "at most one line over the cap".
      const isSingleLine = c.startLine === c.endLine;
      expect(c.tokenCount).toBeLessThanOrEqual(isSingleLine ? 1_000 : 60);
    }
  });

  it("produces overlapping ranges between adjacent chunks", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} body`);
    const chunks = chunkText(lines.join("\n"), {
      chunkTokens: 30,
      overlapTokens: 8,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      // Next chunk must overlap with — or directly continue from —
      // the previous one, never skip lines.
      expect(curr.startLine).toBeLessThanOrEqual(prev.endLine + 1);
      // And must move forward.
      expect(curr.startLine).toBeGreaterThan(prev.startLine);
    }
  });

  it("rejects an overlap >= the chunk size", () => {
    expect(() => chunkText("a\nb\nc", { chunkTokens: 10, overlapTokens: 10 }))
      .toThrowError(/overlap/i);
  });
});
