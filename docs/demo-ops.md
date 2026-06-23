# Demo operations

askrepo's resume demo depends on four live services:

- Vercel for the Next.js app and the daily cron invocation.
- Neon Postgres + pgvector for the indexed tour repository.
- Upstash Redis for the tour-mode rate limiter.
- Google AI Studio for embeddings and chat in tour mode.

## Persistent tour seed

The public tour should be configured with a stable repo URL, not only a
database row id:

```text
TOUR_REPO_URL=https://github.com/jask04/realtime-notifications
```

`TOUR_REPO_ID` is still supported for the existing deployment, but it is
only an optimization. If Neon data is ever reset and a new row id is
created, the app falls back to finding the tour by `TOUR_REPO_URL`.

## Daily maintenance

`vercel.json` schedules `/api/cron/demo` once per day. The route is
protected by:

```text
CRON_SECRET=<openssl rand -hex 32>
```

Each run:

1. Finds the tour repo by `TOUR_REPO_ID`, then by `TOUR_REPO_URL`.
2. Counts documents and embedded vectors in Neon.
3. Compares the indexed commit to the latest GitHub commit.
4. Re-indexes the tour repo if it is missing, failed, empty, or stale.
5. Touches the Redis-backed tour chat rate limiter.
6. Runs a small Gemini chat smoke test against the indexed repo.

Manual run:

```bash
ASKREPO_URL=https://askrepo-one.vercel.app \
CRON_SECRET=<same secret as Vercel> \
npm run demo:maintain
```

## Public availability check

`.github/workflows/demo-availability.yml` runs a secondary scheduled
check and can be triggered manually from GitHub Actions. It uses the
public app exactly like a visitor:

1. Load `/`.
2. `POST /api/tour`.
3. Load `/chat/{repoId}`.
4. Ask one question through `POST /api/chat`.

Local run:

```bash
ASKREPO_URL=https://askrepo-one.vercel.app npm run demo:check
```

GitHub scheduled workflows are useful for visibility, but they can be
disabled after long repository inactivity. Vercel Cron is the primary
maintenance path.

## If the demo breaks

1. Check the latest Vercel runtime log for `/api/cron/demo`.
2. Manually run `npm run demo:maintain` with `ASKREPO_URL` and
   `CRON_SECRET`.
3. If the response says the tour is missing and cannot be indexed, verify
   `TOUR_REPO_URL`, `GOOGLE_API_KEY`, `DATABASE_URL`, and
   `DIRECT_DATABASE_URL` in Vercel.
4. If the response mentions the rate limiter, check the Upstash Redis
   database and the Vercel-injected `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` environment variables.
5. Re-run `npm run demo:check` after maintenance succeeds.
