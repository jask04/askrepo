"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// Bring-your-own-key dialog. The key lives in local state only long
// enough to POST it to /api/key, then it is cleared — it never
// persists on the client.

type SaveState = "idle" | "saving" | "saved" | "error";

type TriggerVariant = "default" | "outline" | "secondary";

function extractError(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return "Could not save the key.";
}

export function ApiKeyManager({
  triggerLabel = "Set API key",
  triggerVariant = "outline",
}: {
  triggerLabel?: string;
  triggerVariant?: TriggerVariant;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  function reset() {
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
        setError(extractError(data));
        setState("error");
        return;
      }
      // Drop the key from client memory as soon as it is stored.
      setApiKey("");
      setState("saved");
      window.setTimeout(() => {
        setOpen(false);
        reset();
      }, 800);
    } catch {
      setError("Network error. Please try again.");
      setState("error");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm">
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set your Gemini API key</DialogTitle>
          <DialogDescription>
            Get a free key from{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              Google AI Studio
            </a>
            . It is stored only in an encrypted, httpOnly cookie scoped to
            this browser session — never in a database.
          </DialogDescription>
        </DialogHeader>

        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder="AIza…"
          autoComplete="off"
          spellCheck={false}
        />

        {error && <p className="text-destructive text-sm">{error}</p>}
        {state === "saved" && (
          <p className="text-sm text-emerald-500">Key saved.</p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={state === "saving" || !apiKey.trim()}
          >
            {state === "saving" ? "Validating…" : "Save key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
