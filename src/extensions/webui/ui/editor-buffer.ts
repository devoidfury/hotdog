// The editor's PURE half: the text buffer, the selection-as-range-list model,
// the undo transaction seam, and the save/dirty state machine. Zero DOM, zero
// storage -- every operation is (state, args) -> new state, so editor.tsx is
// projection + event translation and tests drive the model directly.
//
// ── THE SELECTION MODEL (the multicaret node extends THIS, it does not
//    redefine it) ──────────────────────────────────────────────────────────
// `sels` is ALWAYS a list of ranges (length >= 1) with one designated
// `primary` index. The multicaret affordances (Alt+click, add-caret-
// vertical, column select) add entries, and every editing op in this file
// iterates the list:
// insert/delete apply to EVERY range (edits are computed against one shared
// pre-state and applied highest-position-first so each entry's coordinates
// stay valid), caret ops move the primary, and the paint layer draws every
// range with the primary wearing the caret. Positions are LINE + CODE-UNIT
// COLUMN inside lines WITHOUT terminators -- never a flat offset, so a
// buffer edit never renumbers the other selections' line coordinates.
//
// ── THE UNDO SEAM (generic: a step is a list of inverse edits) ─────────────
// Every buffer mutation -- typing, deletes, Enter, tab, dedent, and every
// LATER brace/multicaret op -- flows through performTx, which records one
// TxEntry per applied edit: { edit, inverse }, coordinates valid in the
// state right before that edit and right after it respectively. Undo replays
// the inverses of the newest step in reverse order; redo replays the edits
// in order. That LIFO discipline is why batched (multi-range) transactions
// stay correct without a coordinate transform, and why coalescing is just
// LIST CONCATENATION: consecutive transactions leave consecutive states, so
// merging two steps' entry lists is always replayable. Typing runs coalesce
// into word/timeout-bounded steps (see shouldMerge); structural ops land as
// their own "block" steps.

import type { FileOpResultWire } from "@extensions/websocket/protocol.ts";

/** Tab stops (and the Tab-key insert step) are a fixed 4 columns -- the
 *  house default, deliberately not a config key. */
export const TAB_STOP = 4;

/** Typing coalescing window: two typing steps this far apart are separate
 *  undo steps (word boundaries split sooner, see shouldMerge). */
export const COALESCE_MS = 500;

/** The edit seam's char ceiling: the SAME number as the server's
 *  MAX_FILE_READ_CHARS -- a buffer can only ever hold what readFile shipped
 *  (the client pages to this ceiling and stops), and the server re-gates the
 *  save in UTF-8 BYTES at MAX_FILE_WRITE_BYTES, which equals it (pinned in
 *  tests/dom-helper/editor-buffer.test.ts). A value import from
 *  protocol.ts would drag the whole server protocol module into the client
 *  bundle, so this is a documented twin, not a wire dependency. */
export const EDIT_CHAR_CAP = 256 * 1024;

/** Page size the editor's full-load pager asks for: the twin of the
 *  server's MAX_READ_LINES clamp (pinned beside the cap). */
export const EDIT_PAGE_LINES = 5000;

// ── Geometry ─────────────────────────────────────────────────────────────────

/** A position: line index (0-based) + column in UTF-16 code units within
 *  the line text (which never holds a terminator). */
export interface Pos {
  line: number;
  col: number;
}

/** One selection range. anchor == head is a caret. anchor is the drag/
 *  extend origin; head is the moving end (where the caret sits). */
export interface SelRange {
  anchor: Pos;
  head: Pos;
}

/** A replacement: text [from,to) becomes `insert` (which may contain \n).
 *  `removed` keeps the original span so an inverse is self-describing.
 *  Coordinates are against the state immediately before the edit. */
export interface Edit {
  from: Pos;
  to: Pos;
  insert: string;
  removed: string;
}

export interface TxEntry {
  edit: Edit;
  inverse: Edit;
}

/** One undoable unit. `entries` are in APPLY order; undo replays the
 *  inverses in REVERSE order, redo replays the edits in order. */
export interface UndoStep {
  entries: TxEntry[];
  selsBefore: SelRange[];
  primaryBefore: number;
  selsAfter: SelRange[];
  primaryAfter: number;
  kind: "typing" | "block";
  /** Epoch ms of the (last) user action in the step -- the coalescing clock. */
  time: number;
}

export interface TextBuffer {
  /** Line texts WITHOUT terminators; ALWAYS at least one entry ("" for the
   *  empty file), so a caret position always exists. */
  lines: string[];
  /** The file's bytes ended with \n at the last save/read. Save rebuilds
   *  the exact bytes as lines.join("\n") + (endsNL ? "\n" : "") -- a
   *  trailing newline the file had is never silently gained or dropped. */
  endsNL: boolean;
  /** Selection list, length >= 1, sorted by document order (head). */
  sels: SelRange[];
  /** Index into sels of the caret-owning range. */
  primary: number;
  undo: UndoStep[];
  redo: UndoStep[];
  /** The exact serialized text (what contentOf produces) of the last
   *  read/save: seeded by bufferFromContent, re-seeded by markSaved, and
   *  re-seeded whenever a fresh buffer is built from disk text. */
  baseline: string;
  /** DERIVED at every commit, never a latch: current serialization !== the
   *  baseline. Text changed back to the baseline -- by undo or by any other
   *  route -- reads CLEAN; the tab dot, the close
   *  gate and the beforeunload veto all ride this flag's honesty. */
  dirty: boolean;
}

/** What the app hangs around a buffer: the save identity (path + the mtime
 *  recorded when the bytes were read, moved by save/conflict only) and the
 *  one-save-in-flight flag. */
export interface EditorSession {
  path: string;
  buffer: TextBuffer;
  /** The mtimeMs this buffer believes the file has (the saveFile
   *  baseMtimeMs). Read from readFileResult, moved by save success (the
   *  file's NEW mtime) and by the conflict-overwrite flow (the fresh mtime
   *  the refusal carried -- resend-with-fresh-mtime lands, pinned
   *  server-side). */
  baseMtimeMs: number;
  saving: boolean;
}

export const cmpPos = (a: Pos, b: Pos): number => a.line - b.line || a.col - b.col;

export function clampPos(lines: string[], p: Pos): Pos {
  const line = Math.max(0, Math.min(p.line, lines.length - 1));
  let col = Math.max(0, Math.min(p.col, lines[line]!.length));
  // A caret never sits INSIDE a surrogate pair (a hit-test round-trip can
  // land between the halves): snap back to the pair's start, so deletes and
  // the paint layer only ever see whole characters.
  const text = lines[line]!;
  if (col > 0 && col < text.length && isHighSurrogate(text.charCodeAt(col - 1)) && isLowSurrogate(text.charCodeAt(col))) col -= 1;
  return { line, col };
}

const eqPos = (a: Pos, b: Pos): boolean => a.line === b.line && a.col === b.col;

/** Sort the selection list by head (document order) and reseat the primary
 *  index onto the range that carried it. */
function sortSels(sels: SelRange[], primary: number): { sels: SelRange[]; primary: number } {
  const marked = sels.map((s, i) => ({ s, i }));
  marked.sort((a, b) => cmpPos(a.s.head, b.s.head));
  return {
    sels: marked.map((m) => m.s),
    primary: marked.findIndex((m) => m.i === primary),
  };
}

// ── Content <-> buffer ───────────────────────────────────────────────────────

/** Build an editable buffer from FULLY LOADED file content (terminators
 *  intact, exactly as the last readFile page ended it). */
export function bufferFromContent(content: string): TextBuffer {
  let lines: string[];
  let endsNL = false;
  if (content === "") {
    lines = [""];
  } else {
    const parts = content.split("\n");
    if (parts[parts.length - 1] === "") {
      parts.pop();
      endsNL = true;
    }
    lines = parts;
  }
  const caret: SelRange = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } };
  const baseline = joinContent(lines, endsNL);
  return { lines, endsNL, baseline, sels: [caret], primary: 0, undo: [], redo: [], dirty: false };
}

/** The one serializer: lines + endsNL -> the exact bytes a save ships. */
const joinContent = (lines: string[], endsNL: boolean): string =>
  lines.join("\n") + (endsNL ? "\n" : "");

/** HOT EXIT overlay: the buffer's content is PRESERVED (stashed) text while
 *  the baseline stays the current DISK text, so the dirty flag rides the
 *  usual content-derived rule -- text that re-serializes equal to disk reads
 *  CLEAN (nothing to keep), anything else reads dirty and the save gate sees
 *  the real bytes. */
export function bufferFromStash(stashText: string, diskContent: string): TextBuffer {
  const buf = bufferFromContent(stashText);
  const dirty = buf.baseline !== diskContent;
  return dirty ? { ...buf, baseline: diskContent, dirty } : buf;
}

/** The exact bytes to save. */
export function contentOf(buf: TextBuffer): string {
  return joinContent(buf.lines, buf.endsNL);
}

/** Content-based dirty: serialization vs the baseline. Cheap guards first
 *  (total char count -- a typed/deleted char changes it, line count rides
 *  along -- then the full compare); the worst case is one join per commit
 *  on a buffer already bounded by EDIT_CHAR_CAP. */
function isDirty(buf: TextBuffer): boolean {
  if (contentChars(buf.lines) + (buf.endsNL ? 1 : 0) !== buf.baseline.length) return true;
  return contentOf(buf) !== buf.baseline;
}

/** Attach the derived flag to a mutation's fresh state (the undo/redo stacks
 *  survive the clean transition untouched -- only the flag outcome moves). */
const stampDirty = (buf: TextBuffer): TextBuffer => {
  const dirty = isDirty(buf);
  return buf.dirty === dirty ? buf : { ...buf, dirty };
};

/** Total chars the loaded lines occupy INCLUDING their line breaks (the
 *  unit the read cap counts). An empty entry list (never loaded) is 0. */
export function contentChars(lines: string[]): number {
  if (lines.length === 0) return 0;
  let n = lines.length - 1;
  for (const line of lines) n += line.length;
  return n;
}

export function primarySel(buf: TextBuffer): SelRange {
  return buf.sels[buf.primary] ?? buf.sels[0]!;
}

/** Text covered by one range (multi-line joins with \n). */
export function selText(buf: TextBuffer, range: SelRange): string {
  const a = clampPos(buf.lines, range.anchor);
  const b = clampPos(buf.lines, range.head);
  const [from, to] = cmpPos(a, b) <= 0 ? [a, b] : [b, a];
  if (from.line === to.line) return buf.lines[from.line]!.slice(from.col, to.col);
  const parts = [buf.lines[from.line]!.slice(from.col)];
  for (let i = from.line + 1; i < to.line; i++) parts.push(buf.lines[i]!);
  parts.push(buf.lines[to.line]!.slice(0, to.col));
  return parts.join("\n");
}

/** Text of every range, for the clipboard (ranges join with \n -- the
 *  multicaret clipboard contract). */
export function allSelText(buf: TextBuffer): string {
  const texts = buf.sels
    .filter((r) => cmpPos(r.anchor, r.head) !== 0)
    .map((r) => selText(buf, r));
  return texts.join("\n");
}

const hasSelection = (r: SelRange): boolean => !eqPos(r.anchor, r.head);

// ── Edit application (the one primitive) ────────────────────────────────────

/** Apply `edit` (coordinates against `lines`) to a COPY of lines and return
 *  { lines, entries } -- entries holds the actual applied edit plus its
 *  inverse (valid in the post state). Batching multi-range edits means
 *  calling this successively in DESCENDING position order: the not-yet-
 *  applied lower ranges keep their pre-state coordinates, and undo replays
 *  the recorded inverses in reverse, which walks the states back exactly. */
function applyEdit(lines: string[], from: Pos, to: Pos, insert: string): { lines: string[]; entry: TxEntry } {
  const a = clampPos(lines, from);
  const b = clampPos(lines, to);
  const [lo, hi] = cmpPos(a, b) <= 0 ? [a, b] : [b, a];
  const removed = sliceSpan(lines, lo, hi);
  const next = [...lines];
  const insLines = insert.split("\n");
  let insEnd: Pos;
  if (insLines.length === 1) {
    // Even a SINGLE-line insert can span lines: the whole [lo, hi] range
    // collapses, so everything between the endpoint lines must go too
    // (otherwise a Ctrl+A-and-type or a line-joining backspace leaves the
    // tail lines stranded beneath the joined one).
    const tail = next[hi.line]!.slice(hi.col);
    if (hi.line > lo.line) next.splice(lo.line + 1, hi.line - lo.line);
    next[lo.line] = next[lo.line]!.slice(0, lo.col) + insLines[0] + tail;
    insEnd = { line: lo.line, col: lo.col + insLines[0]!.length };
  } else {
    const head = next[lo.line]!.slice(0, lo.col);
    const tail = next[hi.line]!.slice(hi.col);
    const middle = insLines.slice(1, -1);
    const last = insLines[insLines.length - 1]!;
    next.splice(lo.line, hi.line - lo.line + 1, head + insLines[0]!, ...middle, last + tail);
    insEnd = { line: lo.line + insLines.length - 1, col: last.length };
  }
  return {
    lines: next,
    entry: {
      edit: { from: lo, to: hi, insert, removed },
      inverse: { from: lo, to: insEnd, insert: removed, removed: insert },
    },
  };
}

function sliceSpan(lines: string[], from: Pos, to: Pos): string {
  if (from.line === to.line) return lines[from.line]!.slice(from.col, to.col);
  const parts = [lines[from.line]!.slice(from.col)];
  for (let i = from.line + 1; i < to.line; i++) parts.push(lines[i]!);
  parts.push(lines[to.line]!.slice(0, to.col));
  return parts.join("\n");
}

/** Remap a point that sits STRICTLY RIGHT of an applied edit through it.
 *  Multi-range transactions apply DESCENDING: every caret recorded before
 *  the current (lower) edit was computed while that edit's lines were still
 *  ahead of it, so it must follow the edit's geometry or it goes stale --
 *  this is what keeps the caret list correct across multi-caret Enter /
 *  same-line backspaces. Positions at or left of the edit's end are inert
 *  (ranges never overlap after the collapse). */
function shiftPastEdit(p: Pos, entry: TxEntry): Pos {
  const { from, to, insert } = entry.edit;
  if (cmpPos(p, to) <= 0) return p;
  const insLines = insert.split("\n");
  if (p.line > to.line) {
    return { line: p.line + (insLines.length - 1) - (to.line - from.line), col: p.col };
  }
  // Same line as `to`, strictly right of it: the span's tail rides at the
  // END of the replacement (after `head + ins` on one line, after `last`
  // when the insert spans lines).
  return {
    line: from.line + insLines.length - 1,
    col: (insLines.length === 1 ? from.col : 0) + insLines[insLines.length - 1]!.length + (p.col - to.col),
  };
}

const remapSel = (r: SelRange, entry: TxEntry): SelRange => ({
  anchor: shiftPastEdit(r.anchor, entry),
  head: shiftPastEdit(r.head, entry),
});

// ── The transaction seam ─────────────────────────────────────────────────────

export interface TxOptions {
  kind: "typing" | "block";
  /** Epoch ms (injected: the UI passes Date.now(), tests control the clock). */
  time: number;
}

/**
 * Apply one transaction: replace every selection range with its per-range
 * edit (the `insertFor` callback sees each range and the state built SO FAR
 * -- edits apply highest-position-first, so an Enter's auto-indent can read
 * the still-untouched line under the caret), then record the step (merging
 * it into the open typing step when the coalescing rules agree).
 */
export function performTx(
  buf: TextBuffer,
  insertFor: (range: SelRange) => string,
  selsAfter: (entry: TxEntry, range: SelRange) => SelRange,
  opts: TxOptions,
): TextBuffer {
  const ordered = [...buf.sels].sort((x, y) => cmpPos(normFrom(x), normFrom(y)));
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const after: SelRange[] = new Array(ordered.length);
  const recorded: number[] = []; // indices of `after` entries already filled
  let primaryAfter = 0;
  // Descending application: see applyEdit's contract.
  for (let i = ordered.length - 1; i >= 0; i--) {
    const range = ordered[i]!;
    const { lines: next, entry } = applyEdit(lines, normFrom(range), normTo(range), insertFor(range));
    lines = next;
    // Carets recorded earlier belong to HIGHER ranges: follow this edit.
    for (const j of recorded) after[j] = remapSel(after[j]!, entry);
    entries.push(entry);
    after[i] = selsAfter(entry, range);
    recorded.push(i);
    const wasPrimary = buf.sels.indexOf(range) === buf.primary;
    if (wasPrimary) primaryAfter = i;
  }
  if (entries.length === 0) return buf;
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter: after,
    primaryAfter,
    kind: opts.kind,
    time: opts.time,
  };
  const { sels: sorted, primary } = sortSels(after, primaryAfter);
  const undo = mergeUndoStep(buf.undo, step);
  return stampDirty({ ...buf, lines, sels: sorted, primary, undo, redo: [] });
}

const normFrom = (r: SelRange): Pos => (cmpPos(r.anchor, r.head) <= 0 ? r.anchor : r.head);
const normTo = (r: SelRange): Pos => (cmpPos(r.anchor, r.head) <= 0 ? r.head : r.anchor);

/** Caret after an insert: anchor AND head at the end of what was inserted.
 *  Leaving the anchor at the pre-edit position would make the next
 *  keystroke REPLACE the range it just wrote (the first character eats the
 *  second) -- a caret is always anchor == head. */
export const caretAfterEdit = (entry: TxEntry): SelRange => ({
  anchor: entry.inverse.to,
  head: entry.inverse.to,
});

/** Typing runs merge into word/timeout-bounded steps: both steps typing,
 *  the clock within COALESCE_MS, nothing whitespace in either (a typed or
 *  deleted space/punct BOUNDS the run -- the word boundary), and no
 *  insert/delete polarity flip. Everything else (Enter, Tab, dedent, paste,
 *  IME commit) is its own block step. */
function mergeUndoStep(undo: UndoStep[], step: UndoStep): UndoStep[] {
  const prev = undo[undo.length - 1];
  if (prev && canMerge(prev, step)) {
    return [...undo.slice(0, -1), { ...step, entries: [...prev.entries, ...step.entries], selsBefore: prev.selsBefore, primaryBefore: prev.primaryBefore }];
  }
  return [...undo, step];
}

function canMerge(prev: UndoStep, step: UndoStep): boolean {
  if (prev.kind !== "typing" || step.kind !== "typing") return false;
  if (step.time - prev.time > COALESCE_MS) return false;
  if (!samePolarity(prev, step)) return false;
  return !touchesBoundary(prev) && !touchesBoundary(step);
}

const isDelete = (e: TxEntry): boolean => e.edit.insert === "";

function samePolarity(prev: UndoStep, step: UndoStep): boolean {
  const prevDel = isDelete(prev.entries[prev.entries.length - 1]!);
  const curDel = isDelete(step.entries[step.entries.length - 1]!);
  return prevDel === curDel;
}

/** Whitespace on either side of a step's text closes the coalescing run. */
function touchesBoundary(step: UndoStep): boolean {
  return step.entries.some(
    (e) => /\s/.test(e.edit.insert) || /\s/.test(e.inverse.insert),
  );
}

// ── The editing operations (all through performTx) ──────────────────────────

/** Insert `text` at every selection (replacing it). Single chars ride the
 *  "typing" kind so they coalesce; multi-char text (paste, IME commit) is a
 *  block step of its own. */
export function insertText(buf: TextBuffer, text: string, opts: TxOptions): TextBuffer {
  const kind: TxOptions["kind"] = text.length === 1 ? "typing" : "block";
  return performTx(buf, () => text, caretAfterEdit, { ...opts, kind });
}

/** Enter: newline + the current line's leading whitespace (auto-indent). */
export function pressEnter(buf: TextBuffer, time: number): TextBuffer {
  return performTx(
    buf,
    (range) => "\n" + leadingWs(buf.lines[clampPos(buf.lines, normFrom(range)).line]!),
    caretAfterEdit,
    { kind: "block", time },
  );
}

/** Tab: insert spaces up to the next TAB_STOP column (of the caret's
 *  VISUAL position, so a file with real tabs indents by stops too). */
export function indentTab(buf: TextBuffer, time: number): TextBuffer {
  return performTx(
    buf,
    (range) => {
      const p = clampPos(buf.lines, normFrom(range));
      const pad = TAB_STOP - (visualCol(buf.lines[p.line]!, p.col) % TAB_STOP);
      return " ".repeat(pad);
    },
    caretAfterEdit,
    { kind: "typing", time },
  );
}

/** Shift+Tab: dedent every line the PRIMARY selection touches, by at least
 *  back to the previous tab stop (a 2-space line dedents to 0 -- the 4-step
 *  is a MINIMUM, there is no config key). Carets shift left by what their
 *  own line lost. */
export function dedentLines(buf: TextBuffer, time: number): TextBuffer {
  const range = primarySel(buf);
  const a = clampPos(buf.lines, normFrom(range));
  const b = clampPos(buf.lines, normTo(range));
  const strips = new Map<number, number>();
  for (let i = a.line; i <= b.line; i++) {
    const n = dedentChars(buf.lines[i]!);
    if (n > 0) strips.set(i, n);
  }
  if (strips.size === 0) return buf;
  // One edit per affected line (highest first via the map walk order -- the
  // edits are disjoint and single-line, so a plain descending loop applies
  // them cleanly outside the selection mechanism).
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const touched = [...strips.keys()].sort((x, y) => y - x);
  for (const line of touched) {
    const n = strips.get(line)!;
    const { lines: next, entry } = applyEdit(lines, { line, col: 0 }, { line, col: n }, "");
    lines = next;
    entries.push(entry);
  }
  const shift = (p: Pos): Pos =>
    p.line >= a.line && p.line <= b.line && strips.has(p.line)
      ? { line: p.line, col: Math.max(0, p.col - strips.get(p.line)!) }
      : p;
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter: buf.sels.map((r) => ({ anchor: shift(r.anchor), head: shift(r.head) })),
    primaryAfter: buf.primary,
    kind: "block",
    time,
  };
  return stampDirty({ ...buf, lines, sels: step.selsAfter, undo: [...buf.undo, step], redo: [] });
}

/** Leading whitespace of a line. */
export const leadingWs = (line: string): string => /^[ \t]*/.exec(line)![0]!;

/** How many leading whitespace characters Shift+Tab strips: back to the
 *  previous tab stop (tabs are indivisible -- a whole tab goes). */
export function dedentChars(line: string): number {
  const ws = leadingWs(line);
  if (ws === "") return 0;
  const cells = visualCol(ws, ws.length);
  const target = cells % TAB_STOP === 0 ? TAB_STOP : cells % TAB_STOP;
  let removedCells = 0;
  let chars = 0;
  for (const ch of ws) {
    removedCells += ch === "\t" ? TAB_STOP - (removedCells % TAB_STOP) : 1;
    chars++;
    if (removedCells >= target) break;
  }
  return chars;
}

/** Backspace: with a selection, delete it; otherwise merge with the previous
 *  line at column 0, else delete the code point left of the caret (a
 *  surrogate pair goes whole -- half a pair is not a character). */
export function backspace(buf: TextBuffer, time: number): TextBuffer {
  if (buf.sels.some(hasSelection)) {
    return performTx(buf, () => "", (entry) => ({ anchor: entry.edit.from, head: entry.edit.from }), { kind: "typing", time });
  }
  const edits = buf.sels.map((r) => ({ ...r, head: backDelta(buf.lines, r.head) }));
  return applyCaretDeletes(buf, edits, time);
}

/** Delete key: selection first, else the code point right of the caret
 *  (surrogate-aware), else merge the next line up. */
export function deleteForward(buf: TextBuffer, time: number): TextBuffer {
  if (buf.sels.some(hasSelection)) {
    return performTx(buf, () => "", (entry) => ({ anchor: entry.edit.from, head: entry.edit.from }), { kind: "typing", time });
  }
  const edits = buf.sels.map((r) => ({ ...r, head: fwdDelta(buf.lines, r.head) }));
  return applyCaretDeletes(buf, edits, time);
}

function applyCaretDeletes(
  buf: TextBuffer,
  edits: SelRange[],
  time: number,
  kind: "typing" | "block" = "typing",
): TextBuffer {
  let changed = false;
  for (let i = 0; i < buf.sels.length; i++) {
    if (!eqPos(edits[i]!.head, buf.sels[i]!.head)) changed = true;
  }
  if (!changed) return buf; // dead Backspace at (0,0): no step, no dirty
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const selsAfter: SelRange[] = new Array(edits.length);
  const recorded: number[] = [];
  // Descending application keeps the lower ranges' coordinates valid.
  const ordered = edits
    .map((r, i) => ({ r, i }))
    .sort((x, y) => cmpPos(y.r.anchor, x.r.anchor));
  for (const { r, i } of ordered) {
    const { lines: next, entry } = applyEdit(lines, normFrom(r), normTo(r), "");
    lines = next;
    for (const j of recorded) selsAfter[j] = remapSel(selsAfter[j]!, entry);
    entries.push(entry);
    selsAfter[i] = { anchor: entry.edit.from, head: entry.edit.from };
    recorded.push(i);
  }
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter,
    primaryAfter: buf.primary,
    kind,
    time,
  };
  return stampDirty({ ...buf, lines, sels: selsAfter, primary: buf.primary, undo: mergeUndoStep(buf.undo, step), redo: [] });
}

/** The code point boundary LEFT of p (surrogate pair counted whole). */
function backDelta(lines: string[], head: Pos): Pos {
  const p = clampPos(lines, head);
  if (p.col > 0) {
    const line = lines[p.line]!;
    const isPair = p.col >= 2 && isLowSurrogate(line.charCodeAt(p.col - 1)) && isHighSurrogate(line.charCodeAt(p.col - 2));
    return { line: p.line, col: p.col - (isPair ? 2 : 1) };
  }
  return p.line > 0 ? { line: p.line - 1, col: lines[p.line - 1]!.length } : p;
}

/** The code boundary RIGHT of p: next code point, or the whole next line at
 *  end-of-line (the merge). */
function fwdDelta(lines: string[], head: Pos): Pos {
  const p = clampPos(lines, head);
  const line = lines[p.line]!;
  if (p.col < line.length) {
    const isPair = isHighSurrogate(line.charCodeAt(p.col)) && isLowSurrogate(line.charCodeAt(p.col + 1));
    return { line: p.line, col: p.col + (isPair ? 2 : 1) };
  }
  return p.line < lines.length - 1 ? { line: p.line + 1, col: 0 } : p;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

// ── Caret / selection ops (not undoable: selection moves stay out of the
//    history) ─────────────────────────────────────────────────────────────────

/** Place the caret (click, arrow without shift). The list collapses to the
 *  single range -- which is also the standard "plain arrow after a
 *  multi-selection keeps the primary only" collapse the arrow keys ride. */
export function setCaret(buf: TextBuffer, target: Pos): TextBuffer {
  const p = clampPos(buf.lines, target);
  const caret: SelRange = { anchor: p, head: p };
  return { ...buf, sels: [caret], primary: 0 };
}

/** One range selection (the find-match select, anything that must paint a
 *  span rather than a caret): the list collapses to the single range,
 *  anchor at `from`, head at `to` (direction preserved for shift-extend). */
export function selectRange(buf: TextBuffer, from: Pos, to: Pos): TextBuffer {
  return { ...buf, sels: [{ anchor: clampPos(buf.lines, from), head: clampPos(buf.lines, to) }], primary: 0 };
}

/** Shift-arrow / shift-click / drag: extend (or start) the PRIMARY range. */
export function extendPrimary(buf: TextBuffer, target: Pos): TextBuffer {
  const p = clampPos(buf.lines, target);
  const sels = [...buf.sels];
  const cur = sels[buf.primary] ?? sels[0]!;
  sels[buf.primary] = { anchor: cur.anchor, head: p };
  return { ...buf, sels };
}

/** Escape: VS Code's "collapse every cursor to the primary" -- all ranges
 *  AND secondary carets drop; one caret remains at the primary head. */
export function collapseSelections(buf: TextBuffer): TextBuffer {
  const p = clampPos(buf.lines, primarySel(buf).head);
  return { ...buf, sels: [{ anchor: p, head: p }], primary: 0 };
}

// ── Multi-caret (VS Code semantics) ─────────────────────────────────────────
// The caret list stays SORTED in document order (by head; ties by anchor)
// with exactly one `primary`. Every collapse below is the shipped rule:
//   - duplicate ranges (same anchor+head) collapse to one;
//   - a range whose entire span sits inside another range's span is dropped
//     (the bigger range owns the area);
//   - a caret that lands on another caret collapses to it (one entry).
// The primary follows the range the user acted on (the added/removed index);
// when the primary's entry disappears it falls back to the nearest surviving
// index, so the list is never empty and primary is always in range.

/** Sort by document order and collapse overlapping/duplicate spans (interval
 *  merge): the walk keeps the earlier-starting span and extends it to the
 *  later end; a merged range normalizes to left-to-right. A range fully
 *  inside another just disappears, and a caret landing on another caret (or
 *  on the end of the range covering its line) dedupes the same way.
 *  Returns the new list plus the index the `want` entry landed at. */
export function collapseSels(sels: SelRange[], want?: SelRange): { sels: SelRange[]; primary: number } {
  const sorted = [...sels].sort((a, b) => cmpPos(normFrom(a), normFrom(b)) || cmpPos(normTo(b), normTo(a)));
  const out: { s: SelRange; has: boolean }[] = [];
  for (const r of sorted) {
    const rf = normFrom(r);
    const rt = normTo(r);
    const last = out[out.length - 1];
    // Two IDENTICAL zero-width carets merge (add-caret onto an existing
    // caret must not duplicate it and type twice at the shared point). A
    // caret merely touching a RANGE's end still stays its own caret -- VS
    // Code keeps adjacent-but-distinct cursors distinct.
    const identicalCaret =
      last !== undefined &&
      eqPos(rf, rt) &&
      eqPos(normFrom(last.s), normTo(last.s)) &&
      eqPos(rf, normFrom(last.s));
    if (last && (cmpPos(rf, normTo(last.s)) < 0 || identicalCaret)) {
      if (cmpPos(rt, normTo(last.s)) > 0) last.s = { anchor: normFrom(last.s), head: rt };
      if (r === want) last.has = true;
      continue;
    }
    out.push({ s: r, has: r === want });
  }
  let primary = out.findIndex((o) => o.has);
  if (primary < 0) primary = 0;
  return { sels: out.map((o) => o.s), primary };
}

/** Alt+click. The shipped point rule (documented, deliberately not VS Code's
 *  selection-aware remap): the CLICK POINT is the truth --
 *   - clicking an existing caret (anchor == head == point) REMOVES it;
 *   - clicking inside an existing selection range REMOVES that range too
 *     (the click point replaces whatever cursor lived there);
 *   - otherwise a caret is ADDED at the point.
 *  The new/surviving caret at the click point becomes the primary; the last
 *  remaining caret can never be removed. */
export function altClickCaret(buf: TextBuffer, target: Pos): TextBuffer {
  const p = clampPos(buf.lines, target);
  const inside = (r: SelRange): boolean =>
    cmpPos(normFrom(r), p) <= 0 && cmpPos(p, normTo(r)) <= 0;
  const onCaret = (r: SelRange): boolean => eqPos(r.anchor, p) && eqPos(r.head, p);
  const on = buf.sels.some(onCaret);
  const hit = on || buf.sels.some(inside);
  if (buf.sels.length === 1 && hit) return buf; // never remove the last caret
  const kept = buf.sels.filter((r) => !onCaret(r) && !inside(r));
  // CLICKING AN EXISTENT CARET removes it and adds nothing back (VS Code).
  if (on) return { ...buf, ...collapseSels(kept.length > 0 ? kept : [{ anchor: p, head: p }]) };
  const caret: SelRange = { anchor: p, head: p };
  return { ...buf, ...collapseSels([...kept, caret], caret) };
}

/** Ctrl+Shift+Alt+ArrowDown/Up: add a caret on the next/previous line at the
 *  SAME column (clamped to that line's length -- VS Code clamps, never pads).
 *  Running off the buffer (no such line) stops honestly: buffer unchanged.
 *  The new caret becomes primary; a caret already there just becomes primary
 *  (the collapse dedupes), so repeated presses walk downward through it. */
export function addCaretVertical(buf: TextBuffer, dLine: number): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  const line = head.line + dLine;
  if (line < 0 || line >= buf.lines.length) return buf;
  const p = clampPos(buf.lines, { line, col: head.col });
  const caret: SelRange = { anchor: p, head: p };
  return { ...buf, ...collapseSels([...buf.sels, caret], caret) };
}

/** Alt+Shift+drag BOX (column) selection. `a`/`b` carry a LINE plus a VISUAL
 *  column (pixel/cw, what the drag's x means); every line between a.line and
 *  b.line gets its own range between the two visual columns converted to
 *  that line's code columns. Short lines CLAMP to their own length (the
 *  VS Code clamping -- the box never pads with spaces; typing lands at each
 *  line's clamped column instead). Direction: anchor on the a-side, head on
 *  the b-side; a zero-width box is a caret per line riding the b-side.
 *  Primary is the b.line row. */
export function boxSelect(buf: TextBuffer, a: { line: number; vcol: number }, b: { line: number; vcol: number }): TextBuffer {
  const lo = Math.max(0, Math.min(a.line, b.line, buf.lines.length - 1));
  const hi = Math.min(buf.lines.length - 1, Math.max(a.line, b.line));
  const sels: SelRange[] = [];
  let want: SelRange | undefined;
  for (let l = lo; l <= hi; l++) {
    const ca = colAtVisual(buf.lines[l]!, Math.max(0, a.vcol));
    const cb = colAtVisual(buf.lines[l]!, Math.max(0, b.vcol));
    // Anchor on the a-side, head on the b-side for BOTH directions: the
    // head follows the mouse wherever the box is dragged.
    const r: SelRange = { anchor: { line: l, col: ca }, head: { line: l, col: cb } };
    if (l === b.line) want = r;
    sels.push(r);
  }
  return { ...buf, ...collapseSels(sels, want) };
}

/** Ctrl+A -- bounded to the editor's own content (it never reaches the
 *  page; this is the whole buffer). A single all-covering range: the list
 *  stays a list. */
export function selectAll(buf: TextBuffer): TextBuffer {
  const last = buf.lines.length - 1;
  const range: SelRange = { anchor: { line: 0, col: 0 }, head: { line: last, col: buf.lines[last]!.length } };
  return { ...buf, sels: [range], primary: 0 };
}

/** Double-click word bounds: word chars if the point touches one, else a
 *  whitespace run, else a punctuation run (the three-way VS Code split,
 *  minus its config knobs). */
export function wordRange(line: string, col: number): SelRange | null {
  const c = Math.max(0, Math.min(col, line.length));
  const at = c < line.length ? line[c]! : line[c - 1];
  if (at === undefined) return null;
  // Three disjoint classes: word chars, whitespace, PUNCTUATION (non-word
  // AND non-space) -- NOT /\W/ (which is "not a word char" and so swallows
  // the spaces a punctuation run should stop at).
  const cls = /\w/.test(at) ? /^\w/ : /\s/.test(at) ? /^\s/ : /[^\w\s]/;
  let from = c < line.length ? c : c - 1;
  let to = from + 1;
  while (from > 0 && cls.test(line[from - 1]!)) from--;
  while (to < line.length && cls.test(line[to]!)) to++;
  return { anchor: { line: 0, col: from }, head: { line: 0, col: to } };
}

export function selectWordAt(buf: TextBuffer, target: Pos): TextBuffer {
  const p = clampPos(buf.lines, target);
  const w = wordRange(buf.lines[p.line]!, p.col);
  if (!w) return setCaret(buf, p);
  const range: SelRange = {
    anchor: { line: p.line, col: w.anchor.col },
    head: { line: p.line, col: w.head.col },
  };
  return { ...buf, sels: [range], primary: 0 };
}

/** Horizontal caret move with line wrap (Left at 0 steps to the previous
 *  line's end; Right at EOL steps to the next line's start). */
export function moveHorizontal(buf: TextBuffer, dir: -1 | 1, extend: boolean): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  let target: Pos;
  if (dir === -1) target = head.col > 0 ? { line: head.line, col: backDelta(buf.lines, head).col } : head.line > 0 ? { line: head.line - 1, col: buf.lines[head.line - 1]!.length } : head;
  else target = head.col < buf.lines[head.line]!.length ? { line: head.line, col: fwdDelta(buf.lines, head).col } : head.line < buf.lines.length - 1 ? { line: head.line + 1, col: 0 } : head;
  return extend ? extendPrimary(buf, target) : setCaret(buf, target);
}

/** Vertical caret move: the column travels, clamped to the target line. */
export function moveVertical(buf: TextBuffer, dLine: number, extend: boolean): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  return extend
    ? extendPrimary(buf, { line: head.line + dLine, col: head.col })
    : setCaret(buf, { line: head.line + dLine, col: head.col });
}

/** Smart Home, cycling by position alone (no extra state): from mid-line to
 *  the first non-whitespace column, from there to column 0, and from column
 *  0 back to the indent's end -- every press moves unless the line has no
 *  indent at all. */
export function smartHome(buf: TextBuffer, extend: boolean): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  const firstWs = leadingWs(buf.lines[head.line]!).length;
  const target =
    head.col === 0
      ? { line: head.line, col: firstWs }
      : head.col > firstWs
        ? { line: head.line, col: firstWs }
        : { line: head.line, col: 0 };
  return extend ? extendPrimary(buf, target) : setCaret(buf, target);
}

export const smartEnd = (buf: TextBuffer, extend: boolean): TextBuffer => {
  const head = clampPos(buf.lines, primarySel(buf).head);
  const target = { line: head.line, col: buf.lines[head.line]!.length };
  return extend ? extendPrimary(buf, target) : setCaret(buf, target);
};

export const docStart = (buf: TextBuffer, extend: boolean): TextBuffer =>
  extend ? extendPrimary(buf, { line: 0, col: 0 }) : setCaret(buf, { line: 0, col: 0 });

export const docEnd = (buf: TextBuffer, extend: boolean): TextBuffer => {
  const last = buf.lines.length - 1;
  const target = { line: last, col: buf.lines[last]!.length };
  return extend ? extendPrimary(buf, target) : setCaret(buf, target);
};

// ── Undo / redo ──────────────────────────────────────────────────────────────

export function undo(buf: TextBuffer): TextBuffer {
  const step = buf.undo[buf.undo.length - 1];
  if (!step) return buf;
  let lines = buf.lines;
  for (let i = step.entries.length - 1; i >= 0; i--) {
    const inv = step.entries[i]!.inverse;
    lines = applyEdit(lines, inv.from, inv.to, inv.insert).lines;
  }
  return stampDirty({
    ...buf,
    lines,
    sels: step.selsBefore,
    primary: step.primaryBefore,
    undo: buf.undo.slice(0, -1),
    redo: [...buf.redo, step],
  });
}

export function redo(buf: TextBuffer): TextBuffer {
  const step = buf.redo[buf.redo.length - 1];
  if (!step) return buf;
  let lines = buf.lines;
  for (const entry of step.entries) {
    lines = applyEdit(lines, entry.edit.from, entry.edit.to, entry.edit.insert).lines;
  }
  return stampDirty({
    ...buf,
    lines,
    sels: step.selsAfter,
    primary: step.primaryAfter,
    undo: [...buf.undo, step],
    redo: buf.redo.slice(0, -1),
  });
}

/** Save landed: the buffer's content IS the file again -- the baseline
 *  moves to the current serialization and the derived flag goes clean. */
export function markSaved(buf: TextBuffer): TextBuffer {
  const baseline = contentOf(buf);
  return buf.baseline === baseline && !buf.dirty
    ? buf
    : { ...buf, baseline, dirty: false };
}

// ── Visual columns (hit-testing + caret/selection geometry) ─────────────────
// Buffer columns count CODE UNITS; the rendered layer expands a tab to its
// stop, so pixel math lives in VISUAL columns. The two worlds convert
// through these helpers and nowhere else.

/** Cells the line's text occupies up to code-unit `col`. */
export function visualCol(line: string, col: number, tabStop = TAB_STOP): number {
  let v = 0;
  const n = Math.min(col, line.length);
  for (let i = 0; i < n; i++) {
    v += line[i] === "\t" ? tabStop - (v % tabStop) : 1;
  }
  return v;
}

/** Code-unit column at visual cell `target` (clamped to the line): a click
 *  inside a tab's span lands on the tab itself. */
export function colAtVisual(line: string, target: number, tabStop = TAB_STOP): number {
  let v = 0;
  for (let i = 0; i < line.length; i++) {
    const adv = line[i] === "\t" ? tabStop - (v % tabStop) : 1;
    if (v + adv > target) return i;
    v += adv;
  }
  return line.length;
}

/** The ONE column<->x mapping, used by BOTH the click hit-test AND the
 *  caret/selection paint so the two can never diverge. `x` is a distance from
 *  the code element's origin; the caret is painted at `xForCol(...)` INSIDE
 *  that same (horizontally scrollable) element, so a click and the caret it
 *  lands on ride one number and one `cw`. Horizontal scroll carries both with
 *  the element's live rect, so there is no separate scrollLeft term to drift.
 *  Rounding in on the way back makes them exact inverses: for any column c
 *  within the line, colForX(line, xForCol(line, c, cw), cw) === c. */
export const xForCol = (line: string, col: number, cw: number): number => visualCol(line, col) * cw;
export const colForX = (line: string, x: number, cw: number): number =>
  colAtVisual(line, Math.max(0, Math.round(x / cw)));

/** Click -> position: row = y / lineH, column = round(x / charW) converted
 *  through the visual scale. charW/lineH come from the render layer's one
 *  measurement (with a deterministic fallback, so tests hit-test too). */
export function hitPos(
  lines: string[],
  metrics: { charW: number; lineH: number },
  x: number,
  y: number,
  firstRenderedLine: number,
): Pos {
  const line = Math.max(0, Math.min(firstRenderedLine + Math.floor(y / metrics.lineH), lines.length - 1));
  const target = Math.max(0, Math.round(x / metrics.charW));
  return clampPos(lines, { line, col: colAtVisual(lines[line]!, target) });
}

// ── The save/dirty state machine ─────────────────────────────────────────────
// States per path: clean (buffer == baseline, baseMtimeMs == file mtime) ->
// dirty (a commit whose serialization differs from the baseline -- same-
// bytes edits and undos back to the baseline stay clean; the tab dot rides
// buffer.dirty) -> saving (exactly one saveFile in flight, baseMtimeMs is
// what the frame carried) -> clean with the reply's NEW mtime and the
// baseline re-seeded. A conflict refusal returns to dirty (the derivation
// says so on its own: the text still differs from the baseline) and hands
// the app the fresh mtime: OVERWRITE = set base to it and resend (the
// server's pinned flow), RELOAD = discard the buffer and re-read. The app
// owns the dialogs; these functions own the transitions so the machine is
// testable without a DOM.

export type SaveOutcome =
  | { type: "saved"; mtimeMs: number }
  | { type: "conflict"; mtimeMs: number; error: string }
  | { type: "error"; error: string };

/** The reply for an in-flight save, folded into the session. Unknown shape
 *  (no mtime on success) rides 0 -- the next save then carries 0 and the
 *  conflict gate (any real mtime beats 0) honestly refuses rather than
 *  clobbering; the reload-vs-overwrite dialog is the recovery. */
export function applySaveResult(session: EditorSession, result: FileOpResultWire): { session: EditorSession; outcome: SaveOutcome } {
  if (result.conflict) {
    return {
      session: { ...session, saving: false },
      outcome: { type: "conflict", mtimeMs: result.mtimeMs ?? 0, error: result.error ?? "the file changed on disk" },
    };
  }
  if (result.error !== undefined) {
    return { session: { ...session, saving: false }, outcome: { type: "error", error: result.error } };
  }
  const mtimeMs = result.mtimeMs ?? 0;
  return {
    session: { ...session, saving: false, baseMtimeMs: mtimeMs, buffer: markSaved(session.buffer) },
    outcome: { type: "saved", mtimeMs },
  };
}

/** The honest gate before a buffer dies with unsaved work (tab close, reload
 *  overwrite, a delete closing its tab). `ask` is the app's window.confirm;
 *  a clean buffer never asks. */
export function confirmDiscard(
  session: EditorSession,
  label: string,
  ask: (message: string) => boolean,
): boolean {
  if (!session.buffer.dirty) return true;
  return ask(`Close ${label}? You have unsaved changes that will be lost.`);
}

// ── Brace matching while typing (VS Code-style, the shipped ruleset) ───────
// The matrix (pinned by tests):
//
//   OPENERS ( [ {   auto-close when the char RIGHT of the caret is empty
//                  (EOL), whitespace, or any closer `)]}"'`` -- VS Code's
//                  auto-close condition.
//   QUOTES " ' `   auto-close when the char right is empty/whitespace/closer
//                  AND the caret is NOT inside a word (word chars on BOTH
//                  sides = inside-word => plain insert: typing `"` in
//                  `foo|bar` must not pair).
//   CLOSERS ) ] }  typing one when the char right IS that closer moves the
//                  caret OVER it (no duplicate).
//   QUOTES         skip-over only when the same quote sits right AND the
//                  count of that quote char LEFT of the caret on the line is
//                  ODD -- odd means an open pair (exactly what we
//                  auto-inserted); even (closed string / prose) inserts.
//
// Everything applies PER CARET. performTx computes every edit against one
// shared pre-state descending, so carets never renumber each other.

const PAIR_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);
const QUOTES = new Set(['"', "'", "`"]);
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /\w/.test(ch);

/** What typing `ch` at empty-caret position `p` should do; undefined =
 *  plain insert. `over` = pure skip-over (no text change, caret walks one
 *  char right). `caretOffset` = caret lands this many code units INTO the
 *  inserted text (inside the pair). */
export interface TypeOutcome {
  insert: string;
  caretOffset?: number;
  over?: boolean;
}

export function braceTypeAt(lines: string[], p: Pos, ch: string): TypeOutcome | undefined {
  const line = lines[p.line] ?? "";
  const right = p.col < line.length ? line[p.col]! : undefined;
  // Skip-over outranks auto-close: `foo(|)` typing `)` walks out.
  if (right === ch && CLOSERS.has(ch)) {
    if (!QUOTES.has(ch)) return { insert: "", over: true };
    let n = 0;
    for (let i = 0; i < p.col; i++) if (line[i] === ch) n++;
    if (n % 2 === 1) return { insert: "", over: true };
  }
  const closer = PAIR_OF[ch];
  if (!closer) return undefined;
  const before = p.col > 0 ? line[p.col - 1]! : undefined;
  if (QUOTES.has(ch) && isWordChar(before) && isWordChar(right)) return undefined;
  if (!(right === undefined || /\s/.test(right) || CLOSERS.has(right))) return undefined;
  return { insert: ch + closer, caretOffset: 1 };
}

/** Type one character with the brace rules applied PER caret. Non-empty
 *  ranges plain-insert (replacing) -- auto-close is a caret-only
 *  affordance. A pure skip-over (every caret only walks over its closer) is
 *  a selection move: no text edit, no undo step, no dirty -- VS Code's
 *  overtype is not an undoable edit either. */
export function typeChar(buf: TextBuffer, ch: string, time: number): TextBuffer {
  const outcomes = buf.sels.map((r) =>
    cmpPos(r.anchor, r.head) === 0 ? braceTypeAt(buf.lines, clampPos(buf.lines, r.head), ch) : undefined,
  );
  if (outcomes.every((o) => o === undefined)) return insertText(buf, ch, { kind: "typing", time });
  if (outcomes.every((o) => o?.over === true)) {
    // Pure skip-over at EVERY caret: `undefined` means "plain insert", not
    // "skip" -- a plain caret must never swallow the keystroke when another
    // caret overtypes. This walk cannot mint a duplicate caret (every caret
    // advances exactly +1 on its own line); the MIXED path below CAN
    // collide (an over-walk can land where a replaced selection's caret
    // ends up), so its result goes through collapseSels.
    const sels = buf.sels.map((r, i) => {
      if (!outcomes[i]?.over) return r;
      const h = clampPos(buf.lines, r.head);
      const nxt = clampPos(buf.lines, { line: h.line, col: h.col + 1 });
      return { anchor: nxt, head: nxt };
    });
    return { ...buf, sels };
  }
  // Mixed: text edits apply descending; overtype carets just walk right.
  const ordered = buf.sels.map((r, i) => ({ r, i })).sort((x, y) => cmpPos(normTo(y.r), normTo(x.r)));
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const after: SelRange[] = new Array(buf.sels.length);
  const recorded: number[] = [];
  let primaryAfter = 0;
  for (const { r, i } of ordered) {
    const o = outcomes[i];
    if (o?.over) {
      const h = clampPos(buf.lines, normTo(r));
      const nxt = clampPos(buf.lines, { line: h.line, col: h.col + 1 });
      after[i] = { anchor: nxt, head: nxt };
      recorded.push(i);
      if (buf.sels.indexOf(r) === buf.primary) primaryAfter = i;
      continue;
    }
    const ins = o ? o.insert : ch;
    const { lines: next, entry } = applyEdit(lines, normFrom(r), normTo(r), ins);
    lines = next;
    // Carets recorded so far belong to higher ranges: they follow this edit.
    for (const j of recorded) after[j] = remapSel(after[j]!, entry);
    entries.push(entry);
    const p =
      o?.caretOffset !== undefined
        ? { line: entry.edit.from.line, col: entry.edit.from.col + o.caretOffset }
        : entry.inverse.to;
    after[i] = { anchor: p, head: p };
    recorded.push(i);
    if (buf.sels.indexOf(r) === buf.primary) primaryAfter = i;
  }
  // Every range became a zero-width caret; identical landings (an over-walk
  // onto a replaced selection's caret) collapse so the list keeps its
  // distinct-caret invariant.
  const collapsed = collapseSels(after, after[primaryAfter]);
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter: collapsed.sels,
    primaryAfter: collapsed.primary,
    kind: "typing",
    time,
  };
  return stampDirty({
    ...buf,
    lines,
    sels: collapsed.sels,
    primary: collapsed.primary,
    undo: mergeUndoStep(buf.undo, step),
    redo: [],
  });
}

/** Enter between an empty bracket pair `{|}`, `[|]`, `(|)`: THREE lines --
 *  the opener, the caret on a new line at the opener's indent + one tab
 *  stop, and the closer at the opener's indent. Quotes never expand (VS
 *  Code does not). Enter anywhere else keeps the plain newline + auto-indent;
 *  Enter before a closer WITH content is that same plain newline (no
 *  reindent engine -- stated ceiling, no gold-plating). */
export function pressEnterSmart(buf: TextBuffer, time: number): TextBuffer {
  const expandInsert = (range: SelRange): string | undefined => {
    if (cmpPos(range.anchor, range.head) !== 0) return undefined;
    const p = clampPos(buf.lines, range.head);
    const line = buf.lines[p.line]!;
    const l = line[p.col - 1];
    const r = line[p.col];
    if (l === undefined || r === undefined || QUOTES.has(l) || PAIR_OF[l] !== r) return undefined;
    const ws = leadingWs(line);
    const pad = TAB_STOP - (visualCol(ws, ws.length) % TAB_STOP);
    return `\n${ws}${" ".repeat(pad)}\n${ws}`;
  };
  if (buf.sels.every((r) => expandInsert(r) === undefined)) return pressEnter(buf, time);
  const midCol = (range: SelRange): number => {
    const ws = leadingWs(buf.lines[clampPos(buf.lines, normFrom(range)).line]!);
    return ws.length + TAB_STOP - (visualCol(ws, ws.length) % TAB_STOP);
  };
  return performTx(
    buf,
    (range) =>
      expandInsert(range) ?? `\n${leadingWs(buf.lines[clampPos(buf.lines, normFrom(range)).line]!)}`,
    (entry, range) => {
      if (expandInsert(range) === undefined) return caretAfterEdit(entry);
      const p = { line: entry.edit.from.line + 1, col: midCol(range) };
      return { anchor: p, head: p };
    },
    { kind: "block", time },
  );
}

/** Backspace with multi-caret awareness PLUS the empty-pair kill: a caret
 *  between an empty pair `{|}`, `[|]`, `(|)`, `"|"`, `'|`, `` `|` `` deletes
 *  BOTH halves. Anything else rides the plain per-caret backspace. All of it
 *  stays ONE typing undo step. */
export function backspaceSmart(buf: TextBuffer, time: number): TextBuffer {
  if (buf.sels.some(hasSelection)) return backspace(buf, time);
  const pairAt = (r: SelRange): boolean => {
    const p = clampPos(buf.lines, r.head);
    const line = buf.lines[p.line]!;
    const l = line[p.col - 1];
    const rt = line[p.col];
    return l !== undefined && rt !== undefined && PAIR_OF[l] === rt;
  };
  if (buf.sels.every((r) => !pairAt(r))) return backspace(buf, time);
  const ordered = buf.sels.map((r, i) => ({ r, i })).sort((x, y) => cmpPos(normTo(y.r), normTo(x.r)));
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const after: SelRange[] = new Array(buf.sels.length);
  const recorded: number[] = [];
  let primaryAfter = 0;
  for (const { r, i } of ordered) {
    const h = clampPos(buf.lines, r.head);
    const from = pairAt(r) ? { line: h.line, col: h.col - 1 } : backDelta(buf.lines, h);
    const to = pairAt(r) ? { line: h.line, col: h.col + 1 } : h;
    const { lines: next, entry } = applyEdit(lines, from, to, "");
    lines = next;
    // Higher carets recorded so far follow this delete (same-line shift).
    for (const j of recorded) after[j] = remapSel(after[j]!, entry);
    entries.push(entry);
    after[i] = { anchor: from, head: from };
    recorded.push(i);
    if (buf.sels.indexOf(r) === buf.primary) primaryAfter = i;
  }
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter: after,
    primaryAfter,
    kind: "typing",
    time,
  };
  return stampDirty({
    ...buf,
    lines,
    sels: after,
    primary: primaryAfter,
    undo: mergeUndoStep(buf.undo, step),
    redo: [],
  });
}

// ── Word-wise movement and delete (alt+Arrow / alt+Backspace|Delete) ───────
// VS Code-ish three-class walk, SHARED by movement and delete: each code
// point is an IDENTIFIER ([\p{L}\p{N}_], unicode -- the same class the find
// widget's whole-word filter uses, so CJK reads as one identifier run and
// surrogate pairs read whole), WHITESPACE, or PUNCTUATION (neither).
// Forward: consume the run AT the caret; if that run is whitespace, keep
// going into the next non-whitespace run (VS Code never stops mid-gap).
// Backward is the mirror. The line-crossing rule is the plain arrow's:
// Right at EOL -> next line col 0, Left at col 0 -> previous line's end;
// the buffer edge is a dead key (no move, no delete, no undo step).

type WordCls = 0 | 1 | 2; // 0 ws, 1 identifier, 2 punctuation
const WORD_CH = /[\p{L}\p{N}_]/u;

/** The class of the code point STARTING at column `i` (pair whole), and of
 *  the code point ENDING at column `i` -- movement only ever starts from a
 *  boundary, but a stray mid-pair column reads the whole pair anyway. */
const clsRight = (line: string, i: number): WordCls | undefined => {
  if (i >= line.length) return undefined;
  const a = line.charCodeAt(i);
  const s = a >= 0xd800 && a <= 0xdbff && line.charCodeAt(i + 1) >= 0xdc00 && line.charCodeAt(i + 1) <= 0xdfff
    ? line.slice(i, i + 2)
    : line[i]!;
  return /\s/.test(s) ? 0 : WORD_CH.test(s) ? 1 : 2;
};
const clsLeft = (line: string, i: number): WordCls | undefined => {
  if (i <= 0) return undefined;
  const a = line.charCodeAt(i - 2);
  const s = a >= 0xd800 && a <= 0xdbff && line.charCodeAt(i - 1) >= 0xdc00 && line.charCodeAt(i - 1) <= 0xdfff
    ? line.slice(i - 2, i)
    : line[i - 1]!;
  return /\s/.test(s) ? 0 : WORD_CH.test(s) ? 1 : 2;
};

/** Next word boundary right of `col` (never < col; EOL is its own stop --
 *  the caller owns the line crossing). */
export function forwardWordCol(line: string, col: number): number {
  let i = Math.max(0, Math.min(col, line.length));
  const at = clsRight(line, i);
  if (at === undefined) return i; // already at EOL
  if (at === 0) {
    // Gap first, then the run it hides -- but if only a gap remains, the gap
    // alone is the move (land at EOL, do not cross lines from mid-gap).
    while (i < line.length && clsRight(line, i) === 0) i++;
    if (i >= line.length) return i;
  }
  const cls = clsRight(line, i);
  while (i < line.length && clsRight(line, i) === cls) i++;
  return i;
}

/** Next word boundary left of `col` (never > col; col 0 is its own stop). */
export function backwardWordCol(line: string, col: number): number {
  let i = Math.max(0, Math.min(col, line.length));
  const at = clsLeft(line, i);
  if (at === undefined) return i; // already at col 0
  if (at === 0) {
    while (i > 0 && clsLeft(line, i) === 0) i--;
    if (i <= 0) return i;
  }
  const cls = clsLeft(line, i);
  while (i > 0 && clsLeft(line, i) === cls) i--;
  return i;
}

/** alt+ArrowLeft/Right: word-wise move of the PRIMARY caret (the standard
 *  multi-caret collapse the plain arrows already ride), Shift extends. */
export function moveWordHorizontal(buf: TextBuffer, dir: -1 | 1, extend: boolean): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  const line = buf.lines[head.line]!;
  let target: Pos;
  if (dir === 1) {
    const to = forwardWordCol(line, head.col);
    target = to > head.col
      ? { line: head.line, col: to }
      : head.line < buf.lines.length - 1
        ? { line: head.line + 1, col: 0 }
        : head;
  } else {
    const to = backwardWordCol(line, head.col);
    target = to < head.col
      ? { line: head.line, col: to }
      : head.line > 0
        ? { line: head.line - 1, col: buf.lines[head.line - 1]!.length }
        : head;
  }
  return extend ? extendPrimary(buf, target) : setCaret(buf, target);
}

/** alt+Backspace / alt+Delete: delete to the word boundary PER CARET, ONE
 *  block undo step (deliberately NOT the typing kind: a word delete is a
 *  structural edit, never coalesced into an adjacent typing run). With any
 *  selection the selection goes instead (the plain-delete doctrine). A caret
 *  at a buffer edge contributes a zero-width range (it survives the op and
 *  its caret stays put); when NO caret can delete anything the key is dead:
 *  no step, no dirty, identity. */
export function deleteWord(buf: TextBuffer, dir: -1 | 1, time: number): TextBuffer {
  if (buf.sels.some(hasSelection)) {
    return performTx(buf, () => "", (entry) => ({ anchor: entry.edit.from, head: entry.edit.from }), { kind: "block", time });
  }
  // The applyCaretDeletes machine (same as plain backspace/Delete, so a
  // dead caret SURVIVES with its position and the undo step restores the
  // CARETS, not staged ranges -- a performTx staging would leak the
  // staged span back as a selection on undo): edits carry the caret's head
  // at the word boundary, EOL/col-0 ride the line-break merge, buffer
  // edges leave the head untouched (a dead caret contributes nothing).
  const edits = buf.sels.map((r) => {
    const p = clampPos(buf.lines, r.head);
    const line = buf.lines[p.line]!;
    let head: Pos;
    if (dir === 1) {
      if (p.col >= line.length) head = p.line < buf.lines.length - 1 ? { line: p.line + 1, col: 0 } : p;
      else head = { line: p.line, col: forwardWordCol(line, p.col) };
    } else {
      if (p.col <= 0) head = p.line > 0 ? { line: p.line - 1, col: buf.lines[p.line - 1]!.length } : p;
      else head = { line: p.line, col: backwardWordCol(line, p.col) };
    }
    return { anchor: p, head };
  });
  return applyCaretDeletes(buf, edits, time, "block");
}

// ── Select inside quotes (the innermost pair containing the primary caret) ─
// Single, double, backtick. Each quote char is scanned INDEPENDENTLY with
// backslash-escape awareness (an escaped quote never opens or closes a run),
// pairs are consecutive unescaped occurrences, and every CLOSED pair that
// strictly contains the caret is a candidate -- the SMALLEST span wins, so
// the b in `f('a "b|c" d')` selects `b|c` rather than the outer `'...'`.
// Quotes never span lines (the matchScan's stated ceiling, same rule). An
// unpaired quote, or a caret on/outside every pair, is an honest no-op.

/** The innermost closed quote pair on `line` strictly containing column
 *  `col`: the content range (quote chars excluded). Undefined when nothing
 *  contains the caret. */
export function quoteContentRange(line: string, col: number): { from: number; to: number } | undefined {
  const p = Math.max(0, Math.min(col, line.length));
  let best: { from: number; to: number } | undefined;
  for (const q of ['"', "'", "`"]) {
    let start = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === "\\") {
        i++; // the escaped char (whatever it is) is inert
        continue;
      }
      if (c !== q) continue;
      if (start >= 0) {
        if (p > start && p < i) {
          const span = { from: start + 1, to: i };
          if (!best || span.to - span.from < best.to - best.from) best = span;
        }
        start = -1; // pairs never nest per char: this run closed
      } else {
        start = i;
      }
    }
  }
  return best;
}

/** PRIMARY-caret only (stated): expand the selection to the content of the
 *  innermost quote/backtick pair containing the primary caret; no-op when
 *  the caret sits in no closed pair. Selection move, so no undo step and no
 *  dirty, like every other caret op. */
export function selectInsideQuotes(buf: TextBuffer): TextBuffer {
  const head = clampPos(buf.lines, primarySel(buf).head);
  const span = quoteContentRange(buf.lines[head.line]!, head.col);
  if (!span) return buf;
  return selectRange(buf, { line: head.line, col: span.from }, { line: head.line, col: span.to });
}

// ── Line-comment toggle (Ctrl/Cmd+/) ───────────────────────────────────────
// The session's paint lang decides the token; the keys are file-view's own
// lang names. A lang with NO line comment (css/html/xml are block-only,
// json has no comments at all, diff/markdown/plain are not commentable) is
// an honest no-op -- NO block-comment fallback is invented, per spec.
//
// Semantics: the PRIMARY selection's line block; if ANY line of the block
// is commented the whole block uncomments (the commented ones lose the
// token plus ONE trailing space, exactly what commenting inserted), else
// every line comments: the token + a space goes AFTER the leading
// whitespace. Whitespace-only lines are never touched (they carry no code,
// and it keeps "// " litter off the blanks -- an all-blank block is a dead
// key). Carets on touched lines shift by what the line gained or lost; one
// block undo step.

/** lang -> line-comment token. Absent (or unknown lang, or none) = the
 *  toggle is an honest no-op. Keys are fileViewLangChoices()' names. */
export const LINE_COMMENT_BY_LANG: Record<string, string> = {
  c: "//",
  cpp: "//",
  csharp: "//",
  dart: "//",
  go: "//",
  groovy: "//",
  java: "//",
  javascript: "//",
  kotlin: "//",
  php: "//",
  protobuf: "//",
  rust: "//",
  scss: "//", // SCSS ships // lines (plain css is block-only -> absent)
  swift: "//",
  typescript: "//",
  zig: "//",
  cmake: "#",
  crystal: "#",
  dockerfile: "#",
  elixir: "#",
  env: "#",
  gitignore: "#",
  graphql: "#",
  hcl: "#",
  ini: "#",
  make: "#",
  nix: "#",
  python: "#",
  ruby: "#",
  shell: "#",
  toml: "#",
  yaml: "#",
  lua: "--",
  sql: "--",
  erlang: "%",
};

export const lineCommentToken = (lang: string | undefined): string | undefined =>
  lang === undefined ? undefined : LINE_COMMENT_BY_LANG[lang];

/** The column a comment token goes at: after the line's leading whitespace
 *  (a whitespace-only line reports its own end -> it never gets a token). */
const commentCol = (line: string): number => leadingWs(line).length;

export function toggleLineComment(buf: TextBuffer, lang: string | undefined, time: number): TextBuffer {
  const token = lineCommentToken(lang);
  if (token === undefined) return buf; // json/unknown/block-only: honest no-op
  const sel = primarySel(buf);
  const from = clampPos(buf.lines, normFrom(sel));
  const to = clampPos(buf.lines, normTo(sel));
  const codeLines: number[] = [];
  for (let l = from.line; l <= to.line; l++) if (buf.lines[l]!.trim() !== "") codeLines.push(l);
  if (codeLines.length === 0) return buf; // a blank block is a dead key
  const isCommented = (l: number): boolean => buf.lines[l]!.startsWith(token, commentCol(buf.lines[l]!));
  const uncomment = codeLines.some(isCommented); // ANY -> uncomment (pinned rule)
  // Descending apply keeps every not-yet-touched line's coordinates valid
  // (the dedentLines pattern: per-line edits outside the selection
  // mechanism, still one UndoStep through the same primitives).
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  const deltas = new Map<number, number>();
  for (const l of [...codeLines].sort((x, y) => y - x)) {
    const line = lines[l]!;
    const col = commentCol(line);
    if (uncomment) {
      if (!line.startsWith(token, col)) continue; // only the commented ones lose it
      const cut = token.length + (line[col + token.length] === " " ? 1 : 0);
      const { lines: next, entry } = applyEdit(lines, { line: l, col }, { line: l, col: col + cut }, "");
      lines = next;
      entries.push(entry);
      deltas.set(l, -cut);
    } else {
      const { lines: next, entry } = applyEdit(lines, { line: l, col }, { line: l, col }, token + " ");
      lines = next;
      entries.push(entry);
      deltas.set(l, token.length + 1);
    }
  }
  if (entries.length === 0) return buf;
  const shift = (p: Pos): Pos => {
    const d = deltas.get(p.line);
    return d === undefined ? p : { line: p.line, col: Math.max(0, p.col + d) };
  };
  const selsAfter = buf.sels.map((r) => ({ anchor: shift(r.anchor), head: shift(r.head) }));
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter,
    primaryAfter: buf.primary,
    kind: "block",
    time,
  };
  return stampDirty({ ...buf, lines, sels: selsAfter, primary: buf.primary, undo: [...buf.undo, step], redo: [] });
}

// ── Duplicate line (Ctrl+Shift+D; alt+Shift+Down is taken by add-caret) ────
// Per caret: the caret's line is duplicated below it and the caret rides
// the COPY (VS Code's shape). Selections collapse to carets -- this chord
// is line geometry, the selection extent is irrelevant. Two carets on one
// line duplicate it ONCE (identical insert points dedupe) and both carets
// land on the copy at their own columns. ONE block undo step.
export function duplicateLine(buf: TextBuffer, time: number): TextBuffer {
  const heads = buf.sels.map((r) => clampPos(buf.lines, r.head));
  const targets = [...new Set(heads.map((h) => h.line))];
  const ascending = [...targets].sort((x, y) => x - y);
  // Descending: the dedent/applyEdit discipline (disjoint edits, LIFO-safe).
  let lines = buf.lines;
  const entries: TxEntry[] = [];
  for (const l of ascending.slice().reverse()) {
    const eol = { line: l, col: buf.lines[l]!.length };
    const { lines: next, entry } = applyEdit(lines, eol, eol, "\n" + buf.lines[l]!);
    lines = next;
    entries.push(entry);
  }
  // The caret lands on the COPY: its own line plus one, plus every copy
  // inserted BELOW it (those pushed the caret's own line down too).
  const newLine = (l: number): number => l + 1 + ascending.indexOf(l);
  const selsAfter = heads.map((h) => {
    const p = { line: newLine(h.line), col: h.col };
    return { anchor: p, head: p };
  });
  const step: UndoStep = {
    entries,
    selsBefore: buf.sels,
    primaryBefore: buf.primary,
    selsAfter,
    primaryAfter: buf.primary,
    kind: "block",
    time,
  };
  return stampDirty({ ...buf, lines, sels: selsAfter, primary: buf.primary, undo: [...buf.undo, step], redo: [] });
}

// ── Matched-bracket highlight ──────────────────────────────────────────────
// When the caret touches a bracket (the char left or right is one of
// ()[]{}), find its MATE with a balanced depth scan. Naive by design: it
// counts bracket depth and skips over quoted runs ('...' "..." `...` with
// backslash escapes) so string contents never match. It is NOT a parser --
// comments full of brackets, regexes and template interpolation are stated
// ceilings. The scan walks at most MATCH_SCAN_CELLS code units and gives up
// (undefined) beyond that, so no keystroke can hang; a crossed bracket
// (`(a]b)`) reports no match honestly. Pure index arithmetic: cannot throw.

export const MATCH_SCAN_CELLS = 200_000;

/** The mate pair for the bracket adjacent to caret `p` (prefers the char to
 *  the RIGHT -- a just-typed `{|}` highlights and typing over keeps it), or
 *  undefined when nothing is adjacent or the mate does not exist. */
export function matchBracket(lines: string[], p: Pos): { a: Pos; b: Pos } | undefined {
  const pos = clampPos(lines, p);
  const line = lines[pos.line] ?? "";
  const right = pos.col < line.length ? line[pos.col]! : undefined;
  const left = pos.col > 0 ? line[pos.col - 1]! : undefined;
  const bracket = (c: string | undefined): boolean =>
    c !== undefined && (c === "(" || c === "[" || c === "{" || c === ")" || c === "]" || c === "}");
  const start = bracket(right)
    ? { p: pos, ch: right! }
    : bracket(left)
      ? { p: { line: pos.line, col: pos.col - 1 }, ch: left! }
      : undefined;
  if (!start) return undefined;
  const mate = scanMate(lines, start.p, start.ch);
  return mate ? { a: start.p, b: mate } : undefined;
}

/** Balanced scan for `ch`'s mate from position `at`: forward for an opener,
 *  backward for a closer. Depth counts ALL brackets (so `f(); }` matches
 *  honestly), and a foreign bracket AT depth 0 facing the wrong way
 *  (`(a]`, or `[a)` read backwards) reports crossed. Naive quote skipping
 *  (quotes never span lines). `ch` is always one of ()[]{}. */
function scanMate(lines: string[], at: Pos, ch: string): Pos | undefined {
  const isOpenCh = (c: string): boolean => c === "(" || c === "[" || c === "{";
  const isCloseCh = (c: string): boolean => c === ")" || c === "]" || c === "}";
  const forward = isOpenCh(ch);
  // Opener -> its closer (PAIR_OF), closer -> its opener (CLOSER_OF).
  const target = forward ? PAIR_OF[ch]! : CLOSER_OF[ch]!;
  const dir = forward ? 1 : -1;
  let depth = 0;
  let walked = 0;
  let line = at.line;
  let col = at.col + dir;
  let insq: string | undefined;
  while (line >= 0 && line < lines.length && walked < MATCH_SCAN_CELLS) {
    const text = lines[line]!;
    if (col < 0) {
      line--;
      col = (lines[line]?.length ?? 0) - 1;
      insq = undefined;
      continue;
    }
    if (col >= text.length) {
      line++;
      col = 0;
      insq = undefined;
      continue;
    }
    const c = text[col]!;
    walked++;
    if (insq) {
      if (c === "\\") col += dir * 2;
      else {
        if (c === insq) insq = undefined;
        col += dir;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      insq = c;
      col += dir;
      continue;
    }
    const along = forward ? isOpenCh(c) : isCloseCh(c); // nests (depth grows)
    if (along) depth++;
    else if (forward ? isCloseCh(c) : isOpenCh(c)) {
      if (depth === 0) return c === target ? { line, col } : undefined;
      depth--;
    }
    col += dir;
  }
  return undefined;
}
