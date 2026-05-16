import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

// The visitor's Gemini API key lives in exactly one place: this
// AES-encrypted, httpOnly session cookie. It is never written to the
// database, never logged, and never sent back to the client.

export type SessionMode = "byok" | "tour";

export type SessionData = {
  // Present only in BYOK mode. The visitor's own Gemini key.
  apiKey?: string;
  mode?: SessionMode;
};

function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return {
    password,
    cookieName: "askrepo_session",
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    },
  };
}

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions());
}

export type ResolvedKey =
  | { ok: true; apiKey: string; mode: SessionMode }
  | { ok: false };

/**
 * Resolve the Gemini API key for the current request.
 *
 * - BYOK mode: the visitor's key from the encrypted cookie.
 * - Tour mode: the host's key from process.env.
 * - Neither: { ok: false }, and the caller should return 401.
 */
export async function resolveApiKey(): Promise<ResolvedKey> {
  const session = await getSession();

  if (session.mode === "byok" && session.apiKey) {
    return { ok: true, apiKey: session.apiKey, mode: "byok" };
  }

  if (session.mode === "tour") {
    const hostKey = process.env.GOOGLE_API_KEY;
    if (hostKey) {
      return { ok: true, apiKey: hostKey, mode: "tour" };
    }
  }

  return { ok: false };
}
