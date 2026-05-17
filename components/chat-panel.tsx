"use client";

import { useEffect, useRef, useState } from "react";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";

import { ApiKeyManager } from "@/components/api-key-manager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

export type RepoInfo = {
  id: string;
  owner: string;
  name: string;
  status: string;
};

/** Concatenate the text parts of a UI message. */
function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function statusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "Indexed";
    case "EMBEDDING":
    case "INGESTING":
    case "PENDING":
      return "Still indexing…";
    case "FAILED":
      return "Indexing failed";
    default:
      return status;
  }
}

export function ChatPanel({ repo }: { repo: RepoInfo }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { repoId: repo.id },
    }),
  });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-3xl flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <a
            href={`https://github.com/${repo.owner}/${repo.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm font-medium hover:underline"
          >
            {repo.owner}/{repo.name}
          </a>
          <p className="text-muted-foreground text-xs">
            {statusLabel(repo.status)}
          </p>
        </div>
        <div className="shrink-0">
          <ApiKeyManager triggerLabel="Set key" />
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-4 py-6">
          {messages.length === 0 && (
            <p className="text-muted-foreground mx-auto max-w-sm pt-16 text-center text-sm">
              Ask a question about{" "}
              <span className="text-foreground">{repo.name}</span> — for
              example, &ldquo;where is auth handled?&rdquo;
            </p>
          )}

          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              role={message.role}
              text={messageText(message)}
            />
          ))}

          {status === "submitted" && (
            <div className="mr-auto w-full max-w-[85%] space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {error && (
            <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {error.message ||
                "Something went wrong. Make sure your API key is set."}
            </p>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="flex gap-2 border-t p-4">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about this repo…"
          disabled={busy}
        />
        <Button onClick={submit} disabled={busy || !input.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  text,
}: {
  role: string;
  text: string;
}) {
  const isUser = role === "user";
  return (
    <div
      className={
        isUser
          ? "bg-primary text-primary-foreground ml-auto max-w-[85%] rounded-lg px-3 py-2 text-sm"
          : "bg-muted text-foreground mr-auto max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
      }
    >
      {text}
    </div>
  );
}
