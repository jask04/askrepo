// Parsing for inline source citations in chat answers.
//
// The model is instructed to cite repo source as [path:start-end] (a
// single line as [path:line]). These helpers find those spans and turn
// them into links to the file on github.com at the indexed commit.

export type Citation = {
  /** The full matched text including brackets, e.g. "[src/index.ts:42-58]". */
  raw: string;
  /** Repo-relative file path, e.g. "src/index.ts". */
  path: string;
  /** 1-indexed first line. */
  startLine: number;
  /** 1-indexed last line; equal to startLine for a single-line citation. */
  endLine: number;
};

export type RepoRef = {
  owner: string;
  name: string;
  commitSha: string;
};

export type Segment =
  | { kind: "text"; value: string }
  | { kind: "citation"; citation: Citation };

// [path:start] or [path:start-end]. The path may contain "/", "." and
// "-", but not whitespace, "]" or ":".
const CITATION_SOURCE = "\\[([^\\]\\s:]+):(\\d+)(?:-(\\d+))?\\]";

/** A fresh global regex — callers that keep state need their own. */
function citationRegex(): RegExp {
  return new RegExp(CITATION_SOURCE, "g");
}

function toCitation(match: RegExpExecArray): Citation {
  const raw = match[0];
  const path = match[1] ?? "";
  const startLine = Number(match[2] ?? "0");
  const endRaw = match[3];
  const endLine = endRaw ? Number(endRaw) : startLine;
  return {
    raw,
    path,
    startLine,
    // Guard against a reversed range like [file:20-10].
    endLine: Math.max(startLine, endLine),
  };
}

/** Find every citation in a block of text, in order. */
export function parseCitations(text: string): Citation[] {
  const regex = citationRegex();
  const out: Citation[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    out.push(toCitation(match));
  }
  return out;
}

/**
 * Split text into alternating plain-text and citation segments. Text
 * with no citations returns a single text segment (or none, if empty).
 */
export function splitByCitations(text: string): Segment[] {
  const regex = citationRegex();
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: "citation", citation: toCitation(match) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

/** Build a github.com blob URL with a line anchor for a citation. */
export function buildSourceUrl(repo: RepoRef, citation: Citation): string {
  const base = `https://github.com/${repo.owner}/${repo.name}/blob/${repo.commitSha}/${citation.path}`;
  return citation.startLine === citation.endLine
    ? `${base}#L${citation.startLine}`
    : `${base}#L${citation.startLine}-L${citation.endLine}`;
}
