#!/usr/bin/env node

const baseUrl = (
  process.env.ASKREPO_URL ||
  process.argv[2] ||
  "https://askrepo-one.vercel.app"
).replace(/\/+$/, "");

const question =
  process.env.ASKREPO_DEMO_QUESTION || "Where is the main server entrypoint?";

function cookieHeader(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const raw = values.length
    ? values
    : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map((value) => value.split(";")[0]).join("; ");
}

async function request(path, init = {}, timeoutMs = 60_000) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent": "askrepo-demo-check",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // SSE and HTML responses are intentionally not JSON.
  }
  return { response, text, json };
}

function assertOk(label, result) {
  if (!result.response.ok) {
    throw new Error(
      `${label} failed with HTTP ${result.response.status}: ${result.text.slice(0, 500)}`,
    );
  }
}

const home = await request("/");
assertOk("homepage", home);

const tour = await request("/api/tour", { method: "POST" });
assertOk("tour start", tour);

const repoId = tour.json?.repoId;
if (typeof repoId !== "string" || repoId.length === 0) {
  throw new Error("tour start response did not include repoId");
}

const cookie = cookieHeader(tour.response);
if (!cookie) {
  throw new Error("tour start did not set a session cookie");
}

const chatPage = await request(`/chat/${encodeURIComponent(repoId)}`, {
  headers: { cookie },
});
assertOk("chat page", chatPage);

const chat = await request(
  "/api/chat",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      repoId,
      messages: [
        {
          id: "demo-check",
          role: "user",
          parts: [{ type: "text", text: question }],
        },
      ],
    }),
  },
  90_000,
);
assertOk("tour chat", chat);

if (!chat.text.includes('"type":"text-delta"') && !chat.text.includes("data: [DONE]")) {
  throw new Error("tour chat response did not look like an AI SDK stream");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      repoId,
      homeStatus: home.response.status,
      chatPageStatus: chatPage.response.status,
      chatStatus: chat.response.status,
      streamBytes: Buffer.byteLength(chat.text, "utf8"),
    },
    null,
    2,
  ),
);
