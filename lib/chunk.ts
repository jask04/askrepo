import { getEncoding, type Tiktoken } from "js-tiktoken";

// We chunk text by line, using cl100k_base as a stand-in for Gemini's
// SentencePiece tokenizer. Gemini doesn't ship a JS tokenizer, so this
// over-counts slightly compared to the real model — fine, because we
// only need a stable size proxy to keep chunks well under the embedding
// model's input limit.
let cachedEncoder: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (!cachedEncoder) cachedEncoder = getEncoding("cl100k_base");
  return cachedEncoder;
}

export const DEFAULT_CHUNK_TOKENS = 600;
export const DEFAULT_OVERLAP_TOKENS = 80;

export type Chunk = {
  content: string;
  tokenCount: number;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
};

export type ChunkOptions = {
  chunkTokens?: number;
  overlapTokens?: number;
};

/**
 * Split a text file into overlapping line-aligned chunks of up to
 * `chunkTokens` tokens each, with `overlapTokens` of repeated content
 * between adjacent chunks. Line ranges (1-indexed) are tracked so
 * answers can cite back to the source.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkTokens = options.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (overlapTokens >= chunkTokens) {
    throw new Error("overlapTokens must be smaller than chunkTokens");
  }
  if (text.length === 0) return [];

  const enc = encoder();
  const lines = text.split("\n");
  // Token count per line + 1 for the newline that joins it to the next.
  const perLine: number[] = lines.map(
    (line) => enc.encode(line).length + 1,
  );

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < lines.length) {
    let total = 0;
    let end = start;
    while (end < lines.length) {
      const next = perLine[end] ?? 0;
      if (total + next > chunkTokens && end > start) break;
      total += next;
      end += 1;
    }
    // Guarantee forward progress: if a single line exceeds the budget,
    // keep it as its own chunk.
    if (end === start) {
      total = perLine[start] ?? 0;
      end = start + 1;
    }

    chunks.push({
      content: lines.slice(start, end).join("\n"),
      tokenCount: total,
      startLine: start + 1,
      endLine: end,
    });

    if (end >= lines.length) break;

    // Step back by overlap tokens to provide context continuity.
    let overlapAcc = 0;
    let nextStart = end;
    while (nextStart > start + 1 && overlapAcc < overlapTokens) {
      nextStart -= 1;
      overlapAcc += perLine[nextStart] ?? 0;
    }
    start = nextStart;
  }

  return chunks;
}
