# askrepo

[![CI](https://github.com/jask04/askrepo/actions/workflows/ci.yml/badge.svg)](https://github.com/jask04/askrepo/actions/workflows/ci.yml)

Chat with any public GitHub repo. Paste a URL, ask questions, and get
streaming answers with citations that link back to the exact lines on
GitHub. You bring your own free [Google AI Studio](https://aistudio.google.com/apikey)
key, so the host pays nothing for visitor traffic.

![askrepo demo](docs/demo.gif)

**Live demo:** https://askrepo-one.vercel.app

The demo's "Try the tour repo" button runs against a pre-indexed copy of
[realtime-notifications](https://github.com/jask04/realtime-notifications),
using the host's key behind a strict per-IP rate limit — so you can look
around without fetching a key first.

## What it does

1. You paste a public GitHub URL and your own Gemini API key (or click the
   tour button to use the host's).
2. The server reads the repo through GitHub's tree/raw file APIs, splits
   every text file into overlapping token-sized chunks, embeds each chunk
   with Gemini, and stores the vectors in Postgres + pgvector.
3. You ask a question. The server embeds the question, pulls the nearest
   chunks by vector similarity, and streams a Gemini answer grounded in
   them.
4. Source references are checked against quoted retrieved text. The server
   finds the actual lines and supplies links to that indexed GitHub commit.

Your key lives in exactly one place: an AES-encrypted, httpOnly session
cookie scoped to your browser. It is never written to the database, never
logged, and never sent back to the client.

## Architecture

```
Bring-your-own-key flow
  browser ──POST /api/key { apiKey }──► server validates with one tiny
                                        embed call, then stores it in an
                                        iron-session cookie (AES, httpOnly,
                                        sameSite=strict, ≤24h). The cookie
                                        is read server-side per request and
                                        dropped — never persisted.

Ingest path
  POST /api/ingest ─► resolve key ─► per-IP rate limit ─► GitHub size
   pre-flight ─► tree/raw file fetch ─► chunk (~600 tok / 80 overlap)
   ─► insert Documents (embedding NULL) ─► embed in batches (retry on 429)
   ─► write vectors ─► Repo.status = READY

Query path
  POST /api/chat ─► resolve key ─► per-IP rate limit ─► embed question
   ─► pgvector  ORDER BY embedding <=> query  LIMIT k  ─► build prompt
   from retrieved chunks ─► streamText (Gemini Flash) ─► stream to the
   server quote validation ─► browser ─► validated source links on GitHub
```

## Design notes

**Bring-your-own-key with iron-session.** The defining decision. Visitors
supply their own free Gemini key; it is validated with a single cheap
embed call, then encrypted into a cookie (`httpOnly`, `secure` in
production, `sameSite: 'strict'`, max-age ≤ 24h). Route handlers read it,
make the Gemini call, and discard it. Tour mode is a separate session
state that falls back to the host's `GOOGLE_API_KEY` behind tight per-IP
limits. Errors are passed through a sanitiser that strips both the known
key and any `AIza…`-shaped string before anything reaches a log or the
client.

**Chunking.** Files are split by line into ~600-token chunks with an
80-token overlap, tracking 1-indexed start/end lines so answers can cite
back to source. Token counts use `js-tiktoken` (`cl100k_base`) as a
stable size proxy — Gemini doesn't ship a JS tokenizer, and exact counts
aren't needed for sizing.

**Synchronous ingest with a size cap.** Ingestion runs inside the request
rather than via a background queue. To stay within the function timeout
there are three guards: a GitHub pre-flight that rejects repos over 50 MB,
a 1 MB-per-file limit, and a 5 MB cap on total chunked text. Repo contents
are read through GitHub's tree API and raw file URLs so the app does not
depend on a `git` binary in serverless runtimes. Embedding batches retry
with backoff on free-tier rate limits, so a large repo slows down rather
than failing outright.

**Prompt structure.** Retrieved chunks are supplied as JSON with source IDs,
paths and content. The model must answer only from those excerpts, say when
the answer is missing, and cite a source ID plus a short verbatim quote:
`[cite:S1 "quoted source text"]`. Repository text is treated as untrusted data.

**Source-backed citations.** The server accepts only a unique, contiguous
quote in the named retrieved source (12 non-whitespace characters minimum,
500 characters and 8 lines maximum). Indentation, tabs and CRLF differences
are tolerated; words and punctuation must match. It calculates the exact
quoted line range, never expands a guess to the whole chunk, and streams a
canonical reference with per-message evidence metadata. A remark plugin
links only those validated references; guessed paths/lines and arbitrary
model markdown URLs cannot create source links. Invalid references appear
as unverified, and code blocks remain unlinked. Hover a source link to inspect
the actual cited lines.

Source content and its repository commit are read together in one SQL
snapshot, only for READY indexes. Each answer retains its source URLs if the
repository is later reindexed. Validation proves that the quoted text exists
at the linked lines; it cannot prove every generated claim follows from that
quote, or that retrieval found all relevant code.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript, strict) |
| Database | Postgres 16 + pgvector (Neon) |
| ORM | Prisma 6 |
| Embeddings | Google `gemini-embedding-001` (768-dim) |
| Chat | Google `gemini-3.1-flash-lite` |
| Streaming + UI | Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/react`) |
| Encrypted cookies | iron-session |
| Rate limiting | Upstash Redis (`@upstash/ratelimit`) |
| Styling | Tailwind CSS + shadcn/ui |
| Validation | Zod |
| Tests | Vitest |
| CI | GitHub Actions (Postgres + pgvector service) |
| Deploy | Vercel + Neon + Upstash |

## Running locally

Requirements: Node 22+, a Neon Postgres database (free tier), and a
Google AI Studio key.

```bash
git clone https://github.com/jask04/askrepo
cd askrepo
npm install

cp .env.example .env
# Fill in DATABASE_URL, DIRECT_DATABASE_URL, GOOGLE_API_KEY, SESSION_SECRET
# (generate the secret with: openssl rand -hex 32)

npm run db:migrate     # applies the schema, incl. the pgvector extension
npm run dev
```

Then open http://localhost:3000. Upstash is optional locally — without it,
rate limiting is disabled and logs a one-time warning.

Useful scripts:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest (set RUN_INTEGRATION=1 for the DB test)
npm run demo:check     # exercise the live public tour path
```

## Deploying

- **Vercel** hosts the app. Import the repo; the framework preset is
  detected automatically.
- **Neon** provides Postgres + pgvector. Use the pooled connection string
  for `DATABASE_URL` and the direct (non-pooled) one for
  `DIRECT_DATABASE_URL`; migrations need the direct endpoint.
- **Upstash Redis** (via the Vercel Marketplace) backs rate limiting and
  injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically.

Environment variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection (runtime) |
| `DIRECT_DATABASE_URL` | Neon direct connection (migrations) |
| `GOOGLE_API_KEY` | Host key for tour mode |
| `SESSION_SECRET` | iron-session cookie encryption (≥32 chars) |
| `TOUR_REPO_ID` | Repo id powering the one-click tour (optional) |
| `TOUR_REPO_URL` | Repo URL used to re-seed or refresh the tour index |
| `CRON_SECRET` | Bearer secret for the daily Vercel demo maintenance cron |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash, for rate limiting |

Demo durability is handled by a daily Vercel Cron job at
`/api/cron/demo` plus a secondary GitHub Actions availability check. See
[`docs/demo-ops.md`](docs/demo-ops.md) for the runbook.

An unavailable initial GitHub HEAD lookup returns 503 without rebuilding the
existing index. The final lookup must also succeed before maintenance reports
the tour as current; a chat response alone does not prove freshness.

## What's deliberately not here

- **No background-job system.** Ingestion is synchronous with a hard size
  cap. A queue would be the right call for large repos, but it adds
  operational surface this project doesn't need.
- **No AST/tree-sitter chunking.** Naive token chunking is good enough;
  syntax-aware chunking would improve retrieval precision.
- **No user accounts.** The cookie-bound key is the identity for a browser
  session — no signup, no passwords.
- **No multi-provider abstraction.** One provider (Google) keeps the code
  clean; adding OpenAI/Anthropic adapters would be a small refactor.
- **No reranker.** Top-k vector search feeds the model directly; a
  cross-encoder rerank step would sharpen context selection.

## Repo layout

```
app/
  api/
    chat/route.ts      streaming chat (retrieval + Gemini via AI SDK)
    cron/demo/route.ts daily demo maintenance + smoke check
    ingest/route.ts    fetch, chunk, embed; rate limit + size guards
    key/route.ts       validate + store the visitor's key (iron-session)
    search/route.ts    thin vector-search endpoint for manual testing
    tour/route.ts      switch the session into tour mode
  chat/[repoId]/       chat page (server) wrapping the client panel
  page.tsx             landing page
lib/
  chat.ts              prompt + streamText
  chunk.ts             token-aware chunker
  citations.ts         quote validation + exact source URL resolution
  citation-stream.ts   incremental citation validation during streaming
  config.ts            Zod-validated environment
  db.ts                Prisma singleton
  embed.ts             Gemini embeddings (batched, retry on 429)
  ingest.ts            GitHub tree/raw fetch + size check
  index-repo.ts        shared repo indexing/re-indexing pipeline
  ratelimit.ts         per-IP sliding-window limits (Upstash)
  remark-citations.ts  AST plugin: validated references -> links
  retrieve.ts          pgvector similarity search
  sanitise.ts          error sanitiser (never leaks the key)
  session.ts           iron-session wrapper + key resolution
  tour.ts              tour repo resolution and fallback URL
components/            chat panel, BYOK dialog, ingest form, tour button
prisma/                schema + the pgvector init migration
tests/                 vitest unit + integration tests
```
