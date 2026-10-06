import type { StreamTextTransform, ToolSet } from "ai";

import { CitationResolver } from "./citations";

/** Keep text streaming; buffer only the current bracketed reference. */
export function citationTransform(resolver: CitationResolver): StreamTextTransform<ToolSet> {
  return () => new TransformStream({
    transform(part, controller) {
      if (part.type === "text-delta") {
        const text = resolver.push(part.text);
        if (text) controller.enqueue({ ...part, text });
      } else {
        if (part.type === "text-end") {
          const text = resolver.finish();
          if (text) controller.enqueue({ type: "text-delta", id: part.id, text });
        }
        controller.enqueue(part);
      }
    },
  });
}
