import { describe, expect, it } from "vitest";

import { CitationResolver, createCitationSources, resolveCitation, type SourceExcerpt } from "@/lib/citations";
import readme from "./fixtures/realtime-readme.json";

const quote = "server.ts           Production entrypoint (api + workers)";
const source = (): SourceExcerpt => ({ ...readme, repo: { ...readme.repo } });
const sources = () => createCitationSources([source()]);
const marker = (id: string, text: string) => "[cite:" + id + " " + JSON.stringify(text) + "]";

describe("source-backed citations", () => {
  it("maps the actual README entrypoint quote to L233, never the guessed L214", () => {
    const citation = resolveCitation(sources(), "S1", quote);
    expect(citation).toMatchObject({ path: "README.md", startLine: 233, endLine: 233 });
    expect(citation?.url).toBe("https://github.com/jask04/realtime-notifications/blob/" + readme.repo.commitSha + "/README.md#L233");
    expect(citation?.excerpt).toContain(quote);
    const resolver = new CitationResolver(sources());
    expect(resolver.push("Entry point [README.md:214] " + marker("S1", quote))).toBe("Entry point [unverified source] [C1]");
    expect(resolver.citations).toHaveLength(1);
  });

  it("allows indentation and tab differences without changing source words or line boundaries", () => {
    expect(resolveCitation(sources(), "S1", "server.ts\tProduction entrypoint (api + workers)")?.startLine).toBe(233);
  });

  it.each([
    ["S99", quote],
    ["S1", "server.ts Production entrypoint for email workers"],
    ["S1", "src/server.ts Production entrypoint (api + workers)"],
    ["S1", "server.ts ... workers"],
    ["S1", "server.ts"],
    ["S1", ""],
  ])("rejects missing, fabricated, abbreviated or trivial quotes (%s, %s)", (id, text) => {
    expect(resolveCitation(sources(), id, text)).toBeNull();
  });

  it("rejects a quote from a different retrieved source ID instead of changing its path", () => {
    const two = createCitationSources([source(), {
      repo: readme.repo, path: "src/server.ts", startLine: 1, endLine: 1,
      content: "export const app = fastify();",
    }]);
    expect(resolveCitation(two, "S2", quote)).toBeNull();
    expect(resolveCitation(two, "S1", quote)?.path).toBe("README.md");
  });

  it("rejects ambiguous repeated text instead of choosing an arbitrary occurrence", () => {
    const repeated = createCitationSources([{
      repo: readme.repo, path: "a.ts", startLine: 10, endLine: 11,
      content: "export const flag = true;\nexport const flag = true;",
    }]);
    expect(resolveCitation(repeated, "S1", "export const flag = true;")).toBeNull();
  });

  it("finds only the actual contiguous quoted lines, not the entire chunk", () => {
    const part = readme.content.split("\n").slice(26, 28).join("\n");
    expect(resolveCitation(sources(), "S1", part)).toMatchObject({
      startLine: 233, endLine: 234, excerpt: part,
    });
  });

  it.each([
    { startLine: 0 },
    { startLine: -1 },
    { startLine: 214, endLine: 214 },
    { endLine: 206 },
    { endLine: 5000 },
    { path: "../README.md" },
    { path: "/README.md" },
    { path: "a//README.md" },
    { path: "a\\README.md" },
    { repo: { ...readme.repo, commitSha: "main" } },
  ])("rejects invalid source bounds, paths or unpinned versions (%j)", (patch) => {
    expect(createCitationSources([{ ...source(), ...patch }])).toEqual([]);
  });

  it("encodes a valid filename rather than letting it alter the URL", () => {
    const withName = createCitationSources([{ ...source(), path: "docs/guide #1.md" }]);
    expect(resolveCitation(withName, "S1", quote)?.url).toContain("/docs/guide%20%231.md#L233");
  });

  it("rejects overlong or excessive-line quotes", () => {
    expect(resolveCitation(sources(), "S1", "x".repeat(501))).toBeNull();
    const tenLines = Array.from({ length: 10 }, (_, i) => "export const v" + i + " = true;").join("\n");
    const wide = createCitationSources([{ repo: readme.repo, path: "a.ts", content: tenLines, startLine: 1, endLine: 10 }]);
    expect(resolveCitation(wide, "S1", tenLines)).toBeNull();
  });
});

describe("incremental citation resolution", () => {
  it("handles every split point of a reference, including its prefix and quoted brackets", () => {
    const special = 'const label = "a]b";';
    const sources = createCitationSources([{ repo: readme.repo, path: "a.ts", content: special, startLine: 42, endLine: 42 }]);
    const text = "Before " + marker("S1", special) + " after";
    for (let split = 0; split <= text.length; split += 1) {
      const resolver = new CitationResolver(sources);
      expect(resolver.push(text.slice(0, split)) + resolver.push(text.slice(split)) + resolver.finish()).toBe("Before [C1] after");
      expect(resolver.citations[0]).toMatchObject({ startLine: 42, endLine: 42, excerpt: special });
    }
  });

  it("handles character-by-character multiline JSON, repeated citations and several sources", () => {
    const two = createCitationSources([source(), {
      repo: readme.repo, path: "server.ts", content: "await app.listen({ port: 3000 });\nawait startWorkers();", startLine: 18, endLine: 19,
    }]);
    const resolver = new CitationResolver(two);
    const text = marker("S1", quote) + ", " + marker("S2", two[1]!.content) + " and " + marker("S1", quote);
    expect([...text].map((char) => resolver.push(char)).join("") + resolver.finish()).toBe("[C1], [C2] and [C1]");
    expect(resolver.citations).toHaveLength(2);
    expect(resolver.citations[1]?.url).toContain("#L18-L19");
  });

  it("never accepts model-generated C IDs or legacy arbitrary line ranges", () => {
    const resolver = new CitationResolver(sources());
    expect(resolver.push("[C1] [README.md:9999] [other.ts:233] [README.md:233-214]")).toBe(
      "[unverified source] [unverified source] [unverified source] [unverified source]",
    );
    expect(resolver.citations).toEqual([]);
  });

  it("keeps ordinary markdown and streaming text intact", () => {
    const resolver = new CitationResolver(sources());
    expect(resolver.push("hello ") + resolver.push("[label](https://example.com) tail") + resolver.finish()).toBe("hello [label](https://example.com) tail");
  });

  it("does not let a nested model-generated C ID reuse an earlier validated citation", () => {
    const resolver = new CitationResolver(sources());
    expect(resolver.push(marker("S1", quote))).toBe("[C1]");
    expect(resolver.push("[nested [C1]]")).toBe("[nested [unverified source]]");
    expect(resolver.citations).toHaveLength(1);
  });

  it("rejects incomplete or malformed quote markers without creating links", () => {
    const resolver = new CitationResolver(sources());
    expect(resolver.push('[cite:S1 "unfinished')).toBe("");
    expect(resolver.finish()).toBe("[unverified source]");
    expect(resolver.push('[cite:S1 "bad\\q"]')).toBe("[unverified source]");
    expect(resolver.citations).toEqual([]);
  });

  it("bounds an unterminated reference", () => {
    const resolver = new CitationResolver(sources());
    expect(resolver.push('[cite:S1 "' + "x".repeat(2048))).toBe("[unverified source]");
    expect(resolver.push("normal text")).toBe("normal text");
  });
});
