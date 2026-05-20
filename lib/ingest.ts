import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import simpleGit from "simple-git";

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
 * can reject obvious giants before paying for a clone. The GitHub API
 * is rate-limited (60/h unauthenticated) — if the call fails we log
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
 * Shallow-clone a repo into a temp directory, walk its tree, chunk
 * every text file, and return the chunks in memory. The temp dir is
 * always cleaned up before the function returns.
 */
export async function cloneAndChunk(url: string): Promise<IngestResult> {
  const workdir = await mkdtemp(path.join(tmpdir(), "askrepo-"));
  try {
    try {
      await simpleGit().clone(url, workdir, [
        "--depth=1",
        "--single-branch",
        "--no-tags",
      ]);
    } catch (err) {
      return {
        ok: false,
        kind: "clone_failed",
        message: err instanceof Error ? err.message : "clone failed",
      };
    }

    const commitSha = (
      await simpleGit(workdir).revparse(["HEAD"])
    ).trim();

    const files: IngestedFile[] = [];
    let totalBytes = 0;

    for await (const file of walk(workdir)) {
      const rel = path.relative(workdir, file.absolutePath);
      if (file.size > MAX_FILE_BYTES) continue;
      const ext = path.extname(rel).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const content = await readFile(file.absolutePath, "utf8");
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

      files.push({ path: rel, chunks });
    }

    return { ok: true, commitSha, files, totalBytes };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

type WalkEntry = { absolutePath: string; size: number };

async function* walk(dir: string): AsyncGenerator<WalkEntry> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const s = await stat(full);
    yield { absolutePath: full, size: s.size };
  }
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
