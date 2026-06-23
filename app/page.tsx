import Link from "next/link";

import { ApiKeyManager } from "@/components/api-key-manager";
import { IngestForm } from "@/components/ingest-form";
import { TourButton } from "@/components/tour-button";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { isTourConfigured } from "@/lib/tour";

const STEPS = [
  "Clone — the repo is shallow-cloned on the server.",
  "Chunk — every text file is split into ~600-token chunks.",
  "Embed — each chunk is embedded with Gemini and stored in pgvector.",
  "Retrieve — your question pulls the nearest chunks by vector search.",
  "Stream — Gemini answers from those chunks, streamed token by token.",
];

export default async function Home() {
  const recent = await prisma.repo.findMany({
    where: { status: "READY" },
    orderBy: { updatedAt: "desc" },
    take: 6,
    select: { id: true, owner: true, name: true, chunkCount: true },
  });

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">askrepo</h1>
        <p className="text-muted-foreground text-sm leading-6">
          Chat with any public GitHub repo — paste a URL, ask questions,
          and get streaming answers with citations back to specific
          files.
        </p>
      </header>

      <Card className="mt-8">
        <CardContent className="flex flex-col gap-4">
          <IngestForm />
          <div className="flex flex-wrap items-start gap-2">
            <ApiKeyManager
              triggerLabel="Use your own free Gemini key"
              triggerVariant="outline"
            />
            {isTourConfigured() && <TourButton />}
          </div>
          <p className="text-muted-foreground text-xs">
            Your key is stored only in an encrypted, httpOnly session
            cookie — never in a database. Tour mode runs on the host&apos;s
            key so you can look around without one.
          </p>
        </CardContent>
      </Card>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">How it works</h2>
        <ol className="text-muted-foreground mt-3 flex flex-col gap-1.5 text-sm">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-foreground tabular-nums">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {recent.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold">Recently indexed</h2>
          <ul className="mt-3 flex flex-col gap-1">
            {recent.map((repo) => (
              <li key={repo.id}>
                <Link
                  href={`/chat/${repo.id}`}
                  className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="truncate font-medium">
                    {repo.owner}/{repo.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {repo.chunkCount} chunks
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
