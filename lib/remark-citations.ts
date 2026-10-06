// Links come only from server-validated per-message evidence. Arbitrary
// model markdown links and path/line guesses cannot bypass validation.
import type { ResolvedCitation } from "./citations";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  data?: Record<string, unknown>;
};

function rewrite(node: MdastNode, citations: ResolvedCitation[]): void {
  if (!node.children) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "link" || child.type === "linkReference") {
      // Preserve the visible words, without trusting a model-generated URL.
      next.push(...(child.children ?? []));
    } else if (child.type === "text" && typeof child.value === "string") {
      let last = 0;
      for (const match of child.value.matchAll(/\[(C\d+)\]/g)) {
        next.push({ type: "text", value: child.value.slice(last, match.index) });
        const citation = citations.find((item) => item.id === match[1]);
        next.push(citation ? {
          type: "link", url: citation.url,
          data: { hProperties: {
            className: "askrepo-citation",
            title: citation.excerpt,
          } },
          children: [{ type: "text", value: citation.path + ":" + citation.startLine +
            (citation.endLine === citation.startLine ? "" : "-" + citation.endLine) }],
        } : { type: "text", value: "[unverified source]" });
        last = match.index + match[0].length;
      }
      next.push({ type: "text", value: child.value.slice(last) });
    } else {
      rewrite(child, citations);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkCitations(citations: ResolvedCitation[]) {
  return (tree: MdastNode) => rewrite(tree, citations);
}
