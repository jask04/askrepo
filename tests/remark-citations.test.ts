import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "@/components/markdown-message";
import { createCitationSources, resolveCitation, type ResolvedCitation } from "@/lib/citations";
import { remarkCitations } from "@/lib/remark-citations";
import readme from "./fixtures/realtime-readme.json";

const citation: ResolvedCitation = { ...resolveCitation(
  createCitationSources([readme]), "S1", "server.ts Production entrypoint (api + workers)",
)!, id: "C1" };

describe("citation rendering", () => {
  it("links a server-resolved marker with actual source lines and a pinned commit", () => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "Entrypoint [C1]." }] }] };
    remarkCitations([citation])(tree);
    expect(tree.children[0]?.children).toContainEqual({
      type: "link", url: citation.url,
      data: { hProperties: { className: "askrepo-citation", title: citation.excerpt } },
      children: [{ type: "text", value: "README.md:233" }],
    });
  });

  it("does not link guesses, unavailable IDs, code or arbitrary markdown URLs", () => {
    const tree = { type: "root", children: [
      { type: "text", value: "[README.md:214] [C99]" },
      { type: "inlineCode", value: "[C1]" },
      { type: "code", value: "[C1]" },
      { type: "link", url: citation.url.replace("#L233", "#L214"), children: [{ type: "text", value: "guess" }] },
    ] };
    remarkCitations([citation])(tree);
    expect(tree.children.some((node) => node.type === "link")).toBe(false);
    expect(tree.children).toContainEqual({ type: "inlineCode", value: "[C1]" });
    expect(tree.children).toContainEqual({ type: "text", value: "[README.md:214] " });
    expect(tree.children).toContainEqual({ type: "text", value: "[unverified source]" });
    expect(tree.children).toContainEqual({ type: "text", value: "guess" });
  });

  it("keeps earlier message citations pinned when a later answer uses a new commit", () => {
    const render = (c: ResolvedCitation) => {
      const tree = { type: "root", children: [{ type: "text", value: "[C1]" }] };
      remarkCitations([c])(tree);
      return tree.children.find((node) => node.type === "link");
    };
    expect(render(citation)).toMatchObject({ url: citation.url });
    expect(render({ ...citation, url: citation.url.replace(readme.repo.commitSha, "f".repeat(40)) })).toMatchObject({
      url: citation.url.replace(readme.repo.commitSha, "f".repeat(40)),
    });
    expect(render(citation)).toMatchObject({ url: citation.url });
  });

  it("renders the actual markdown component with a validated link and quoted evidence", () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "Entrypoint [C1]. [wrong](https://github.com/jask04/realtime-notifications/blob/main/README.md#L214)",
      citations: [citation],
    }));
    expect(html).toContain('href="' + citation.url + '"');
    expect(html).toContain("README.md:233");
    expect(html).toContain('title="' + citation.excerpt + '"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("#L214");
  });
});
