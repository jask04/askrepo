#!/usr/bin/env node

const baseUrl = (
  process.env.ASKREPO_URL ||
  process.argv[2] ||
  "https://askrepo-one.vercel.app"
).replace(/\/+$/, "");

const cronSecret = process.env.CRON_SECRET;
if (!cronSecret) {
  throw new Error("CRON_SECRET is required to run demo maintenance");
}

const response = await fetch(`${baseUrl}/api/cron/demo`, {
  method: "GET",
  signal: AbortSignal.timeout(300_000),
  headers: {
    authorization: `Bearer ${cronSecret}`,
    "user-agent": "askrepo-demo-maintenance",
  },
});

const text = await response.text();
let body = text;
try {
  body = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  // Keep non-JSON responses as-is.
}

console.log(body);

if (!response.ok) {
  process.exitCode = 1;
}
