"use client";

import { useState } from "react";

// Raw modal for the bring-your-own-key flow. Day 9 promotes this into
// a shadcn Dialog. The key is held in local state only long enough to
// POST it to /api/key, then cleared — it never persists in the client.

type SaveState = "idle" | "saving" | "saved" | "error";

export function ApiKeyManager() {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setApiKey("");
    setError(null);
    setState("idle");
  }

  async function save() {
    if (!apiKey.trim()) return;
    setState("saving");
    setError(null);
    try {
      const resp = await fetch("/api/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data: unknown = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "Could not save the key.";
        setError(message);
        setState("error");
        return;
      }
      // Clear the key from client memory as soon as it's stored.
      setApiKey("");
      setState("saved");
      window.setTimeout(close, 800);
    } catch {
      setError("Network error. Please try again.");
      setState("error");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
      >
        Set API key
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="api-key-title"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="api-key-title"
              className="text-base font-semibold text-zinc-100"
            >
              Set your Gemini API key
            </h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Get a free key from{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-200 underline underline-offset-2"
              >
                Google AI Studio
              </a>
              . It is stored only in an encrypted, httpOnly cookie scoped
              to this browser session — never in a database.
            </p>

            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder="AIza…"
              autoComplete="off"
              spellCheck={false}
              className="mt-4 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            />

            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
            {state === "saved" && (
              <p className="mt-2 text-sm text-emerald-400">Key saved.</p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={state === "saving" || !apiKey.trim()}
                className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {state === "saving" ? "Validating…" : "Save key"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
