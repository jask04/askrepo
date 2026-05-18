"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { RepoRef } from "@/lib/citations";
import { remarkCitations } from "@/lib/remark-citations";

// Renders a streamed assistant answer as markdown, with [path:lines]
// citations rewritten into links to github.com source.

function isCitation(className: unknown): boolean {
  return typeof className === "string" && className.includes("askrepo-citation");
}

const components: Components = {
  a({ className, href, children }) {
    if (isCitation(className)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-muted text-foreground hover:bg-accent rounded px-1 py-0.5 font-mono text-[0.8em] whitespace-nowrap no-underline"
        >
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
  p({ children }) {
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="my-2 list-disc pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal pl-5">{children}</ol>;
  },
  li({ children }) {
    return <li className="my-0.5">{children}</li>;
  },
  code({ className, children }) {
    // Block code carries a language- className from the fence; inline
    // code does not.
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return <code className="font-mono text-[0.85em]">{children}</code>;
    }
    return (
      <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="bg-muted my-2 overflow-x-auto rounded-md p-3 text-xs">
        {children}
      </pre>
    );
  },
  h1({ children }) {
    return <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>;
  },
  h2({ children }) {
    return <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>;
  },
  h3({ children }) {
    return <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>;
  },
};

export function MarkdownMessage({
  text,
  repo,
}: {
  text: string;
  repo: RepoRef;
}) {
  return (
    <div className="text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkCitations, repo]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
