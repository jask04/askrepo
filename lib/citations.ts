// Only source IDs plus quotes found in retrieved excerpts become links.
export type RepoRef = { owner: string; name: string; commitSha: string };
export type SourceExcerpt = {
  repo: RepoRef;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
};
export type CitationSource = SourceExcerpt & { id: string };
export type ResolvedCitation = {
  id: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Actual source lines, so the reader can inspect the cited evidence. */
  excerpt: string;
  url: string;
};
export type CitationMetadata = { citations: ResolvedCitation[] };

const MAX_QUOTE_CHARS = 500;
const MAX_QUOTE_LINES = 8;
const MAX_MARKER_CHARS = 2048;
const UNVERIFIED = "[unverified source]";
const MODEL_REFERENCE = /^\[cite:(S[1-9]\d*) ("(?:[^"\\]|\\.)*")\]$/;
const UNSUPPORTED_REFERENCE = /^\[(?:C\d+|[^\]\s:]+:\d+(?:-\d+)?)\]$/;

function safeSource(source: SourceExcerpt): boolean {
  return (
    /^[a-z\d][a-z\d-]*$/i.test(source.repo.owner) &&
    /^[\w.-]+$/.test(source.repo.name) &&
    /^[a-f\d]{40}$/i.test(source.repo.commitSha) &&
    source.path.length > 0 &&
    !/[\\\x00-\x1f\x7f]/.test(source.path) &&
    source.path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    Number.isSafeInteger(source.startLine) && source.startLine > 0 &&
    Number.isSafeInteger(source.endLine) &&
    source.endLine - source.startLine + 1 === source.content.split("\n").length
  );
}

export function createCitationSources(excerpts: SourceExcerpt[]): CitationSource[] {
  return excerpts.filter(safeSource).map((source, index) => ({
    ...source, id: `S${index + 1}`,
  }));
}

// Tolerate indentation, tabs and CRLF copying; never fuzzy-match words,
// punctuation, ellipses or reordered lines. Line boundaries stay intact.
function normaliseQuote(text: string): string {
  return text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").trim();
}

export function resolveCitation(
  sources: CitationSource[], sourceId: string, quote: string,
): Omit<ResolvedCitation, "id"> | null {
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source || !safeSource(source) || quote.length > MAX_QUOTE_CHARS) return null;
  const needle = normaliseQuote(quote);
  if (needle.replace(/\s/g, "").length < 12 || needle.split("\n").length > MAX_QUOTE_LINES) return null;

  const lines = source.content.split("\n");
  const haystack = lines.map(normaliseQuote).join("\n");
  const offset = haystack.indexOf(needle);
  if (offset < 0 || haystack.indexOf(needle, offset + 1) >= 0) return null;
  const first = haystack.slice(0, offset).split("\n").length - 1;
  const last = first + needle.split("\n").length - 1;
  const startLine = source.startLine + first;
  const endLine = source.startLine + last;
  if (endLine > source.endLine) return null;
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  const anchor = startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
  return {
    sourceId, path: source.path, startLine, endLine,
    excerpt: lines.slice(first, last + 1).join("\n"),
    url: `https://github.com/${source.repo.owner}/${source.repo.name}/blob/${source.repo.commitSha}/${path}${anchor}`,
  };
}

/** Incrementally validate markers, including JSON strings split across deltas. */
export class CitationResolver {
  readonly citations: ResolvedCitation[] = [];
  private pending = "";

  constructor(private readonly sources: CitationSource[]) {}

  push(text: string): string {
    this.pending += text;
    let output = "";
    while (this.pending) {
      const open = this.pending.indexOf("[");
      if (open < 0) {
        output += this.pending;
        this.pending = "";
        break;
      }
      output += this.pending.slice(0, open);
      this.pending = this.pending.slice(open);
      const modelReference = this.pending.startsWith("[cite:");
      let close = -1;
      let quoted = false;
      let escaped = false;
      for (let i = 1; i < this.pending.length; i += 1) {
        const char = this.pending[i];
        if (modelReference && escaped) { escaped = false; continue; }
        if (modelReference && quoted && char === "\\") { escaped = true; continue; }
        if (modelReference && char === '"') quoted = !quoted;
        if (char === "]" && !quoted) { close = i; break; }
      }
      if (close < 0) {
        if (this.pending.length > MAX_MARKER_CHARS) {
          output += UNVERIFIED;
          this.pending = "";
        }
        break;
      }
      const marker = this.pending.slice(0, close + 1);
      this.pending = this.pending.slice(close + 1);
      if (modelReference) {
        output += this.resolveMarker(marker);
      } else {
        output += UNSUPPORTED_REFERENCE.test(marker) ? UNVERIFIED : marker.replace(
          /\[(?:C\d+|[^\]\s:]+:\d+(?:-\d+)?)\]/g, UNVERIFIED,
        );
      }
    }
    return output;
  }

  finish(): string {
    const text = this.pending;
    this.pending = "";
    return text.startsWith("[cite:") || ("[cite:".startsWith(text) && text.length > 1)
      ? UNVERIFIED : text;
  }

  private resolveMarker(marker: string): string {
    if (marker.length > MAX_MARKER_CHARS) return UNVERIFIED;
    const match = MODEL_REFERENCE.exec(marker);
    if (!match) return UNVERIFIED;
    let quote: unknown;
    try { quote = JSON.parse(match[2]!); } catch { return UNVERIFIED; }
    if (typeof quote !== "string") return UNVERIFIED;
    const citation = resolveCitation(this.sources, match[1]!, quote);
    if (!citation) return UNVERIFIED;
    let existing = this.citations.find((item) => item.url === citation.url);
    if (!existing) {
      existing = { ...citation, id: `C${this.citations.length + 1}` };
      this.citations.push(existing);
    }
    return `[${existing.id}]`;
  }
}
