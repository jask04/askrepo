import { describe, expect, it } from "vitest";

import {
  errorJson,
  errorResponse,
  sanitiseError,
  scrubSensitive,
} from "@/lib/sanitise";

// A realistic-shape Google AI Studio key (39+ chars, AIza prefix).
const FAKE_KEY = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";

describe("scrubSensitive", () => {
  it("redacts a supplied apiKey verbatim", () => {
    const out = scrubSensitive(`request failed with key ${FAKE_KEY} oops`, FAKE_KEY);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("[redacted]");
  });

  it("redacts any AIza-shaped key even when no apiKey is given", () => {
    const out = scrubSensitive(`saw ${FAKE_KEY} in upstream body`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("[redacted]");
  });

  it("is a no-op on plain text", () => {
    expect(scrubSensitive("nothing sensitive")).toBe("nothing sensitive");
  });
});

describe("sanitiseError", () => {
  it("collapses unknown errors to a 500 + generic message", () => {
    const s = sanitiseError(new Error("kaboom in some library"));
    expect(s.status).toBe(500);
    expect(s.message).toBe("Something went wrong on our end.");
    expect(s.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never leaks the apiKey, even on 5xx", () => {
    const err = Object.assign(new Error(`bad key: ${FAKE_KEY}`), { status: 500 });
    const s = sanitiseError(err, FAKE_KEY);
    expect(s.message).not.toContain(FAKE_KEY);
  });

  it("never leaks the apiKey on 4xx either", () => {
    const err = Object.assign(new Error(`detail with ${FAKE_KEY}`), {
      status: 400,
    });
    const s = sanitiseError(err, FAKE_KEY);
    expect(s.message).not.toContain(FAKE_KEY);
    expect(s.status).toBe(400);
  });

  it("maps 401/403 to a friendly key-rejected message", () => {
    expect(sanitiseError({ status: 401, message: "Invalid API key" }).message)
      .toMatch(/rejected/i);
    expect(sanitiseError({ status: 403, message: "forbidden" }).message)
      .toMatch(/rejected/i);
  });

  it("maps 429 to a rate-limited message", () => {
    const s = sanitiseError({ status: 429, message: "quota exceeded" });
    expect(s.status).toBe(429);
    expect(s.message).toMatch(/rate limited/i);
  });

  it("reads statusCode if status is not set (AI SDK style)", () => {
    const s = sanitiseError({ statusCode: 401, message: "x" });
    expect(s.status).toBe(401);
  });
});

describe("errorJson / errorResponse", () => {
  it("errorJson returns the canonical { error, requestId } shape", async () => {
    const resp = errorJson({ status: 400, message: "bad request" });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe("bad request");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("errorResponse sanitises and includes a requestId", async () => {
    const err = Object.assign(new Error(`upstream: ${FAKE_KEY}`), { status: 500 });
    const resp = errorResponse(err, { apiKey: FAKE_KEY, logTag: "test" });
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe("Something went wrong on our end.");
    expect(body.error).not.toContain(FAKE_KEY);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
