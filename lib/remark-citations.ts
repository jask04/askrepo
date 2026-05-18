// remark plugin that rewrites [path:start-end] spans in the markdown
// AST into links to github.com. Operating on the AST (rather than the
// raw string) means citations inside code blocks are left untouched —
// code is held in `code`/`inlineCode` nodes, not `text` nodes.

import { buildSourceUrl, splitByCitations, type RepoRef } from "./citations";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  data?: Record<string, unknown>;
};

/** Quick pre-check so we only run the splitter on candidate text. */
const LIKELY = /\[[^\]\s:]+:\d/;

function rewrite(node: MdastNode, repo: RepoRef): void {
  if (!node.children) return;

  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (
      child.type === "text" &&
      typeof child.value === "string" &&
      LIKELY.test(child.value)
    ) {
      const segments = splitByCitations(child.value);
      const hasCitation = segments.some((s) => s.kind === "citation");
      if (!hasCitation) {
        next.push(child);
        continue;
      }
      for (const segment of segments) {
        if (segment.kind === "text") {
          next.push({ type: "text", value: segment.value });
        } else {
          const label = segment.citation.raw.slice(1, -1);
          next.push({
            type: "link",
            url: buildSourceUrl(repo, segment.citation),
            data: { hProperties: { className: "askrepo-citation" } },
            children: [{ type: "text", value: label }],
          });
        }
      }
    } else {
      rewrite(child, repo);
      next.push(child);
    }
  }
  node.children = next;
}

/** remark plugin attacher. Pass the repo via the tuple form:
 *  remarkPlugins={[[remarkCitations, repo]]} */
export function remarkCitations(repo: RepoRef) {
  return (tree: MdastNode) => {
    rewrite(tree, repo);
  };
}
