#!/usr/bin/env node

const baseUrl = (
  process.env.ASKREPO_URL ||
  process.argv[2] ||
  "https://askrepo-one.vercel.app"
).replace(/\/+$/, "");

const question =
  process.env.ASKREPO_DEMO_QUESTION || "Where is the main server entrypoint?";
const chatAttempts = 3;
const chatRetryDelaysMs = [5_000, 15_000];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertChatStream(chat) {
  assertOk("tour chat", chat);

  const streamErrorMarkers = [
    '"type":"error"',
    '"errorText"',
    "model_not_found",
    "no longer available",
  ];

  const streamError = streamErrorMarkers.find((marker) =>
    chat.text.toLowerCase().includes(marker.toLowerCase()),
  );

  if (streamError) {
    throw new Error(
      `tour chat stream returned an error (${streamError}): ${chat.text.slice(0, 500)}`,
    );
  }

  if (!chat.text.includes('"type":"text-delta"')) {
    throw new Error("tour chat response did not include a text delta");
  }

  const parts = chat.text.split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
  const answer = parts.filter((part) => part.type === "text-delta")
    .map((part) => part.delta ?? "").join("");
  const citations = parts.filter((part) => part.messageMetadata).at(-1)
    ?.messageMetadata?.citations ?? [];
  const references = [...answer.matchAll(/\[(C\d+)\]/g)];
  if (!references.length || answer.includes("[unverified source]") ||
      references.some((reference) => !citations.some((citation) => citation.id === reference[1]))) {
    throw new Error("tour chat did not include validated source citations");
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

let chat = null;
let chatAttempt = 0;
for (let attempt = 1; attempt <= chatAttempts; attempt += 1) {
  chatAttempt = attempt;
  chat = await request(
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
            id: `demo-check-${attempt}`,
            role: "user",
            parts: [{ type: "text", text: question }],
          },
        ],
      }),
    },
    90_000,
  );

  try {
    assertChatStream(chat);
    break;
  } catch (err) {
    if (attempt === chatAttempts) throw err;
    const delayMs = chatRetryDelaysMs[attempt - 1] ?? chatRetryDelaysMs.at(-1);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `tour chat attempt ${attempt} failed; retrying in ${delayMs}ms: ${message.slice(0, 240)}`,
    );
    await sleep(delayMs);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      repoId,
      homeStatus: home.response.status,
      chatPageStatus: chatPage.response.status,
      chatStatus: chat?.response.status,
      chatAttempt,
      streamBytes: Buffer.byteLength(chat?.text ?? "", "utf8"),
    },
    null,
    2,
  ),
);
