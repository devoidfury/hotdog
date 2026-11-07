// The shared diff util: the algorithm every kind "diff" display part renders
// from (the webui's gutters and the terminal's ANSI block both call in here,
// so the numbering contract is pinned once, here). The webui's own DOM/
// posture suite lives in tests/extensions/webui-tool-block.test.tsx.

import { describe, it, expect } from "bun:test";
import { addOnlyDiffLines, computeDiffLines, MAX_DIFF_LINES, diffStat } from "@utils/diff.ts";

describe("computeDiffLines", () => {
  it("trims the common prefix/suffix and bookends the change with one context row per side", () => {
    expect(computeDiffLines("a\nb\nc\nd", "a\nB\nc\nd")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
    ]);
  });

  it("numbers a pure insertion on the new side only and a deletion on the old side only", () => {
    expect(computeDiffLines("a\nd", "a\nb\nc\nd")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "add", text: "b", newNo: 2 },
      { kind: "add", text: "c", newNo: 3 },
      { kind: "ctx", text: "d", oldNo: 2, newNo: 4 },
    ]);
    expect(computeDiffLines("a\nb\nc\nd", "a\nd")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "del", text: "c", oldNo: 3 },
      { kind: "ctx", text: "d", oldNo: 4, newNo: 2 },
    ]);
  });

  it("shifts both gutters by fileStartLine so the numbers read the file, not the snippet", () => {
    expect(computeDiffLines("a\nb\nc", "a\nB\nc", undefined, 41)).toEqual([
      { kind: "ctx", text: "a", oldNo: 41, newNo: 41 },
      { kind: "del", text: "b", oldNo: 42 },
      { kind: "add", text: "B", newNo: 42 },
      { kind: "ctx", text: "c", oldNo: 43, newNo: 43 },
    ]);
    // A non-positive or fractional start is no fact at all: snippet numbering
    // stands (a fake offset beats nothing only in the direction of a lie).
    expect(computeDiffLines("a\nb", "a\nB", undefined, 0)[1]).toEqual({ kind: "del", text: "b", oldNo: 2 });
    expect(computeDiffLines("a\nb", "a\nB", undefined, 2.5)[1]).toEqual({ kind: "del", text: "b", oldNo: 2 });
  });

  it("caps each side and says how much it dropped on the placeholder", () => {
    const oldT = Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n");
    const newT = Array.from({ length: 20 }, (_, i) => `n${i}`).join("\n");
    const lines = computeDiffLines(oldT, newT, 5);
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(5);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(5);
    const info = lines.filter((l) => l.kind === "info");
    expect(info).toHaveLength(2);
    expect(info.map((l) => l.elided)).toEqual([15, 15]);
    // Placeholders are not lines: they carry no gutter number and no stat.
    expect(info.every((l) => l.oldNo === undefined && l.newNo === undefined)).toBe(true);
    expect(diffStat(lines)).toEqual({ add: 5, del: 5 });
  });

  it("defaults to the shared MAX_DIFF_LINES per side, and honors an explicit cap override", () => {
    expect(MAX_DIFF_LINES).toBe(300);
    const big = Array.from({ length: 400 }, (_, i) => `n${i}`).join("\n");
    const capped = computeDiffLines("base", big);
    expect(capped.filter((l) => l.kind === "add")).toHaveLength(300);
    expect(capped.some((l) => l.kind === "info")).toBe(true);
    // Explicit: a sink that bounds the render another way can ask for it all.
    const all = computeDiffLines("base", big, Number.POSITIVE_INFINITY);
    expect(all.filter((l) => l.kind === "add")).toHaveLength(400);
    expect(all.some((l) => l.kind === "info")).toBe(false);
    expect(diffStat(all)).toEqual({ add: 400, del: 1 });
  });

  it("reports an identical pair as no change rows at all", () => {
    expect(computeDiffLines("same\ntext", "same\ntext").filter((l) => l.kind !== "ctx")).toEqual([]);
  });
});

describe("addOnlyDiffLines", () => {
  it("renders every written line as an add, numbered from a positive integer addStart", () => {
    expect(addOnlyDiffLines("one\ntwo", 1)).toEqual({
      lines: [
        { kind: "add", text: "one", newNo: 1 },
        { kind: "add", text: "two", newNo: 2 },
      ],
      elided: 0,
    });
    // An append lands after content of unknown length: no addStart, no rail.
    expect(addOnlyDiffLines("one\ntwo").lines).toEqual([
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  it("numbers nothing for a non-positive or fractional addStart (no fake 1..N)", () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      expect(addOnlyDiffLines("a\nb", bad).lines.every((l) => l.newNo === undefined)).toBe(true);
    }
  });

  it("keeps the house line idiom: split on \\n only, so \\r rides inside and a trailing \\n adds an empty row", () => {
    expect(addOnlyDiffLines("a\r\nb").lines.map((l) => l.text)).toEqual(["a\r", "b"]);
    expect(addOnlyDiffLines("a\n").lines.map((l) => l.text)).toEqual(["a", ""]);
  });

  it("caps the rail and reports what fell off", () => {
    const body = Array.from({ length: 47 }, (_, i) => `line ${i}`).join("\n");
    const { lines, elided } = addOnlyDiffLines(body, undefined, 20);
    expect(lines).toHaveLength(20);
    expect(elided).toBe(27);
    expect(lines[19]!.text).toBe("line 19");
  });

  it("treats a zero cap as no rows and an infinite cap as everything", () => {
    expect(addOnlyDiffLines("a\nb\nc", 1, 0)).toEqual({ lines: [], elided: 3 });
    expect(addOnlyDiffLines("a\nb\nc", 1, Number.POSITIVE_INFINITY).lines).toHaveLength(3);
  });
});

describe("diffStat", () => {
  it("counts change rows only, never the placeholders", () => {
    expect(diffStat(computeDiffLines("a\nb\nc", "a\nB\nC\nc"))).toEqual({ add: 2, del: 1 });
    expect(diffStat(computeDiffLines("x", "x"))).toEqual({ add: 0, del: 0 });
    const capped = computeDiffLines("x", Array.from({ length: 12 }, (_, i) => `n${i}`).join("\n"), 5);
    expect(diffStat(capped)).toEqual({ add: 5, del: 1 });
  });
});
