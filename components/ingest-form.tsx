"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Paste a github.com URL, index it, and land in the chat. Indexing is
// synchronous on the server (clone -> chunk -> embed), so this can
// take up to a minute for a larger repo.

type FormState = "idle" | "indexing" | "error";

function extractError(data: unknown, status: number): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return status === 401
    ? "Set your Gemini key first, or try the tour repo."
    : "Indexing failed. Please try again.";
}

export function IngestForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed || state === "indexing") return;
    setState("indexing");
    setError(null);
    try {
      const resp = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data: unknown = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(extractError(data, resp.status));
        setState("error");
        return;
      }
      const repoId =
        typeof data === "object" && data !== null && "repoId" in data
          ? String((data as { repoId: unknown }).repoId)
          : "";
      if (!repoId) {
        setError("Indexing finished but no repo id was returned.");
        setState("error");
        return;
      }
      router.push(`/chat/${repoId}`);
    } catch {
      setError("Network error. Please try again.");
      setState("error");
    }
  }

  const indexing = state === "indexing";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="https://github.com/owner/repo"
          disabled={indexing}
          spellCheck={false}
        />
        <Button onClick={submit} disabled={indexing || !url.trim()}>
          {indexing ? "Indexing…" : "Index repo"}
        </Button>
      </div>

      {indexing && (
        <p className="text-muted-foreground text-xs">
          Cloning, chunking and embedding the repo — this can take up to
          a minute.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
