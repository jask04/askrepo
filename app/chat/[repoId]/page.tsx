import { notFound } from "next/navigation";

import { ChatPanel } from "@/components/chat-panel";
import { prisma } from "@/lib/db";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ repoId: string }>;
}) {
  const { repoId } = await params;

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { id: true, owner: true, name: true, status: true },
  });

  if (!repo) {
    notFound();
  }

  return <ChatPanel repo={repo} />;
}
