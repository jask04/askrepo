// Vitest setup. Pulls in .env (if present) so the integration test can
// see DATABASE_URL during local runs, and supplies safe fallbacks so
// unit tests work even with no .env at all.

try {
  // Node 20.6+ stable.
  process.loadEnvFile?.(".env");
} catch {
  // .env missing — fine, fallbacks below cover unit tests.
}

process.env.SESSION_SECRET ??=
  "test_session_secret_must_be_at_least_32_chars_long";
process.env.DATABASE_URL ??=
  "postgresql://nobody:nobody@localhost:5432/none";
process.env.DIRECT_DATABASE_URL ??=
  "postgresql://nobody:nobody@localhost:5432/none";
process.env.GOOGLE_API_KEY ??= "test_google_api_key";
