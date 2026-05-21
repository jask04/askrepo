import { describe, expect, it } from "vitest";

import {
  buildSourceUrl,
  parseCitations,
  splitByCitations,
  type RepoRef,
} from "@/lib/citations";

const repo: RepoRef = {
  owner: "jask04",
  name: "askrepo",
  commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
};

describe("parseCitations", () => {
  it("returns [] for text with no citations", () => {
    expect(parseCitations("nothing to see here")).toEqual([]);
  });

  it("parses a single-line citation", () => {
    const [c] = parseCitations("see [src/index.ts:42] for details");
    expect(c?.path).toBe("src/index.ts");
    expect(c?.startLine).toBe(42);
    expect(c?.endLine).toBe(42);
  });

  it("parses a line-range citation", () => {
    const [c] = parseCitations("see [lib/db.ts:10-25]");
    expect(c?.path).toBe("lib/db.ts");
    expect(c?.startLine).toBe(10);
    expect(c?.endLine).toBe(25);
  });

  it("finds multiple citations in order", () => {
    const cs = parseCitations("a [x.ts:1] then [y.ts:2-3] and [z.ts:7]");
    expect(cs.map((c) => c.path)).toEqual(["x.ts", "y.ts", "z.ts"]);
    expect(cs.map((c) => c.endLine)).toEqual([1, 3, 7]);
  });

  it("normalises a reversed range", () => {
    const [c] = parseCitations("oops [f.ts:20-10]");
    // endLine must not be less than startLine.
    expect(c?.startLine).toBe(20);
    expect(c?.endLine).toBe(20);
  });

  it("handles deep paths with dots and slashes", () => {
    const [c] = parseCitations("here [src/a/b/c.test-d.ts:5-9]");
    expect(c?.path).toBe("src/a/b/c.test-d.ts");
    expect(c?.startLine).toBe(5);
    expect(c?.endLine).toBe(9);
  });

  it("ignores malformed brackets", () => {
    expect(parseCitations("[no colon here] and [oops:]")).toEqual([]);
  });
});

describe("splitByCitations", () => {
  it("returns a single text segment when there are no citations", () => {
    expect(splitByCitations("hello")).toEqual([
      { kind: "text", value: "hello" },
    ]);
  });

  it("splits text around a citation", () => {
    const segs = splitByCitations("before [a.ts:1-2] after");
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "text", value: "before " });
    expect(segs[1]?.kind).toBe("citation");
    expect(segs[2]).toEqual({ kind: "text", value: " after" });
  });

  it("returns [] for empty input", () => {
    expect(splitByCitations("")).toEqual([]);
  });

  it("does not emit empty text segments at the start", () => {
    const segs = splitByCitations("[a.ts:1] tail");
    expect(segs[0]?.kind).toBe("citation");
  });
});

describe("buildSourceUrl", () => {
  it("appends #Lstart for single-line citations", () => {
    const url = buildSourceUrl(repo, {
      raw: "[a.ts:42]",
      path: "a.ts",
      startLine: 42,
      endLine: 42,
    });
    expect(url).toBe(
      "https://github.com/jask04/askrepo/blob/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/a.ts#L42",
    );
  });

  it("appends #Lstart-Lend for ranges", () => {
    const url = buildSourceUrl(repo, {
      raw: "[lib/x.ts:10-25]",
      path: "lib/x.ts",
      startLine: 10,
      endLine: 25,
    });
    expect(url).toBe(
      "https://github.com/jask04/askrepo/blob/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/lib/x.ts#L10-L25",
    );
  });
});
