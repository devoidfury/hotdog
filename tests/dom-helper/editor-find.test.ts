// The PURE finder + replace helpers, driven directly (no DOM, no wire):
// the overlap rules, the empty-query rule, whole-word boundaries (unicode),
// the honest bad-regex string, the case toggle, per-line matching, the
// document-order walk, and the undo/dirty semantics of replace-one /
// replace-all through the performTx seam. The widget wiring is pinned in
// app.test.tsx's workbench-editor section.
import { describe, expect, it } from "bun:test";
import {
  findMatches,
  indexAtOrAfter,
  replaceAll,
  replaceMatch,
  selectOccurrences,
  type FindOptions,
} from "@extensions/webui/ui/editor-find.ts";
import {
  bufferFromContent,
  contentOf,
  insertText,
  setCaret,
  undo,
  type TextBuffer,
} from "@extensions/webui/ui/editor-buffer.ts";

const opts = (o: Partial<FindOptions> = {}): FindOptions => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...o,
});
const okMatches = (lines: string[], q: string, o: Partial<FindOptions> = {}) => {
  const r = findMatches(lines, q, opts(o));
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.matches;
};
const spans = (lines: string[], q: string, o: Partial<FindOptions> = {}) =>
  okMatches(lines, q, o).map((m) => [m.line, m.from, m.to]);
const at = (content: string, line: number, col: number): TextBuffer =>
  setCaret(bufferFromContent(content), { line, col });

describe("findMatches: the core rules", () => {
  it("empty query = no matches, no error", () => {
    expect(findMatches(["abc", "def"], "", opts())).toEqual({ ok: true, matches: [] });
  });

  it("non-overlapping LEFT-TO-RIGHT: 'aa' in 'aaaa' is two spans, never three", () => {
    expect(spans(["aaaa"], "aa")).toEqual([[0, 0, 2], [0, 2, 4]]);
    expect(spans(["ababa"], "aba")).toEqual([[0, 0, 3]]); // the tail overlap dies
  });

  it("matches are per-line CONTENT only; nothing spans a line break", () => {
    expect(spans(["a", "b"], "a")).toEqual([[0, 0, 1]]);
    // "ab" split across lines is NOT a match (the finder never joins lines).
    expect(spans(["a", "b"], "ab")).toEqual([]);
  });

  it("a multi-line query is refused with an honest string, never a throw", () => {
    const r = findMatches(["a", "b"], "a\nb", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("per line");
  });

  it("document order across lines", () => {
    expect(spans(["xax", "bb", "ax"], "a")).toEqual([
      [0, 1, 2],
      [2, 0, 1],
    ]);
  });

  it("case toggle: off folds, on distinguishes", () => {
    const lines = ["Foo foo FOO"];
    expect(spans(lines, "foo")).toEqual([[0, 0, 3], [0, 4, 7], [0, 8, 11]]);
    expect(spans(lines, "foo", { caseSensitive: true })).toEqual([[0, 4, 7]]);
    expect(spans(lines, "FOO", { caseSensitive: true })).toEqual([[0, 8, 11]]);
  });

  it("whole word: ASCII boundaries (space, punct, line edges) match; embedded does not", () => {
    expect(spans(["cat cat-cat scatter"], "cat", { wholeWord: true })).toEqual([
      [0, 0, 3],
      [0, 4, 7],
      [0, 8, 11],
    ]);
    // underscore is a WORD char: foo does not whole-match inside foo_bar
    expect(spans(["foo_bar foo"], "foo", { wholeWord: true })).toEqual([[0, 8, 11]]);
    // digits neither start nor end a whole word
    expect(spans(["x1cat cat2"], "cat", { wholeWord: true })).toEqual([]);
  });

  it("whole word with UNICODE-ish characters (ASCII \\w would call é a boundary)", () => {
    expect(spans(["café cafés café."], "café", { wholeWord: true })).toEqual([
      [0, 0, 4],
      [0, 11, 15],
    ]);
    // the word class covers non-latin letters too: 猫 does not whole-match inside 猫猫
    expect(spans(["猫 猫猫"], "猫", { wholeWord: true })).toEqual([[0, 0, 1]]);
  });

  it("literal queries keep regex metachars literal", () => {
    expect(spans(["abc a.c"], "a.c")).toEqual([[0, 4, 7]]);
    expect(spans(["a+b ++"], "+")).toEqual([[0, 1, 2], [0, 4, 5], [0, 5, 6]]);
  });

  it("regex mode: classes, groups, alternation, anchored -- per line", () => {
    expect(spans(["x1 y22 z333"], "\\d+", { regex: true })).toEqual([
      [0, 1, 2],
      [0, 4, 6],
      [0, 8, 11],
    ]);
    // "abc" does NOT match the class (b is neither . nor x) -- pinned.
    expect(spans(["abc axc a.c"], "a[.x]c", { regex: true })).toEqual([
      [0, 4, 7],
      [0, 8, 11],
    ]);
    // ^ anchors at each LINE start, not the document start
    expect(spans(["ab", "ab x ab"], "^ab", { regex: true })).toEqual([
      [0, 0, 2],
      [1, 0, 2],
    ]);
  });

  it("bad regex is an honest error string, never a throw", () => {
    for (const bad of ["(", "[a", "a{2,1}", "(?P<n>x)", "*"]) {
      const r = findMatches(["anything"], bad, opts({ regex: true }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("Invalid regular expression");
    }
  });

  it("zero-length regex matches terminate (no spin) and report carets", () => {
    expect(spans(["ab"], "x*", { regex: true })).toEqual([[0, 0, 0], [0, 1, 1], [0, 2, 2]]);
  });

  it("whole-word filters regex matches too", () => {
    expect(spans(["cat cats (cat)"], "c.t", { regex: true, wholeWord: true })).toEqual([
      [0, 0, 3],
      [0, 10, 13],
    ]);
  });

  it("indexAtOrAfter walks the caret forward and wraps off the end", () => {
    const r = findMatches(["axbxc"], "x", opts());
    if (!r.ok) throw new Error("unreachable");
    expect(indexAtOrAfter(r.matches, { line: 0, col: 0 })).toBe(0);
    expect(indexAtOrAfter(r.matches, { line: 0, col: 2 })).toBe(1);
    expect(indexAtOrAfter(r.matches, { line: 0, col: 3 })).toBe(1); // at a match start counts
    expect(indexAtOrAfter(r.matches, { line: 0, col: 4 })).toBe(0); // wrapped
    expect(indexAtOrAfter([], { line: 0, col: 0 })).toBe(0);
  });
});

describe("replaceMatch / replaceAll through the performTx seam", () => {
  it("replace-one swaps ONLY the current match, as ONE block undo step", () => {
    let b = at("foo foo foo", 0, 0);
    const ms = okMatches(b.lines, "foo");
    b = replaceMatch(b, ms[1]!, "X", 1000);
    expect(contentOf(b)).toBe("foo X foo");
    expect(b.undo.length).toBe(1);
    expect(b.dirty).toBe(true);
    b = undo(b);
    expect(contentOf(b)).toBe("foo foo foo");
    expect(b.dirty).toBe(false);
  });

  it("a single-char replace is NOT coalesced into an adjacent typing run", () => {
    let b = at("foo bar", 0, 4);
    b = insertText(b, "z", { kind: "typing", time: 1000 }); // "foo zbar"
    const ms = okMatches(b.lines, "bar");
    b = replaceMatch(b, ms[0]!, "q", 1000); // ONE char -- typing-kind would merge at the same tick
    expect(b.undo.length).toBe(2); // typing step + block replace step, separately
    expect(contentOf(b)).toBe("foo zq");
    b = undo(b);
    expect(contentOf(b)).toBe("foo zbar");
  });

  it("replace-all is ONE undo step for every occurrence", () => {
    let b = bufferFromContent("foo foo\nbar foo\n");
    const ms = okMatches(b.lines, "foo");
    expect(ms.length).toBe(3);
    b = replaceAll(b, ms, "baz", 1000);
    expect(contentOf(b)).toBe("baz baz\nbar baz\n");
    expect(b.undo.length).toBe(1);
    b = undo(b);
    expect(contentOf(b)).toBe("foo foo\nbar foo\n");
    expect(b.dirty).toBe(false); // back at the baseline: content-derived dirty says CLEAN
  });

  it("PIN (owner ruling 2026-11-16): replacing back TO the baseline reads clean for free", () => {
    let b = bufferFromContent("aaa aaa");
    const find = (buf: TextBuffer, q: string) => {
      const r = findMatches(buf.lines, q, opts());
      if (!r.ok) throw new Error("unexpected regex error");
      return r.matches;
    };
    b = replaceAll(b, find(b, "aaa"), "bbb", 1000);
    expect(b.dirty).toBe(true);
    b = replaceAll(b, find(b, "bbb"), "aaa", 5000);
    expect(contentOf(b)).toBe("aaa aaa");
    expect(b.dirty).toBe(false); // the stampDirty derivation, not a latch
  });

  it("replace-all with an empty replacement deletes every occurrence", () => {
    let b = bufferFromContent("a-b-c");
    const r = findMatches(b.lines, "-", opts());
    if (!r.ok) throw new Error("unreachable");
    b = replaceAll(b, r.matches, "", 1000);
    expect(contentOf(b)).toBe("abc");
    b = undo(b);
    expect(contentOf(b)).toBe("a-b-c");
  });

  it("replace-all collapses the caret list to ONE caret (no multi-caret typing trap)", () => {
    let b = bufferFromContent("x x x");
    const r = findMatches(b.lines, "x", opts());
    if (!r.ok) throw new Error("unreachable");
    b = replaceAll(b, r.matches, "y", 1000);
    expect(contentOf(b)).toBe("y y y");
    expect(b.sels.length).toBe(1);
  });

  it("replaceMatch keeps the baseline/endsNL facts intact (trailing newline survives)", () => {
    let b = bufferFromContent("foo\n");
    const r = findMatches(b.lines, "foo", opts());
    if (!r.ok) throw new Error("unreachable");
    b = replaceMatch(b, r.matches[0]!, "barbecue", 1000);
    expect(contentOf(b)).toBe("barbecue\n");
  });
});

describe("selectOccurrences feeds the multi-caret machine", () => {
  it("every occurrence becomes one range; primary rides the current match; typing hits all of them", () => {
    let b = at("foo x foo y foo", 0, 0);
    b = selectOccurrences(b, okMatches(b.lines, "foo"), 1);
    expect(b.sels.length).toBe(3);
    expect(b.primary).toBe(1);
    expect(b.sels.map((s) => [s.anchor.col, s.head.col])).toEqual([
      [0, 3],
      [6, 9],
      [12, 15],
    ]);
    b = insertText(b, "Q", { kind: "block", time: 1000 }); // the EXISTING multi-edit seam
    expect(contentOf(b)).toBe("Q x Q y Q");
    b = undo(b);
    expect(contentOf(b)).toBe("foo x foo y foo");
  });

  it("an empty match list leaves the buffer untouched", () => {
    const b = bufferFromContent("abc");
    expect(selectOccurrences(b, [], 0)).toBe(b);
  });

  it("a stale primary index clamps into the live list", () => {
    let b = at("foo foo", 0, 0);
    b = selectOccurrences(b, okMatches(b.lines, "foo"), 99);
    expect(b.primary).toBe(1);
  });
});

describe("case-sensitive literal fast path (indexOf walk)", () => {
  it("reproduces the escaped-regex walk: overlap, repeats, start/end edges", () => {
    // Non-overlapping left-to-right: "aa" in "aaaa" lands at 0 and 2, never 1.
    expect(spans(["aaaa"], "aa", { caseSensitive: true })).toEqual([[0, 0, 2], [0, 2, 4]]);
    expect(spans(["xaxaxa"], "a", { caseSensitive: true })).toEqual([[0, 1, 2], [0, 3, 4], [0, 5, 6]]);
    expect(spans(["hit", "mid hit", "tail"], "hit", { caseSensitive: true })).toEqual([
      [0, 0, 3],
      [1, 4, 7],
    ]);
    expect(spans(["abc"], "zzz", { caseSensitive: true })).toEqual([]);
  });

  it("literal metacharacters stay literal (no regex reading of the query)", () => {
    expect(spans(["a.b $x* (y) [z]"], ".$", { caseSensitive: true })).toEqual([]);
    expect(spans(["a.b $x* (y) [z]"], ".*", { caseSensitive: true })).toEqual([]);
    expect(spans(["a.b $x* (y) [z]"], "(y)", { caseSensitive: true })).toEqual([[0, 8, 11]]);
    expect(spans(["price: $5", "$5x"], "$5", { caseSensitive: true })).toEqual([
      [0, 7, 9],
      [1, 0, 2],
    ]);
  });

  it("agrees with the case-insensitive regex path where the fold is trivial", () => {
    // All-lowercase content: cs and ci must return the identical walk.
    const lines = ["value one", "two value", "nothing here", "valuevalue"];
    expect(spans(lines, "value", { caseSensitive: true })).toEqual(spans(lines, "value", { caseSensitive: false }));
  });

  it("case toggle still bites on the fast path", () => {
    expect(spans(["Cat cat CAT"], "cat", { caseSensitive: true })).toEqual([[0, 4, 7]]);
    expect(spans(["Cat cat CAT"], "cat", { caseSensitive: false })).toEqual([[0, 0, 3], [0, 4, 7], [0, 8, 11]]);
  });

  it("whole-word rides the same neighbour rule on the fast path (unicode + surrogate pairs)", () => {
    expect(spans(["concat cat category"], "cat", { caseSensitive: true, wholeWord: true })).toEqual([[0, 7, 10]]);
    // é is a LETTER: "café" is not a whole-word "caf".
    expect(spans(["café café"], "caf", { caseSensitive: true, wholeWord: true })).toEqual([]);
    // A supplementary-plane LETTER (Deseric capital 𐐀) before the word: the
    // pair is read whole, so the boundary is a letter and the match drops.
    expect(spans(["\u{D800}\u{DC00}cat cat"], "cat", { caseSensitive: true, wholeWord: true })).toEqual([[0, 6, 9]]);
    // And the identical judgement comes out of the regex path too.
    expect(spans(["concat cat category"], "cat", { caseSensitive: false, wholeWord: true })).toEqual([[0, 7, 10]]);
  });

  it("a regex query never takes the literal fast path", () => {
    // "c.t" is only literal-adjacent by accident: as regex it spans "cat" AND "cot".
    expect(spans(["cat cot c.t"], "c.t", { caseSensitive: true, regex: true })).toEqual([
      [0, 0, 3],
      [0, 4, 7],
      [0, 8, 11],
    ]);
  });
});
