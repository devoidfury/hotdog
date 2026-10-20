// LineEditor (design note §4): the single logical line. Buffer is one string
// that may contain \n (only paste/dictation introduce it); the cursor is a
// code-unit offset constrained to grapheme-cluster boundaries, never a
// (row,col). Motion is two-layered per §4: the LOGICAL layer steps clusters
// (left/right/home/end/word ops/kill), the VISUAL layer moves across wrapped
// rows with a best-effort remembered column (up/down at the view edges via
// editor-view.ts).
//
// Width math is the stage-2 table: clusters measure as units, a double-wide
// glyph never splits across rows, and a cursor cell may equal the viewport
// width only as the pending-wrap cell at a row edge (§7 DECAWM ownership).
//
// The prompt lives here because it participates in the wrapped view: row 0
// begins with it and the cursor cannot enter it. Caller-supplied and
// re-targetable (§4 MODEL_CHANGE); newlines are stripped from it.
//
// No undo: §4 pins the readline-default map plus the kill ring (Ctrl-K/U/W +
// Ctrl-Y yank) and includes no undo operator, so paste is not an undoable
// unit either. Kill ops return their text; the VIEW owns the yank ring.

import { clusterStarts, clusterWidth, segments, snapBackward, snapForward } from "./clusters.ts";
import { visibleWidth } from "./width.ts";

export interface EditorLayout {
  /** Wrapped display rows, prompt included (never empty). */
  rows: string[];
  /** Cluster start offsets (combined prompt+buffer coords) per row. */
  rowStarts: number[][];
  /** End offset (exclusive, combined coords) per row; excludes the hard newline. */
  rowEnds: number[];
  cursorRow: number;
  /** Cell column 0..width; === width is the pending-wrap cell at the row edge. */
  cursorCol: number;
  width: number;
}

export interface EditorBlockView {
  /** Rows shown (windowed when maxRows was given). */
  rows: string[];
  /** Cursor within the shown window; 0 <= cursorRow < rows.length. */
  cursorRow: number;
  cursorCol: number;
  /** Index of rows[0] in the full wrapped block. */
  top: number;
  totalRows: number;
}

const isWordChar = (cluster: string): boolean => /[\p{L}\p{N}_]/u.test(cluster);
const isSpace = (cluster: string): boolean => /^\s+$/.test(cluster);
const isNewline = (cluster: string): boolean =>
  cluster === "\n" || cluster === "\r\n" || cluster === "\r";

export class LineEditor {
  private text = "";
  private cursor = 0; // code-unit offset into text, always a cluster boundary
  private prompt = "";
  /** Column remembered across consecutive visual up/down moves (§4). */
  private desiredCol: number | null = null;

  get buffer(): string {
    return this.text;
  }

  get cursorOffset(): number {
    return this.cursor;
  }

  get promptText(): string {
    return this.prompt;
  }

  /** Replace the whole line (history navigation); cursor goes to the end. */
  setText(text: string): void {
    this.text = text;
    this.cursor = snapBackward(text, text.length);
    this.desiredCol = null;
  }

  /** Prompt is single-line by contract; newlines in it are stripped. */
  setPrompt(p: string): void {
    this.prompt = p.replaceAll("\r\n", "").replaceAll(/[\r\n]/g, "");
  }

  /** Insert at the cursor; with from given, replace [from, cursor) (popup accept). */
  insert(s: string, from?: number): void {
    const start = from !== undefined ? snapBackward(this.text, Math.min(from, this.cursor)) : this.cursor;
    this.text = this.text.slice(0, start) + s + this.text.slice(this.cursor);
    this.cursor = snapForward(this.text, start + s.length);
    this.desiredCol = null;
  }

  /** Delete the cluster before the cursor. False at the buffer start. */
  backspace(): boolean {
    const pos = snapBackward(this.text, this.cursor);
    let prev = -1;
    for (const b of clusterStarts(this.text)) {
      if (b < pos) prev = b;
      else break;
    }
    if (prev < 0) return false;
    this.text = this.text.slice(0, prev) + this.text.slice(pos);
    this.cursor = prev;
    this.desiredCol = null;
    return true;
  }

  /** Delete the cluster under the cursor. False at the buffer end. */
  deleteForward(): boolean {
    if (this.cursor >= this.text.length) return false;
    const end = snapForward(this.text, this.cursor + 1);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
    this.desiredCol = null;
    return true;
  }

  /** Logical cluster step. False = already at the edge (no move). */
  moveLeft(): boolean {
    const starts = clusterStarts(this.text);
    for (let i = starts.length - 1; i >= 0; i--) {
      if (starts[i]! < this.cursor) {
        this.cursor = starts[i]!;
        this.desiredCol = null;
        return true;
      }
    }
    return false;
  }

  moveRight(): boolean {
    if (this.cursor >= this.text.length) return false;
    this.cursor = snapForward(this.text, this.cursor + 1);
    this.desiredCol = null;
    return true;
  }

  moveToStart(): void {
    this.cursor = 0;
    this.desiredCol = null;
  }

  moveToEnd(): void {
    this.cursor = snapBackward(this.text, this.text.length);
    this.desiredCol = null;
  }

  /** alt-f / ctrl-right: end of the current (or next, if between) word run. */
  forwardWord(): void {
    const starts = clusterStarts(this.text);
    const at = (k: number): string => this.text.slice(starts[k] ?? this.text.length, starts[k + 1] ?? this.text.length);
    let i = this.clusterIndexAt(starts, this.cursor);
    while (i < starts.length && !isWordChar(at(i))) i++;
    while (i < starts.length && isWordChar(at(i))) i++;
    this.cursor = i >= starts.length ? this.text.length : starts[i]!;
    this.desiredCol = null;
  }

  /** alt-b / ctrl-left: start of the word run before the cursor. */
  backwardWord(): void {
    const starts = clusterStarts(this.text);
    const at = (k: number): string => this.text.slice(starts[k] ?? this.text.length, starts[k + 1] ?? this.text.length);
    let i = this.clusterIndexAt(starts, this.cursor) - 1;
    while (i >= 0 && !isWordChar(at(i))) i--;
    while (i >= 0 && isWordChar(at(i))) i--;
    this.cursor = i < 0 ? 0 : starts[i + 1]!;
    this.desiredCol = null;
  }

  /** Ctrl-W: kill the whitespace plus the word before the cursor; returns killed text. */
  killWordBackward(): string {
    let pos = this.cursor;
    for (;;) {
      const c = this.clusterBefore(pos);
      if (c === "" || !isSpace(c)) break;
      pos -= c.length;
    }
    for (;;) {
      const c = this.clusterBefore(pos);
      if (c === "" || !isWordChar(c)) break;
      pos -= c.length;
    }
    return this.cutRange(pos, this.cursor);
  }

  /** Ctrl-Delete: kill whitespace plus the word after the cursor (stops at a newline). */
  killWordForward(): string {
    const starts = clusterStarts(this.text);
    const at = (k: number): string => this.text.slice(starts[k] ?? this.text.length, starts[k + 1] ?? this.text.length);
    let i = this.clusterIndexAt(starts, this.cursor);
    let pos = this.cursor;
    while (i < starts.length && !isWordChar(at(i)) && !isSpace(at(i))) i++; // punctuation run
    while (i < starts.length && (isSpace(at(i)) || isWordChar(at(i)))) {
      if (isNewline(at(i))) break; // newline kills belong to Ctrl-K
      pos = starts[i + 1] ?? this.text.length;
      i++;
    }
    return this.cutRange(this.cursor, pos);
  }

  /** Ctrl-K: to the end of the logical line; on a newline, delete just it. */
  killLine(): string {
    const nl = this.text.indexOf("\n", this.cursor);
    const to = nl >= 0 ? nl + 1 : this.text.length;
    return this.cutRange(this.cursor, to);
  }

  /** Ctrl-U: back to the start of the logical line. */
  killToStart(): string {
    const nl = this.cursor > 0 ? this.text.lastIndexOf("\n", this.cursor - 1) : -1;
    return this.cutRange(Math.max(0, nl + 1), this.cursor);
  }

  private cutRange(from: number, to: number): string {
    if (to <= from) return "";
    const killed = this.text.slice(from, to);
    this.text = this.text.slice(0, from) + this.text.slice(to);
    this.cursor = from;
    this.desiredCol = null;
    return killed;
  }

  /** The cluster immediately before offset pos, or "" at the buffer start. */
  private clusterBefore(pos: number): string {
    const starts = clusterStarts(this.text);
    for (let i = starts.length - 1; i >= 0; i--) {
      if (starts[i]! < pos) return this.text.slice(starts[i]!, starts[i + 1] ?? this.text.length);
    }
    return "";
  }

  private clusterIndexAt(starts: number[], pos: number): number {
    let i = 0;
    while (i < starts.length && starts[i]! < pos) i++;
    return i;
  }

  /** Popup default replace span: walk back from the cursor to whitespace/line start. */
  wordStartBackward(): number {
    let pos = this.cursor;
    while (pos > 0) {
      const c = this.clusterBefore(pos);
      if (c === "" || /\s/.test(c)) break;
      pos -= c.length;
    }
    return pos;
  }

  /** Visual up/down at the viewport width; history consultation lives above. */
  moveVisual(delta: number, width: number): "moved" | "edge-top" | "edge-bottom" {
    const layout = this.layout(width);
    const targetRow = layout.cursorRow + delta;
    if (targetRow < 0) return "edge-top";
    if (targetRow >= layout.rows.length) return "edge-bottom";
    const want = this.desiredCol ?? layout.cursorCol;
    this.desiredCol = want;
    // placeAtCell answers in COMBINED (prompt+buffer) coords; this.cursor is a
    // BUFFER offset. Without the unshift, every visual move lands prompt.length
    // cells too far right (and can point past the buffer).
    const from = this.cursor;
    const combined = this.placeAtCell(layout, targetRow, want);
    this.cursor = snapBackward(this.text, Math.max(0, combined - this.prompt.length));
    if (this.layout(width).cursorRow !== targetRow) {
      // The prompt swallowed the move (target row has no landable cell outside
      // the prompt): no visual progress, so report the edge instead of a
      // silent "moved" -- that is how history navigation gets its turn.
      this.cursor = from;
      return delta < 0 ? "edge-top" : "edge-bottom";
    }
    return "moved";
  }

  /** Nearest cluster boundary to cell `col` in row `row` (combined coords). */
  private placeAtCell(layout: EditorLayout, row: number, col: number): number {
    const combined = this.prompt + this.text;
    const starts = layout.rowStarts[row]!;
    const rowEnd = layout.rowEnds[row]!;
    if (starts.length === 0) return rowEnd;
    // Which boundaries RENDER inside this row (DECAWM pending-wrap): the
    // first cluster of a soft-wrapped row renders at the PREVIOUS row's edge
    // (that offset IS rowEnds[row-1]), so it never lands here; every later
    // cluster start renders at its accumulated cell; rowEnd renders at the
    // row's accumulated width (pending-wrap, hard-newline end, or buffer end).
    const skipFirst = row > 0 && starts[0] === layout.rowEnds[row - 1];
    let best = -1;
    let bestDist = Infinity;
    let acc = 0;
    for (let i = 0; i < starts.length; i++) {
      if (!skipFirst || i > 0) {
        const d = Math.abs(acc - col);
        if (d < bestDist) {
          best = starts[i]!;
          bestDist = d;
        }
      }
      acc += clusterWidth(combined.slice(starts[i]!, starts[i + 1] ?? rowEnd));
    }
    if (Math.abs(acc - col) < bestDist) best = rowEnd;
    // ties keep the earlier boundary: stable round-trips across up/down
    return best;
  }

  // ── geometry ───────────────────────────────────────────────────────────

  /** Full wrapped block (prompt + buffer) with the cursor position. */
  layout(width: number): EditorLayout {
    const w = Math.max(1, width);
    const combined = this.prompt + this.text;
    const target = this.prompt.length + this.cursor;
    const rows: string[] = [];
    const rowStarts: number[][] = [];
    const rowEnds: number[] = [];
    let cur = "";
    let starts: number[] = [];
    let curW = 0;
    let cursorRow = 0;
    let cursorCol = 0;
    let cursorSeen = false;
    const flush = (end: number): void => {
      rows.push(cur);
      rowStarts.push(starts);
      rowEnds.push(end);
      cur = "";
      starts = [];
      curW = 0;
    };
    let off = 0;
    for (const { segment: seg } of segments(combined)) {
      if (off === target) {
        cursorRow = rows.length;
        cursorCol = curW;
        cursorSeen = true;
      }
      if (isNewline(seg)) {
        flush(off);
        off += seg.length;
        continue;
      }
      const cw = clusterWidth(seg);
      if (cw > 0 && curW + cw > w && curW > 0) flush(off);
      starts.push(off);
      cur += seg;
      curW += cw;
      off += seg.length;
    }
    if (!cursorSeen) {
      cursorRow = rows.length;
      cursorCol = curW;
    }
    flush(combined.length);
    return { rows, rowStarts, rowEnds, cursorRow, cursorCol, width: w };
  }

  /**
   * Frame-facing view: the wrapped editor block, optionally windowed to
   * maxRows with the cursor kept visible (vertical scroll for long inputs).
   * cursorCol may equal width (pending-wrap cell); the composer clamps it.
   */
  view(width: number, maxRows?: number): EditorBlockView {
    const layout = this.layout(width);
    let top = 0;
    const cap = maxRows !== undefined && maxRows > 0 ? maxRows : layout.rows.length;
    if (layout.rows.length > cap) {
      top = Math.min(Math.max(0, layout.cursorRow - cap + 1), layout.rows.length - cap);
    }
    return {
      rows: layout.rows.slice(top, top + cap),
      cursorRow: layout.cursorRow - top,
      cursorCol: layout.cursorCol,
      top,
      totalRows: layout.rows.length,
    };
  }

  /** Display width of the current prompt (frame composer convenience). */
  promptWidth(): number {
    return visibleWidth(this.prompt);
  }
}
