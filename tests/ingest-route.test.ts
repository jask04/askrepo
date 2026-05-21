import { describe, expect, it, vi } from "vitest";

// The route asks session.resolveApiKey for a key. We pretend the
// visitor has none so we can assert the BYOK 401 path without touching
// cookies or upstream services.
vi.mock("@/lib/session", () => ({
  resolveApiKey: vi.fn(async () => ({ ok: false as const })),
  getSession: vi.fn(),
}));

// Don't hit Upstash from a unit test.
vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 10,
    remaining: 10,
    reset: Date.now() + 3_600_000,
  })),
  rateLimitResponse: vi.fn(),
}));

import { POST } from "@/app/api/ingest/route";

describe("POST /api/ingest (BYOK)", () => {
  it("returns 401 + { error, requestId } when no session key is set", async () => {
    const req = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/octocat/Hello-World" }),
    });
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: string; requestId?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error?.toLowerCase()).toContain("api key");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
