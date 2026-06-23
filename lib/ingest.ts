import path from "node:path";

import { chunkText, type Chunk } from "./chunk";

// Allow-list of extensions we treat as text. Everything else is
// skipped — including images, archives, fonts, compiled binaries, and
// anything we can't sensibly chunk.
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".html",
  ".sh",
  ".sql",
  ".txt",
]);

// Directories we always skip during the tree walk.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  "coverage",
]);

// Specific file names we always skip (lockfiles, generated artefacts).
const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
]);

export const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1MB per file
export const MAX_TOTAL_CHUNK_BYTES = 5 * 1024 * 1024; // 5MB chunked text
export const MAX_REPO_SIZE_KB = 50_000; // 50MB from GitHub's repo metadata

export type RepoSizeCheck =
  | { ok: true; sizeKb: number }
  | { ok: false; kind: "too_large"; sizeKb: number }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "unavailable" };

/**
 * Cheap pre-flight: ask GitHub's REST API how big the repo is so we
 * can reject obvious giants before fetching file contents. The GitHub
 * API is rate-limited (60/h unauthenticated) — if the call fails we log
 * and proceed, since the 5MB chunked-text cap is the real backstop.
 */
export async function checkGithubRepoSize(
  owner: string,
  name: string,
): Promise<RepoSizeCheck> {
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "askrepo",
        },
      },
    );
  } catch {
    return { ok: false, kind: "unavailable" };
  }
  if (resp.status === 404) return { ok: false, kind: "not_found" };
  if (!resp.ok) return { ok: false, kind: "unavailable" };
  let data: { size?: unknown };
  try {
    data = (await resp.json()) as { size?: unknown };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
  const sizeKb = typeof data.size === "number" ? data.size : 0;
  if (sizeKb > MAX_REPO_SIZE_KB) {
    return { ok: false, kind: "too_large", sizeKb };
  }
  return { ok: true, sizeKb };
}

/**
 * Latest commit SHA on the repo's default branch, or null if GitHub is
 * unavailable. Used to tell whether an indexed repo has gone stale.
 */
export async function fetchLatestCommitSha(
  owner: string,
  name: string,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?per_page=1`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "askrepo",
        },
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as Array<{ sha?: unknown }>;
    const sha = data[0]?.sha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

export type IngestedFile = {
  path: string;
  chunks: Chunk[];
};

export type IngestSuccess = {
  ok: true;
  commitSha: string;
  files: IngestedFile[];
  totalBytes: number;
};

export type IngestFailure =
  | { ok: false; kind: "size_exceeded"; totalBytes: number }
  | { ok: false; kind: "clone_failed"; message: string };

export type IngestResult = IngestSuccess | IngestFailure;

/**
 * Read a GitHub repo through the GitHub tree API, fetch text files from
 * raw.githubusercontent.com, chunk them, and return the chunks in memory.
 * This avoids relying on a `git` binary in serverless runtimes.
 */
export async function cloneAndChunk(url: string): Promise<IngestResult> {
  const repo = parseGithubUrl(url);
  if (!repo) {
    return {
      ok: false,
      kind: "clone_failed",
      message: "url must point to a github.com repository",
    };
  }

  const commitSha = await fetchLatestCommitSha(repo.owner, repo.name);
  if (!commitSha) {
    return {
      ok: false,
      kind: "clone_failed",
      message: "could not resolve default branch commit",
    };
  }

  let tree: GithubTreeEntry[];
  try {
    tree = await fetchGithubTree(repo.owner, repo.name, commitSha);
  } catch (err) {
    return {
      ok: false,
      kind: "clone_failed",
      message: err instanceof Error ? err.message : "tree fetch failed",
    };
  }

  const files: IngestedFile[] = [];
  let totalBytes = 0;

  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (!entry.path) continue;
    if (entry.size > MAX_FILE_BYTES) continue;
    if (shouldSkipPath(entry.path)) continue;
    const ext = path.posix.extname(entry.path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    let content: string;
    try {
      content = await fetchRawTextFile(
        repo.owner,
        repo.name,
        commitSha,
        entry.path,
      );
    } catch (err) {
      return {
        ok: false,
        kind: "clone_failed",
        message:
          err instanceof Error
            ? `failed to read ${entry.path}: ${err.message}`
            : `failed to read ${entry.path}`,
      };
    }
    if (content.length === 0) continue;

    const chunks = chunkText(content);
    if (chunks.length === 0) continue;

    const bytes = chunks.reduce(
      (acc, c) => acc + Buffer.byteLength(c.content, "utf8"),
      0,
    );
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_CHUNK_BYTES) {
      return { ok: false, kind: "size_exceeded", totalBytes };
    }

    files.push({ path: entry.path, chunks });
  }

  return { ok: true, commitSha, files, totalBytes };
}

type GithubTreeEntry = {
  path: string;
  type: string;
  size: number;
};

async function fetchGithubTree(
  owner: string,
  name: string,
  commitSha: string,
): Promise<GithubTreeEntry[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "askrepo",
      },
    },
  );
  if (!resp.ok) {
    throw new Error(`GitHub tree request failed (${resp.status})`);
  }

  const data = (await resp.json()) as {
    tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }>;
    truncated?: unknown;
  };
  if (data.truncated === true) {
    throw new Error("GitHub tree response was truncated");
  }
  if (!Array.isArray(data.tree)) {
    throw new Error("GitHub tree response was malformed");
  }

  return data.tree.flatMap((entry) => {
    if (
      typeof entry.path !== "string" ||
      typeof entry.type !== "string" ||
      typeof entry.size !== "number"
    ) {
      return [];
    }
    return [{ path: entry.path, type: entry.type, size: entry.size }];
  });
}

async function fetchRawTextFile(
  owner: string,
  name: string,
  commitSha: string,
  filePath: string,
): Promise<string> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const resp = await fetch(
    `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(commitSha)}/${encodedPath}`,
    {
      headers: {
        "user-agent": "askrepo",
      },
    },
  );
  if (!resp.ok) {
    throw new Error(`raw file request failed (${resp.status})`);
  }
  return resp.text();
}

function shouldSkipPath(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return true;
  return SKIP_FILES.has(path.posix.basename(filePath));
}

export type ParsedRepoUrl = {
  normalizedUrl: string;
  owner: string;
  name: string;
};

/**
 * Parse and normalize a github.com URL into `{ owner, name,
 * normalizedUrl }`. Returns null if the URL doesn't look like a
 * github.com repo path.
 */
export function parseGithubUrl(input: string): ParsedRepoUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const segments = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  let name = segments[1];
  if (!owner || !name) return null;
  if (name.endsWith(".git")) name = name.slice(0, -4);

  return {
    owner,
    name,
    normalizedUrl: `https://github.com/${owner}/${name}`,
  };
}
