// Fuzz suite for output-side framing utilities:
//   - truncateOutput + firstLinePreview (src/core/extensions/tool-utils.ts)
//   - splitFileIncludes (src/utils/tool-content.ts)
//
// REAL MARKER STRINGS (read from source, built via concat here so this file
// holds no fragile literals):
//   truncation notice: `--- [truncated, N more lines] ---` appended after the
//   kept region when lines.length > maxLines.
//   file-include "marker" shape: splitFileIncludes operates on STRUCTURED
//   parts ({ type: "file-include", path, content } objects), not raw marker
//   text -- the include boundary is part structure, so corpora carry
//   marker-shaped STRINGS (the rendered xml file-include framing text) inside
//   part fields and must pass through byte-identical.
//
// INVARIANTS:
//   truncateOutput: output = kept-lines + "\n" + notice when truncated (never
//   a partial-line glue: the kept prefix is byte-identical to lines[0..max]);
//   a GENUINE notice is the final line and appears exactly once; marker-shaped
//   content inside the kept region is payload and is NEVER mistaken for, or
//   merged with, the genuine notice (genuine notices counted independently by
//   exact line match); kept line count == maxLines for maxLines >= 0.
//   splitFileIncludes: files deep-equal the input file-include parts in order
//   (no bytes torn between segments); text == wrapperContentText of the rest;
//   input array never mutated; reassembly (files + remaining parts, in place)
//   is byte-identical to the input JSON.
//   firstLinePreview: preview = first non-blank line trimmed, capped at 80
//   RUNES plus the ellipsis, never bisecting a surrogate pair; marker-shaped
//   text survives verbatim (display surface, no mangling).
// Edge inputs (empty, marker-only, maxLines 0/1/negative, CRLF-only) pinned to
// the ACTUAL behavior recorded in the run notes.

import { describe, it, expect } from "bun:test";
import { truncateOutput, firstLinePreview } from "@core/extensions/tool-utils.ts";
import { splitFileIncludes, wrapperContentText } from "@utils/tool-content.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── truncateOutput ──────────────────────────────────────────────────

const notice = (n: number): string => `--- [truncated, ${n} more lines] ---`;

function countLineMatches(lines: string[], target: string): number {
  return lines.filter((l) => l === target).length;
}

const LINE_TOKENS = [
  "alpha",
  "beta line with spaces",
  "", // blank line
  "---",
  "- - [truncated, 3 more lines] -", // near-lookalike
  "*** [truncated, 3 more lines] ***",
  "--- [truncated, 3 more line] ---", // singular decoy
  "--- [truncated  3 more lines] ---",
  "--- [truncated, 99999 more lines] ---",
  " --- [truncated, 7 more lines] ---", // leading space
  "--- [truncated, 7 more lines] --- tail", // trailing junk
  "prefix --- [truncated, 7 more lines] ---",
  "console.log('--- [truncated,')",
  "a\r", // CRLF remnant when splitting on \n
  "\ud83d\ude00 emoji line",
  "ключ 42",
  "x".repeat(500),
] as const;

// Full real-notice lines with varying counts, as pure content.
function genLines(rng: Rng): string[] {
  const n = 1 + rng.int(40);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const roll = rng.float();
    if (roll < 0.3) out.push(notice(rng.int(50))); // genuine-SHAPED line as payload
    else out.push(rng.pick(LINE_TOKENS));
  }
  return out;
}

describe("truncateOutput fuzz", () => {
  it("kept region is byte-identical, one genuine notice, no forged or glued edges", () => {
    const rng = makeRng(0x5472756e); // "Trun"
    const failures: { iter: number; detail: string }[] = [];
    for (let iter = 0; iter < 400; iter++) {
      const lines = genLines(rng);
      const text = lines.join("\n");
      const maxLines = rng.int(lines.length + 4) - 2; // includes -2..-1 and 0/1
      let out: string;
      try {
        out = truncateOutput(text, maxLines);
      } catch (e) {
        failures.push({ iter, detail: `threw: ${(e as Error).message}` });
        continue;
      }
      const truncated = lines.length > maxLines;
      if (!truncated) {
        if (out !== text) failures.push({ iter, detail: "pass-through modified the text" });
        continue;
      }
      // slice semantics incl. negatives: kept = lines.slice(0, maxLines)
      const kept = lines.slice(0, maxLines);
      const expectedNotice = notice(lines.length - maxLines); // NOTE: negatives inflate N (pinned below)
      const suffix = "\n" + expectedNotice;
      if (!out.endsWith(suffix)) {
        failures.push({ iter, detail: `output does not end with the genuine notice: ${JSON.stringify(out.slice(-40))}` });
        continue;
      }
      if (out.slice(0, out.length - suffix.length) !== kept.join("\n")) {
        failures.push({ iter, detail: "kept region != lines[0..max]" });
      }
      // The genuine notice (exact final line) appears exactly once as the
      // appended framing; payload-shaped notices are counted independently.
      const outLines = out.split("\n");
      const genuine = countLineMatches(outLines, expectedNotice);
      const inKept = countLineMatches(kept, expectedNotice);
      if (genuine !== inKept + 1) {
        failures.push({ iter, detail: `notice lines=${genuine} keptPayloadCopies=${inKept} want=${inKept + 1}` });
      }
      if (maxLines >= 1 && outLines.length !== maxLines + 1) {
        failures.push({ iter, detail: `out lines=${outLines.length} want=${maxLines + 1}` });
      }
      if (maxLines === 0 && out !== "\n" + expectedNotice) {
        failures.push({ iter, detail: "maxLines=0 must be bare newline + notice" });
      }
    }
    expect(failures).toEqual([]);
  });

  it("notice placed at EVERY cut position; marker-shaped content at the boundary never merges", () => {
    // The dangerous adjacency: the LAST kept line is exactly the notice shape,
    // and again just past the cut (dropped). The appended notice must still be
    // a distinct line, and the dropped copy must not be mentioned.
    for (let max = 1; max <= 6; max++) {
      const lines = ["a", "b", "c", "d", "e", "f", "g"].map((l, i) =>
        i === max - 1 || i === max || i === 0 ? notice(5) : l,
      );
      const out = truncateOutput(lines.join("\n"), max);
      const outLines = out.split("\n");
      expect(outLines[outLines.length - 1]).toBe(notice(7 - max));
      expect(out.startsWith(notice(5))).toBe(max >= 1 && lines[0] === notice(5));
      expect(out.slice(0, out.length - ("\n" + notice(7 - max)).length)).toBe(
        lines.slice(0, max).join("\n"),
      );
    }
  });

  it("edge inputs pinned to actual behavior", () => {
    // Empty-ish: falsy short-circuit returns "" for ANY maxLines.
    expect(truncateOutput("", 3)).toBe("");
    expect(truncateOutput("", -1)).toBe("");
    // Single line at/over the cap.
    expect(truncateOutput("x", 1)).toBe("x");
    expect(truncateOutput("x", 0)).toBe("\n" + notice(1));
    // maxLines 0: kept region is empty, notice still appended after a newline.
    expect(truncateOutput("a\nb\nc", 0)).toBe("\n" + notice(3));
    // Negative maxLines: Array.slice(0, -k) drops from the END and the
    // reported count (lines.length - maxLines) is INFLATED by |maxLines|.
    // Pinned: real callers only pass resolved positive config values, but a
    // negative must never crash and never claim a kept line count above the
    // input length.
    expect(truncateOutput("a\nb\nc", -1)).toBe("a\nb\n" + notice(4));
    expect(truncateOutput("a", -5)).toBe("\n" + notice(6));
    // CRLF-only content: split is on \n only, so kept lines end in \r and the
    // appended notice starts right after that \r's newline: no glue, no \r
    // eaten.
    expect(truncateOutput("a\r\nb\r\nc", 1)).toBe("a\r\n" + notice(2));
    expect(truncateOutput("\r\n\r\n", 1)).toBe("\r\n" + notice(2));
    // Marker-only input, not truncated: the decoy passes through untouched.
    const decoy = notice(123);
    expect(truncateOutput(decoy, 5)).toBe(decoy);
    expect(truncateOutput(decoy + "\n" + decoy, 2)).toBe(decoy + "\n" + decoy);
    // Marker-only input, truncated: exactly the decoy lines + one genuine.
    const out = truncateOutput([decoy, decoy, decoy].join("\n"), 1);
    expect(out).toBe(decoy + "\n" + notice(2));
    expect(out.split("\n").filter((l) => l === decoy).length).toBe(1);
  });
});

// ── splitFileIncludes ───────────────────────────────────────────────

const F = "file-include"; // the part-type discriminator (a bare word, not a marker)

function markerText(rng: Rng): string {
  // The rendered framing bytes the xml format emits around includes/notices,
  // used as STRING payloads: adjacent, at both ends, marker-inside-marker.
  const fi = "<" + F + ">";
  const cfi = "</" + F + ">";
  const parts = ["start ", fi, "\n<contents>\n", "body", "</contents>\n", cfi, " mid ", cfi + fi, " end"];
  const n = 1 + rng.int(6);
  let out = "";
  for (let i = 0; i < n; i++) out += rng.pick(parts);
  return out;
}

function genContentArray(rng: Rng): unknown[] {
  const content: unknown[] = [];
  const n = rng.int(7);
  for (let i = 0; i < n; i++) {
    const roll = rng.float();
    if (roll < 0.45) {
      content.push({
        type: F,
        path: rng.bool() ? markerText(rng) : `docs/${rng.int(99)}.md`,
        content: rng.bool(0.7) ? markerText(rng) : "plain file body",
      });
    } else if (roll < 0.75) {
      content.push({ type: "text", text: rng.bool() ? markerText(rng) : "user text" });
    } else if (roll < 0.85) {
      content.push({ type: "untrusted", text: markerText(rng) });
    } else if (roll === 0.85) {
      content.push(null); // junk shapes must not crash the walk
    } else if (roll < 0.9) {
      content.push({ type: F, path: "missing-content" }); // malformed include shape
    } else if (roll < 0.95) {
      content.push({ type: "other", value: 1 });
    } else {
      content.push("bare string in array");
    }
  }
  return content;
}

describe("splitFileIncludes fuzz", () => {
  it("files deep-equal the input includes; reassembly is byte-identical; input unmutated", () => {
    const rng = makeRng(0x46696c74); // "Filt"
    const failures: { iter: number; detail: string }[] = [];
    for (let iter = 0; iter < 300; iter++) {
      const content = genContentArray(rng);
      const before = JSON.stringify(content);
      let res: ReturnType<typeof splitFileIncludes>;
      try {
        res = splitFileIncludes(content);
      } catch (e) {
        failures.push({ iter, detail: `threw: ${(e as Error).message}` });
        continue;
      }
      if (JSON.stringify(content) !== before) failures.push({ iter, detail: "input array mutated" });
      // Expected partition computed independently: valid includes are the
      // parts carrying string path AND string content (isWrapperPart shape).
      const isValidInclude = (p: unknown): boolean => {
        if (!p || typeof p !== "object") return false;
        const q = p as Record<string, unknown>;
        return q.type === F && typeof q.path === "string" && typeof q.content === "string";
      };
      const includes = content.filter(isValidInclude);
      const rest = content.filter((p) => !isValidInclude(p));
      const wantFiles = includes.map((p) => {
        const q = p as { path: string; content: string };
        return { path: q.path, content: q.content };
      });
      if (JSON.stringify(res.files) !== JSON.stringify(wantFiles)) {
        failures.push({ iter, detail: "files != input includes (order or bytes torn)" });
      }
      if (res.text !== wrapperContentText(rest)) {
        failures.push({ iter, detail: "text != prose of the remaining parts" });
      }
      // No include body leaks into text: every include's content may only
      // appear in text when a surviving (non-include) part carries it (or
      // when the prose join happens to spell it across a boundary, which is
      // the display join's own behavior, not a torn include).
      const renderedTexts = rest.filter(
        (p) =>
          !!p && typeof p === "object" &&
          ["text", "untrusted"].includes((p as Record<string, unknown>).type as string) &&
          typeof (p as Record<string, unknown>).text === "string",
      ) as Array<{ text: string }>;
      for (const inc of includes) {
        const q = inc as { path: string; content: string };
        if (q.content.length > 0 && !res.text.includes(q.content)) continue;
        const carried = renderedTexts.some((t) => t.text.includes(q.content));
        const crossBoundary =
          !carried &&
          q.content.split("\n").every((frag) => frag.length === 0 || res.text.includes(frag));
        if (q.content.length > 0 && !carried && !crossBoundary) {
          failures.push({ iter, detail: "include content leaked into text" });
        }
      }
      // Reassembly: files in place + remaining parts reconstruct the original
      // array exactly (the split loses nothing, tears nothing).
      let fi = 0;
      const rebuilt = content.map((p) => (isValidInclude(p) ? { type: F, ...res.files[fi++] } : p));
      if (JSON.stringify(rebuilt) !== before) failures.push({ iter, detail: "reassembly not byte-identical" });
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("adjacent, both-ends and nested include shapes keep every marker whole", () => {
    const mk = (path: string, content: string) => ({ type: F, path, content });
    const inner = "<" + F + ">";
    const closed = "</" + F + ">";
    const nested = inner + "\n" + inner + "deep" + closed + "\n" + closed;
    const content = [
      mk(inner, nested), // marker inside marker, marker-named path
      mk("p1", "a" + closed + inner + "b"),
      mk("p2", "at start" + inner),
      { type: "text", text: closed + "between" + inner },
      mk("p3", closed + "at end"),
    ];
    const res = splitFileIncludes(content);
    expect(res.files.length).toBe(4);
    expect(res.files.map((f) => f.path)).toEqual([inner, "p1", "p2", "p3"]);
    expect(res.files[0]!.content).toBe(nested);
    expect(res.files[1]!.content).toBe("a" + closed + inner + "b");
    expect(res.text).toBe(closed + "between" + inner); // only the text part renders
  });

  it("edge inputs pinned to actual behavior", () => {
    expect(splitFileIncludes("")).toEqual({ text: "", files: [] });
    expect(splitFileIncludes("plain string passes through")).toEqual({
      text: "plain string passes through",
      files: [],
    });
    expect(splitFileIncludes(null)).toEqual({ text: "", files: [] });
    expect(splitFileIncludes(undefined)).toEqual({ text: "", files: [] });
    // Only marker text as a string: it is just text, files stay empty.
    const markerOnly = "<" + F + ">x</" + F + ">";
    expect(splitFileIncludes(markerOnly)).toEqual({ text: markerOnly, files: [] });
    // Non-string non-array: prose view degrades to "".
    expect(splitFileIncludes(42 as unknown as string)).toEqual({ text: "", files: [] });
    // Array with empty strings: include with empty path/content IS an include.
    const res = splitFileIncludes([{ type: F, path: "", content: "" }]);
    expect(res.files).toEqual([{ path: "", content: "" }]);
    expect(res.text).toBe("");
    // Malformed include shape (no content string) is NOT an include and
    // renders nothing in the prose view.
    const bad = splitFileIncludes([{ type: F, path: "x" }]);
    expect(bad.files).toEqual([]);
    expect(bad.text).toBe("");
  });
});

// ── firstLinePreview ────────────────────────────────────────────────

describe("firstLinePreview fuzz", () => {
  it("caps at 80 runes without bisecting surrogates; marker shapes survive verbatim", () => {
    const rng = makeRng(0x50726576); // "Prev"
    const failures: { iter: number; detail: string }[] = [];
    for (let iter = 0; iter < 300; iter++) {
      const lines = genLines(rng);
      const value = lines.join("\n");
      try {
        const { preview, stub } = firstLinePreview(value, lines);
        const first = (lines.find((l) => l.trim() !== "") ?? "").trim();
        const wantHead = Array.from(first).length > 80 ? Array.from(first).slice(0, 80).join("") : first;
        if (preview !== wantHead + "\u2026") {
          failures.push({ iter, detail: `preview mismatch: ${JSON.stringify(preview)}` });
        }
        // The exact match against wantHead above already pins the cap to
        // Array.from semantics (pairs kept whole); a lone surrogate here can
        // only come from a lone surrogate in the source line. Dedicated
        // astral-cap fixtures below pin the pair-splitting case directly.
        if (stub !== `(${lines.length} lines, ${value.length} chars)`) {
          failures.push({ iter, detail: `stub mismatch: ${JSON.stringify(stub)}` });
        }
      } catch (e) {
        failures.push({ iter, detail: `threw: ${(e as Error).message}` });
      }
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("marker-boundary pass pinned", () => {
    const marker = notice(5);
    // Marker on the first line rides into the preview unchanged.
    expect(firstLinePreview(marker + "\nbody", [marker, "body"]).preview).toBe(marker + "\u2026");
    // Leading blank lines are skipped; stub still counts them.
    expect(firstLinePreview("\n \n ab \n", ["", " ", " ab ", ""]).preview).toBe("ab\u2026");
    expect(firstLinePreview("\n \n ab \n", ["", " ", " ab ", ""]).stub).toBe("(4 lines, 8 chars)");
    // All-blank input: preview is the bare ellipsis, stub reports zero-ish.
    expect(firstLinePreview("", [])).toEqual({ preview: "\u2026", stub: "(0 lines, 0 chars)" });
    expect(firstLinePreview("\n\n", ["", "", ""]).preview).toBe("\u2026");
    // CRLF: lines come from split("\n"), \r is trimmed away with the rest.
    expect(firstLinePreview("a\r\nb", ["a\r", "b"]).preview).toBe("a\u2026");
    // Astral run: cap counts RUNES, a pair at position 80 is kept whole.
    const face = "\u{1F600}";
    const long = face.repeat(90);
    const { preview } = firstLinePreview(long, [long]);
    expect(Array.from(preview).length).toBe(81); // 80 + ellipsis
    expect(preview).toBe(face.repeat(80) + "\u2026");
    // Exactly 80 runes: still gets the ellipsis (the cap adds it unconditionally).
    const exact = "x".repeat(80);
    expect(firstLinePreview(exact, [exact]).preview).toBe(exact + "\u2026");
  });
});
