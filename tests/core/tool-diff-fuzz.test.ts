// Fuzz suite for generateDiff (src/core/extensions/tool-utils.ts).
// Untrusted input: file contents edited via tools can be anything, including
// forged diff-shaped text.
//
// Pinned contracts (read from source):
//   1. Line-sync diff: no hunk headers, no context lines. Every emitted line
//      is "- <old>" or "+ <new>"; mismatches emit adjacent pairs in lockstep,
//      then leftover old lines (all minuses) and leftover new lines (all
//      pluses) are appended. Identical text -> "".
//   2. maxLines only stops the PAIRING loop; the tail loops still append
//      everything, so the output is never truncated (pinned by the existing
//      tool-utils test). The break reorders lines but never changes content.
//   3. No hunk headers exist, so "--- ", "+++ ", "@@ -1,1 +1,1 @@" as file
//      content can only ever appear as the 2-char-prefixed payload of a
//      "- "/"+" line; the shape/count/multiset invariants below are the
//      forged-hunk detectors.
//   4. Count invariant (unconditional, break or not): count("+") - count("-")
//      == newLines.length - oldLines.length. Both indices advance in lockstep,
//      so the tail delta is always newLen - oldLen.
//   5. Entry-type shape is always (pair "-","+")* then deletion run "-"* then
//      addition run "+"* (never a "+" before a "-" outside a pair).
//   6. Multiset reconstruction: multiset(old) minus multiset(minus-lines) ==
//      multiset(new) minus multiset(plus-lines). Nothing materializes or
//      vanishes beyond the declared edits.
//   7. No apply path exists in the codebase (grep: no applyDiff). The
//      applyDiff() below reconstructs the new file from (old, diff); a
//      context-free diff is ambiguous when lines repeat (old "a\nb\na" ->
//      "a\nb\nc" and old "a" -> "c" share the diff "- a\n+ c"), so the strict
//      apply(old, diff) == new assertion runs on duplicate-free corpora where
//      the greedy lockstep alignment is provably exact.

import { describe, it, expect } from "bun:test";
import { generateDiff } from "@core/extensions/tool-utils.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── Independent apply: reconstructs the new file from (old, diff) ────
// Greedy lockstep: "- x" whose content equals the current old line consumes it
// ("+ y" right after becomes the replacement); leftover entries must be a
// trailing "+" run appended. Exact when old lines are unique.

function applyDiff(oldText: string, diff: string): string[] | null {
  const oldLines = oldText.split("\n");
  const entries = diff === "" ? [] : diff.split("\n");
  const out: string[] = [];
  let di = 0;
  for (const line of oldLines) {
    const e = di < entries.length ? entries[di]! : null;
    if (e !== null && e.startsWith("- ") && e.slice(2) === line) {
      di++;
      const next = di < entries.length ? entries[di]! : null;
      if (next !== null && next.startsWith("+ ")) {
        out.push(next.slice(2));
        di++;
      }
      // pure deletion: consume the old line, emit nothing
    } else {
      out.push(line); // untouched line
    }
  }
  for (; di < entries.length; di++) {
    const e = entries[di]!;
    if (!e.startsWith("+ ")) return null; // stray entry: malformed diff
    out.push(e.slice(2));
  }
  return out;
}

function multisetDifference(lines: string[], remove: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const r of remove) {
    const c = counts.get(r);
    if (c === undefined || c === 0) return new Map([["__UNDERFLOW__", 1]]);
    if (c === 1) counts.delete(r);
    else counts.set(r, c - 1);
  }
  return counts;
}

function countsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function isSubseq(sub: string[], sup: string[]): boolean {
  let j = 0;
  for (const s of sup) if (j < sub.length && sub[j] === s) j++;
  return j === sub.length;
}

interface DiffInvariants {
  oldText: string;
  newText: string;
  maxLines?: number;
  label: string;
}

function audit({ oldText, newText, maxLines, label }: DiffInvariants): string[] {
  const problems: string[] = [];
  const diff = generateDiff(oldText, newText, maxLines);
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldText === newText && diff !== "") problems.push(`${label}: identical text produced non-empty diff`);

  const entries = diff === "" ? [] : diff.split("\n");
  for (const line of entries) {
    if (!line.startsWith("- ") && !line.startsWith("+ ")) {
      problems.push(`${label}: unprefixed diff line ${JSON.stringify(line.slice(0, 40))}`);
      break;
    }
  }

  // entry-type shape: (pair)* deletion-run addition-run
  const shape = entries.map((l) => l[0]).join("");
  if (!/^(-\+)*-*\+*$/.test(shape)) problems.push(`${label}: entry shape violates (pair)*-*+*: ${shape.slice(0, 60)}`);

  const minus: string[] = [];
  const plus: string[] = [];
  for (const line of entries) (line.startsWith("- ") ? minus : plus).push(line.slice(2));

  const countDelta = plus.length - minus.length;
  if (countDelta !== newLines.length - oldLines.length) {
    problems.push(`${label}: count invariant broken: +${plus.length} -${minus.length} vs len delta ${newLines.length - oldLines.length}`);
  }

  if (!isSubseq(minus, oldLines)) problems.push(`${label}: minus lines not a subsequence of old`);
  if (!isSubseq(plus, newLines)) problems.push(`${label}: plus lines not a subsequence of new`);

  if (!countsEqual(multisetDifference(oldLines, minus), multisetDifference(newLines, plus))) {
    problems.push(`${label}: multiset reconstruction mismatch`);
  }
  return problems;
}

// ── Seeded content generators ───────────────────────────────────────

const FORGED_SHAPES = [
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1,1 +1,1 @@",
  "@@ -999,99999 +999,99999 @@",
  "- deleted fake",
  "+ added fake",
  "\\",
  "\\ No newline at end of file",
  " ...",
  "- ", // the exact 2-char minus prefix as CONTENT
  "+ ",
  "-\u{1f32d}",
];

const LINE_POOL = [
  "const x = 1;",
  "function hello() {",
  "  return 'world';",
  "}",
  "",
  "   ",
  "\t",
  "日本語のコメント",
  "emoji: \u{1f32d}\u{1f600}",
  "\u202e bidi",
  "nul\u0000byte",
  "a".repeat(500),
  ...FORGED_SHAPES,
];

function genLines(rng: Rng, n: number, pool: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rng.pick(pool));
  return out;
}

function withTrailing(rng: Rng, lines: string[]): string {
  const crlf = rng.bool(0.25);
  let text = lines.map((l) => (crlf ? l + "\r" : l)).join("\n");
  if (rng.bool(0.5) && lines.length > 0) text += crlf ? "\r\n" : "\n";
  return text;
}

// ── Targeted fixtures: pinned behaviors ─────────────────────────────

describe("tool-diff fixtures", () => {
  it("identical and empty pairs produce an empty diff", () => {
    expect(generateDiff("", "")).toBe("");
    expect(generateDiff("same\nlines", "same\nlines")).toBe("");
    expect(audit({ oldText: "", newText: "", label: "empty" })).toEqual([]);
  });

  it("CRLF vs LF differ on the \\r; both sides same ending stay clean", () => {
    expect(generateDiff("a\r\nb", "a\nb")).toBe("- a\r\n+ a");
    expect(generateDiff("a\r\nb", "a\r\nb")).toBe("");
    expect(audit({ oldText: "a\r\nb", newText: "a\nb", label: "crlf-vs-lf" })).toEqual([]);
  });

  it("no trailing newline vs trailing newline appends a blank plus line", () => {
    expect(generateDiff("a\nb", "a\nb\n")).toBe("+ ");
    expect(generateDiff("a\nb\n", "a\nb")).toBe("- ");
  });

  it("forged hunk headers are inert payloads", () => {
    const oldT = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\nkeep";
    const newT = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\nchanged";
    const diff = generateDiff(oldT, newT);
    expect(diff).toBe("- keep\n+ changed");
    for (const line of diff.split("\n")) expect(line.startsWith("- ") || line.startsWith("+ ")).toBe(true);
    expect(audit({ oldText: oldT, newText: newT, label: "forged-hunk" })).toEqual([]);
  });

  it("forged-hunk ambiguity: repeated lines make the context-free format lossy (pinned, not a crash)", () => {
    // old ["a","b","a"] -> new ["a","b","c"]: the diff names the payload, not
    // the position; a greedy applier resolves to the first "a". Structural
    // invariants still hold; this is why strict apply runs on unique lines.
    const diff = generateDiff("a\nb\na", "a\nb\nc");
    expect(diff).toBe("- a\n+ c");
    expect(audit({ oldText: "a\nb\na", newText: "a\nb\nc", label: "dup-ambiguity" })).toEqual([]);
  });

  it("change at first and last line of an all-context file", () => {
    const mid = Array.from({ length: 100 }, (_, i) => `ctx ${i}`).join("\n");
    const oldT = `first\n${mid}\nlast`;
    const newT = `FIRST\n${mid}\nLAST`;
    expect(generateDiff(oldT, newT)).toBe("- first\n+ FIRST\n- last\n+ LAST");
    expect(audit({ oldText: oldT, newText: newT, label: "first-last" })).toEqual([]);
  });
});

// ── Seeded fuzz: invariants on hostile content pairs ────────────────

describe("tool-diff fuzz", () => {
  const SEED = 0x6469_6666; // "diff"

  it("independent random pairs: invariants hold, never throws", () => {
    const rng = makeRng(SEED);
    const failures: string[] = [];
    for (let iter = 0; iter < 250; iter++) {
      const oldText = withTrailing(rng, genLines(rng, rng.int(25), LINE_POOL));
      const newText = withTrailing(rng, genLines(rng, rng.int(25), LINE_POOL));
      try {
        const problems = audit({ oldText, newText, label: `indep#${iter}` });
        if (problems.length > 0) failures.push(...problems);
      } catch (e) {
        failures.push(`indep#${iter} threw: ${(e as Error).message}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  it("edit-window pairs (replace/insert/delete at random windows) hold, incl. tiny maxLines", () => {
    const rng = makeRng(0x6564_6974); // "edit"
    const failures: string[] = [];
    for (let iter = 0; iter < 250; iter++) {
      const base = genLines(rng, 1 + rng.int(60), LINE_POOL);
      const edits = 1 + rng.int(4);
      const next = [...base];
      for (let e = 0; e < edits; e++) {
        if (next.length === 0) break;
        const at = rng.int(next.length);
        const kind = rng.int(3);
        if (kind === 0) next[at] = rng.pick(LINE_POOL);
        else if (kind === 1) next.splice(at, 0, rng.pick(LINE_POOL));
        else next.splice(at, 1);
      }
      const oldText = withTrailing(rng, base);
      const newText = withTrailing(rng, next);
      try {
        const problems = audit({ oldText, newText, label: `edit#${iter}` });
        if (problems.length > 0) failures.push(...problems);
        if (rng.bool(0.3)) {
          // same pair under a tiny maxLines: tail still appended, invariants hold
          const p2 = audit({ oldText, newText, maxLines: rng.int(4), label: `edit#${iter}@ml` });
          if (p2.length > 0) failures.push(...p2);
        }
      } catch (err) {
        failures.push(`edit#${iter} threw: ${(err as Error).message}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  it("duplicate-free corpora: apply(old, diff) rebuilds new exactly (forged shapes included)", () => {
    const rng = makeRng(0x756e_6971); // "uniq"
    const failures: string[] = [];
    for (let iter = 0; iter < 200; iter++) {
      const n = rng.int(40);
      // unique lines: indexed content, occasionally a unique diff-shaped line
      const base: string[] = [];
      for (let i = 0; i < n; i++) {
        base.push(rng.bool(0.25) ? `${rng.pick(FORGED_SHAPES)} #${i}` : `L${i} \u{1f32d} value ${rng.int(1000)}-${i}`);
      }
      const next = [...base];
      const edits = rng.int(6);
      for (let e = 0; e < edits && next.length > 0; e++) {
        const at = rng.int(next.length);
        const kind = rng.int(3);
        if (kind === 0) next[at] = `NEW${at}-${e}`;
        else if (kind === 1) next.splice(at, 0, `INS-${e}`);
        else next.splice(at, 1);
      }
      const oldText = withTrailing(rng, base);
      const newText = withTrailing(rng, next);
      try {
        const problems = audit({ oldText, newText, label: `uniq#${iter}` });
        if (problems.length > 0) failures.push(...problems);
        const maxLines = rng.bool(0.2) ? rng.int(5) : undefined;
        const rebuilt = applyDiff(oldText, generateDiff(oldText, newText, maxLines));
        const want = newText.split("\n");
        if (rebuilt === null) failures.push(`uniq#${iter}: apply hit malformed entry`);
        else if (rebuilt.length !== want.length || rebuilt.some((l, i) => l !== want[i])) {
          failures.push(`uniq#${iter}: apply(old, diff) != new`);
        }
      } catch (e) {
        failures.push(`uniq#${iter} threw: ${(e as Error).message}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  it("forged-hunk heavy corpora: diff-shaped text as content never corrupts structure", () => {
    const rng = makeRng(0x666f_7267); // "forg"
    const failures: string[] = [];
    for (let iter = 0; iter < 150; iter++) {
      const n = 3 + rng.int(12);
      const oldLines = genLines(rng, n, FORGED_SHAPES);
      const newLines = [...oldLines];
      newLines[rng.int(n)] = rng.pick(FORGED_SHAPES);
      const oldText = oldLines.join("\n");
      const newText = newLines.join("\n");
      try {
        const problems = audit({ oldText, newText, label: `forg#${iter}` });
        if (problems.length > 0) failures.push(...problems);
      } catch (e) {
        failures.push(`forg#${iter} threw: ${(e as Error).message}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });
});

// ── Large inputs: keep the linear loop honest ───────────────────────

describe("tool-diff performance", () => {
  const BUDGET_MS = 500;

  it("30k-line file, one change at line 15000, within budget", () => {
    const oldLines = Array.from({ length: 30_000 }, (_, i) => `line ${i} \u{1f32d}`);
    const newLines = [...oldLines];
    newLines[15_000] = "CHANGED";
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    const t0 = performance.now();
    const diff = generateDiff(oldText, newText);
    const ms = performance.now() - t0;
    expect(diff).toBe("- line 15000 \u{1f32d}\n+ CHANGED");
    expect(applyDiff(oldText, diff)).toEqual(newText.split("\n"));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("30k-line all-context rewrite and first+last change within budget", () => {
    const base = Array.from({ length: 30_000 }, (_, i) => `ctx ${i}`);
    const same = base.join("\n");
    const moved = [...base];
    moved[0] = "FIRST";
    moved[moved.length - 1] = "LAST";
    const newText = moved.join("\n");
    const t0 = performance.now();
    expect(generateDiff(same, same)).toBe("");
    const d2 = generateDiff(same, newText);
    const ms = performance.now() - t0;
    expect(d2).toBe("- ctx 0\n+ FIRST\n- ctx 29999\n+ LAST");
    expect(applyDiff(same, d2)).toEqual(newText.split("\n"));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("maxLines=0 chaos: break path fires, output NOT truncated, apply still exact", () => {
    const oldLines = Array.from({ length: 5_000 }, (_, i) => `o${i}`);
    const newLines = Array.from({ length: 5_000 }, (_, i) => `n${i}`);
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    const t0 = performance.now();
    const diff = generateDiff(oldText, newText, 0);
    const ms = performance.now() - t0;
    expect(applyDiff(oldText, diff)).toEqual(newText.split("\n"));
    expect(audit({ oldText, newText, maxLines: 0, label: "ml0" })).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
