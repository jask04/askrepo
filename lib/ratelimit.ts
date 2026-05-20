// Per-IP sliding-window rate limits backed by Upstash Redis.
//
// If the Upstash env vars are absent (e.g. local dev without
// provisioning), the limiter logs a one-time warning and lets every
// request through. The deployed site enforces limits once the Vercel
// marketplace integration injects the env vars.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { errorJson } from "./sanitise";

export type LimitKind =
  | "ingest-byok"
  | "ingest-tour"
  | "chat-byok"
  | "chat-tour";

type Duration = `${number} ${"s" | "m" | "h" | "d"}`;

const LIMITS: Record<LimitKind, { limit: number; window: Duration }> = {
  "ingest-byok": { limit: 10, window: "1 h" },
  "ingest-tour": { limit: 3, window: "1 h" },
  "chat-byok": { limit: 60, window: "1 h" },
  "chat-tour": { limit: 10, window: "1 h" },
};

// Tri-state: undefined = not initialised yet, null = no env vars (disabled).
let redisInstance: Redis | null | undefined;
let warned = false;
const limiters = new Map<LimitKind, Ratelimit>();

function getRedis(): Redis | null {
  if (redisInstance !== undefined) return redisInstance;
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    if (!warned) {
      console.warn(
        "ratelimit: Upstash env vars not set — rate limiting is disabled",
      );
      warned = true;
    }
    redisInstance = null;
    return null;
  }
  redisInstance = new Redis({ url, token });
  return redisInstance;
}

function getLimiter(kind: LimitKind): Ratelimit | null {
  const cached = limiters.get(kind);
  if (cached) return cached;
  const redis = getRedis();
  if (!redis) return null;
  const { limit, window } = LIMITS[kind];
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, window),
    analytics: false,
    prefix: `askrepo:${kind}`,
  });
  limiters.set(kind, limiter);
  return limiter;
}

export type RateCheck = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the window resets. */
  reset: number;
};

/** Check (and consume) one slot for `identifier` against the named bucket. */
export async function checkRateLimit(
  identifier: string,
  kind: LimitKind,
): Promise<RateCheck> {
  const limiter = getLimiter(kind);
  if (!limiter) {
    // Permit-all when not configured.
    return {
      allowed: true,
      limit: LIMITS[kind].limit,
      remaining: LIMITS[kind].limit,
      reset: Date.now() + 60 * 60 * 1000,
    };
  }
  const { success, limit, remaining, reset } = await limiter.limit(identifier);
  return { allowed: success, limit, remaining, reset };
}

/** 429 response with Retry-After + X-RateLimit-* headers. */
export function rateLimitResponse(result: RateCheck): Response {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  const base = errorJson({
    status: 429,
    message: "You have hit the rate limit. Please wait and try again.",
    extra: {
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    },
  });
  base.headers.set("retry-after", String(retryAfter));
  base.headers.set("x-ratelimit-limit", String(result.limit));
  base.headers.set("x-ratelimit-remaining", String(result.remaining));
  base.headers.set("x-ratelimit-reset", String(result.reset));
  return base;
}
