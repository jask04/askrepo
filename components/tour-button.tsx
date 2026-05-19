"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

// One-click tour: switch the session into tour mode (host key) and
// jump straight into the chat for the pre-indexed demo repo.

export function TourButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startTour() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/tour", { method: "POST" });
      const data: unknown = await resp.json().catch(() => ({}));
      if (
        resp.ok &&
        typeof data === "object" &&
        data !== null &&
        "repoId" in data &&
        typeof (data as { repoId: unknown }).repoId === "string"
      ) {
        router.push(`/chat/${(data as { repoId: string }).repoId}`);
        return;
      }
      setError("Tour mode is unavailable right now.");
      setLoading(false);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" onClick={startTour} disabled={loading}>
        {loading ? "Starting…" : "Try the tour repo"}
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
