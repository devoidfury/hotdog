// The find half of the editor core: a PURE finder + the replace/select-all
// helpers. Zero DOM -- editor.tsx is the widget, this file is (state, args)
// -> new state, so the tests drive it directly.
//
// ── THE SHAPE ──────────────────────────────────────────────────────────────
// Regex runs PER LINE over the already-split lines (the natural bound):
// matches never span lines (v1 ceiling -- the widget says so honestly when
// the query contains a newline). A bad regex is an honest error string on
// FindResult, never a throw into the render path. Occurrences come back in
// document order, NON-OVERLAPPING left-to-right (the global-regex scan
// resumes after each match, and it walks past a zero-length match on its
// own -- `x*` cannot spin).
//
// Literal queries ride the SAME matchAll loop through an escaped source:
// the code-unit columns stay aligned with the ORIGINAL line (indexOf on
// lowercased text drifts on special case folding) and the `i` flag carries
// the case toggle. Whole-word is a boundary filter on the matched span's
// neighbours, UNICODE-aware (\p{L}/\p{N}/_ -- ASCII \w would call the é in
// "cafe's neighbour" a boundary); surrogate pairs at the boundary read whole.
//
// ── THE UNDO RULE ──────────────────────────────────────────────────────────
// Every mutation routes through editor-buffer's performTx seam as a BLOCK
// step: replace-one and replace-all are each ONE undo step (never coalesced
// into an adjacent typing run), and dirty re-derives through stampDirty --
// replacing back to the baseline bytes reads clean for free, same as undo.

import {
  caretAfterEdit,
  performTx,
  selectRange,
  setCaret,
  type Pos,
  type SelRange,
  type TextBuffer,
} from "./editor-buffer.ts";

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One occurrence: line + code-unit columns inside the line, document order. */
export interface FindMatch {
  line: number;
  from: number;
  to: number;
}

/** ok:false carries the honest widget string (bad regex, multi-line query). */
export type FindResult =
  | { ok: true; matches: FindMatch[] }
  | { ok: false; error: string };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word boundary class: letters + numbers + underscore, unicode. */
const WORD_CH = /[\p{L}\p{N}_]/u;

const isSurrogatePair = (a: number, b: number): boolean =>
  a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;

/** The code point immediately LEFT of column `col` (pair whole; undefined
 *  at the line's start). */
const chLeft = (line: string, col: number): string | undefined => {
  if (col <= 0) return undefined;
  if (col >= 2 && isSurrogatePair(line.charCodeAt(col - 2), line.charCodeAt(col - 1)))
    return line.slice(col - 2, col);
  return line.slice(col - 1, col);
};

/** The code point immediately RIGHT of column `col` (pair whole; undefined
 *  at the line's end). */
const chRight = (line: string, col: number): string | undefined => {
  if (col >= line.length) return undefined;
  if (isSurrogatePair(line.charCodeAt(col), line.charCodeAt(col + 1)))
    return line.slice(col, col + 2);
  return line.slice(col, col + 1);
};

const wholeWordOk = (line: string, from: number, to: number): boolean =>
  !(chLeft(line, from) ?? "").match(WORD_CH) && !(chRight(line, to) ?? "").match(WORD_CH);

/** All occurrences of `query` across `lines`, document order,
 *  non-overlapping. Empty query = no matches (and no error). */
export function findMatches(lines: string[], query: string, opts: FindOptions): FindResult {
  if (query === "") return { ok: true, matches: [] };
  if (query.includes("\n"))
    return { ok: false, error: "Multi-line find is not supported (v1) -- the search runs per line." };
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRegExp(query), opts.caseSensitive ? "g" : "gi");
  } catch (e) {
    // The honest string IS the product here (it paints in the widget), not a
    // log line -- so no formatError: the client bundle deliberately carries no
    // core imports (same doctrine as the EDIT_CHAR_CAP twin).
    return { ok: false, error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}` };
  }
  const matches: FindMatch[] = [];
  if (!opts.regex && opts.caseSensitive) {
    // Literal + exact case: the escaped-literal matchAll below is exactly a
    // non-overlapping left-to-right indexOf walk, so ride indexOf directly
    // (no per-line iterator, no per-match array). Case-INSENSITIVE stays on
    // the regex path -- lowercasing drifts the columns under special case
    // folding (the doctrine noted up top). Whole-word is the same boundary
    // filter on the matched span's neighbours.
    const step = query.length;
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line]!;
      for (let from = text.indexOf(query); from >= 0; from = text.indexOf(query, from + step)) {
        const to = from + step;
        if (opts.wholeWord && !wholeWordOk(text, from, to)) continue;
        matches.push({ line, from, to });
      }
    }
    return { ok: true, matches };
  }
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    // matchAll never mutates the source regex's lastIndex, so every line
    // starts at 0; each per-line scan is non-overlapping by construction.
    for (const m of text.matchAll(re)) {
      const from = m.index!;
      const to = from + m[0].length;
      if (opts.wholeWord && !wholeWordOk(text, from, to)) continue;
      matches.push({ line, from, to });
    }
  }
  return { ok: true, matches };
}

/** The first match STARTING at or after `pos` (document order); wraps to 0
 *  when the scan walks off the end -- the wrap next/open share. */
export function indexAtOrAfter(matches: FindMatch[], pos: Pos): number {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.line > pos.line || (m.line === pos.line && m.from >= pos.col)) return i;
  }
  return 0;
}

const matchRange = (m: FindMatch): SelRange => ({
  anchor: { line: m.line, col: m.from },
  head: { line: m.line, col: m.to },
});

/** Replace ONE occurrence (the widget's current match) as its own block
 *  undo step. `replacement` is single-line by construction: an <input>
 *  cannot carry \n (stated v1 ceiling for the replace text). */
export function replaceMatch(buf: TextBuffer, m: FindMatch, replacement: string, time: number): TextBuffer {
  const staged = selectRange(buf, { line: m.line, col: m.from }, { line: m.line, col: m.to });
  return performTx(staged, () => replacement, caretAfterEdit, { kind: "block", time });
}

/** Replace EVERY occurrence in ONE undo step: the match list stages as the
 *  selection list (non-overlapping and ascending by construction, so the
 *  descending apply order stays correct), then the caret collapses onto the
 *  first replacement's landing spot -- a multi-caret leftover would type
 *  twice on the next keystroke. */
export function replaceAll(buf: TextBuffer, matches: FindMatch[], replacement: string, time: number): TextBuffer {
  if (matches.length === 0) return buf;
  const staged: TextBuffer = { ...buf, sels: matches.map(matchRange), primary: 0 };
  const out = performTx(staged, () => replacement, caretAfterEdit, { kind: "block", time });
  return setCaret(out, out.sels[0]?.head ?? { line: 0, col: 0 });
}

/** Every occurrence becomes its own selection, feeding the EXISTING
 *  multi-caret typing (VS Code's Ctrl+D chain is the stated ceiling; this
 *  one action is the shipped affordance). Primary rides the widget's
 *  current match so the caret context survives. */
export function selectOccurrences(buf: TextBuffer, matches: FindMatch[], primary: number): TextBuffer {
  if (matches.length === 0) return buf;
  const sels = matches.map(matchRange);
  return { ...buf, sels, primary: Math.max(0, Math.min(primary, sels.length - 1)) };
}
