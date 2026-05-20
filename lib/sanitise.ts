import { randomUUID } from "node:crypto";

// Sanitise unexpected errors before returning them to the client.
//
// Two jobs:
//   1. Never leak the visitor's API key (or any AIza… prefixed key) into a
//      response body or log line — even if an upstream provider error
//      happens to echo it.
//   2. Collapse 5xx messages to a generic string, while still giving the
//      client a requestId to share with us.

// Matches Google AI Studio keys (and is conservative — won't match the
// short "AIza" literal alone).
const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

export function scrubSensitive(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join("[redacted]");
  }
  out = out.replace(GOOGLE_API_KEY_PATTERN, "[redacted]");
  return out;
}

export function newRequestId(): string {
  return randomUUID();
}

export type SanitisedError = {
  message: string;
  status: number;
  requestId: string;
};

/** Sanitise an unknown error into a status, user-safe message, and id. */
export function sanitiseError(err: unknown, apiKey?: string): SanitisedError {
  const requestId = newRequestId();

  let status = 500;
  let rawMessage = "internal error";
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof e.status === "number") status = e.status;
    else if (typeof e.statusCode === "number") status = e.statusCode;
    if (typeof e.message === "string") rawMessage = e.message;
  } else if (typeof err === "string") {
    rawMessage = err;
  }

  const cleaned = scrubSensitive(rawMessage, apiKey);

  let message: string;
  if (status >= 500) {
    message = "Something went wrong on our end.";
  } else if (status === 401 || status === 403) {
    message = "Your API key was rejected by Google.";
  } else if (status === 429) {
    message = "Your API key is rate limited by Google.";
  } else if (status === 400) {
    message = cleaned || "Bad request.";
  } else {
    message = cleaned || "Request failed.";
  }

  return { message, status, requestId };
}

/**
 * Build a JSON error response with the consistent { error, requestId }
 * shape. Used for both validation errors (with an explicit status) and
 * unexpected errors (via errorResponse below).
 */
export function errorJson(opts: {
  status: number;
  message: string;
  requestId?: string;
  extra?: Record<string, unknown>;
}): Response {
  const requestId = opts.requestId ?? newRequestId();
  return Response.json(
    { error: opts.message, requestId, ...(opts.extra ?? {}) },
    { status: opts.status },
  );
}

/**
 * Wrap an unknown caught error: sanitise it, log with the requestId,
 * and return the JSON response.
 */
export function errorResponse(
  err: unknown,
  opts: { apiKey?: string; logTag: string },
): Response {
  const s = sanitiseError(err, opts.apiKey);
  console.error(
    `${opts.logTag} request_id=${s.requestId} status=${s.status} message=${s.message.slice(0, 200)}`,
  );
  return errorJson({
    status: s.status,
    message: s.message,
    requestId: s.requestId,
  });
}
