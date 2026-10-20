// In-memory Grid: the test-side Terminal (design note §11). Implements a
// parser subset limited to the sequences the renderer emits plus what bun's
// readline paints into the capture stream -- CUU/CUD/CUF/CUB, CPL/NPL, CUP,
// CHP (cursor to column; every bun readline refresh leads with `\x1b[1G` and
// ends with `\x1b[<n>G`), ED, EL, IL, DL, CR/LF, printable chars -- with
// ?2026/?2004/?25 recorded to a mode log instead of interpreted. SGR is
// consumed and ignored (golden tests compare text, not attributes); OSC 8
// spans are consumed invisibly.
//
// Documented ceilings (test double, not a terminal):
// - Pending-wrap models full-width writes the DECAWM way (a glyph landing in
//   the last column wraps on the NEXT printable, so exact-width rows plus
//   EL/ED behave as on a real terminal); the app pre-wraps (§7), and BoundedWriter
//   chunks >1 MiB payloads may split escape sequences mid-stream, which this
//   parser does not reassemble -- byte-golden those paths with a recorder.
// - No reflow on resize: rows hard-truncate/pad. The renderer re-erases from
//   the old frame geometry and repaints (§6), so only the frame's own rows
//   must survive a width change intact.
// - Escape sequences split across feed() calls are not reassembled.

import type { Terminal } from "./seams.ts";
import { charWidth } from "./width.ts";

const ESC = "\x1b";
const FILLER = "\u0000"; // second cell of a double-wide glyph

export interface GridSnapshot {
  scrollback: string[];
  screen: string[];
}

export class Grid {
  cols: number;
  rows: number;
  cursorRow = 0;
  cursorCol = 0;
  /** Rows pushed off the top by scrolling (write-once history). */
  scrollback: string[][] = [];
  /** Private-mode set/reset and raw-mode events, in emission order. */
  modeLog: string[] = [];
  /** DECAWM: set after a glyph lands in the last column; next printable wraps. */
  private pendingWrap = false;
  private cells: string[][];

  constructor(rows = 24, cols = 80) {
    this.rows = rows;
    this.cols = cols;
    this.cells = Array.from({ length: rows }, () => blankRow(cols));
  }

  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === ESC) {
        if (s[i + 1] === "[") i = this.csi(s, i + 2);
        else if (s[i + 1] === "]") i = this.osc(s, i + 2);
        else i += 2; // two-byte escapes are outside the emitted subset
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
        i++;
        continue;
      }
      if (ch === "\r") {
        this.cursorCol = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }
      const cp = s.codePointAt(i)!;
      this.put(String.fromCodePoint(cp), charWidth(cp));
      i += cp > 0xffff ? 2 : 1;
    }
  }

  snapshot(): GridSnapshot {
    return {
      scrollback: this.scrollback.map(rowText),
      screen: this.cells.map(rowText),
    };
  }

  /** Test-side viewport change; GridTerminal.resize() layers the event on top. */
  resize(cols: number, rows: number): void {
    this.pendingWrap = false;
    if (cols !== this.cols) {
      for (const row of this.cells) {
        row.length = cols;
        while (row.length < cols) row.push(" ");
      }
      for (const row of this.scrollback) {
        row.length = cols;
        while (row.length < cols) row.push(" ");
      }
      this.cols = cols;
    }
    if (rows < this.rows) {
      const drop = this.rows - rows;
      this.scrollback.push(...this.cells.splice(0, drop));
      this.rows = rows;
      this.cursorRow = Math.max(0, this.cursorRow - drop);
    } else if (rows > this.rows) {
      while (this.cells.length < rows) this.cells.push(blankRow(this.cols));
      this.rows = rows;
    }
    this.cursorRow = Math.min(this.cursorRow, this.rows - 1);
    this.cursorCol = Math.min(this.cursorCol, this.cols - 1);
  }

  private put(ch: string, width: number): void {
    if (width === 0) return; // controls never occupy cells
    // DECAWM pending-wrap: a glyph written at the last column leaves the
    // cursor in virtual column W; the NEXT printable wraps the line. Without
    // this model the following EL would eat the last cell of a full-width
    // row -- and wrapped rows are exactly full width.
    if (this.pendingWrap) {
      this.pendingWrap = false;
      this.cursorCol = 0;
      this.lineFeed();
    }
    const row = this.cells[this.cursorRow]!;
    const at = this.cursorCol;
    row[at] = ch;
    if (width === 2 && at + 1 < this.cols) row[at + 1] = FILLER;
    if (at + width >= this.cols) {
      this.cursorCol = this.cols - 1;
      this.pendingWrap = true;
    } else {
      this.cursorCol = at + width;
    }
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.cursorRow === this.rows - 1) {
      this.scrollback.push(this.cells.shift()!);
      this.cells.push(blankRow(this.cols));
    } else {
      this.cursorRow++;
    }
  }

  // ── CSI ────────────────────────────────────────────────────────────────

  private csi(s: string, start: number): number {
    const params: number[] = [];
    let privatePrefix = false;
    let cur = "";
    let i = start;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (c === "?") {
        privatePrefix = true;
      } else if (c >= "0" && c <= "9") {
        cur += c;
      } else if (c === ";") {
        params.push(cur === "" ? 0 : parseInt(cur, 10));
        cur = "";
      } else if (c >= " " && c <= "/") {
        // intermediates: unused by the emitted subset
      } else {
        break; // final byte @..~
      }
    }
    if (i >= s.length) {
      this.modeLog.push("csi-truncated");
      return i;
    }
    if (cur !== "" || params.length > 0) params.push(cur === "" ? 0 : parseInt(cur, 10));
    this.dispatchCsi(s[i]!, privatePrefix, params);
    return i + 1;
  }

  private dispatchCsi(final: string, priv: boolean, params: number[]): void {
    // Cursor/line ops default absent-or-zero params to 1; ED/EL default to 0.
    const n = (k: number): number => (params[k] ? params[k]! : 1);
    if ("ABCDEFGHfLM".includes(final)) this.pendingWrap = false;
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - n(0));
        return;
      case "B":
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0));
        return;
      case "C":
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n(0));
        return;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - n(0));
        return;
      case "G": // CHP/HPA: cursor to column n, row unchanged.
        this.cursorCol = Math.min(this.cols - 1, n(0) - 1);
        return;
      case "E": // CNL: down n lines, first column
        this.cursorCol = 0;
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0));
        return;
      case "F": // CPL: up n lines, first column
        this.cursorCol = 0;
        this.cursorRow = Math.max(0, this.cursorRow - n(0));
        return;
      case "H":
      case "f":
        this.cursorRow = Math.min(this.rows - 1, n(0) - 1);
        this.cursorCol = Math.min(this.cols - 1, n(1) - 1);
        return;
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 3) {
          this.scrollback = [];
          return;
        }
        if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r++) this.cells[r] = blankRow(this.cols);
          const row = this.cells[this.cursorRow]!;
          for (let c = 0; c <= Math.min(this.cursorCol, row.length - 1); c++) row[c] = " ";
          return;
        }
        if (mode === 2) {
          for (let r = 0; r < this.rows; r++) this.cells[r] = blankRow(this.cols);
          return;
        }
        // ED(0): cursor cell to end of screen. In pending-wrap the cursor
        // sits in virtual column W, so the current row survives untouched.
        const cur = this.cells[this.cursorRow]!;
        const from = this.pendingWrap ? cur.length : this.cursorCol;
        for (let c = from; c < cur.length; c++) cur[c] = " ";
        for (let r = this.cursorRow + 1; r < this.rows; r++) {
          this.cells[r] = blankRow(this.cols);
        }
        return;
      }
      case "K": {
        const mode = params[0] ?? 0;
        const row = this.cells[this.cursorRow]!;
        if (mode === 2) {
          for (let c = 0; c < row.length; c++) row[c] = " ";
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol && c < row.length; c++) row[c] = " ";
        } else if (!this.pendingWrap) {
          for (let c = this.cursorCol; c < row.length; c++) row[c] = " ";
        }
        return;
      }
      case "L": {
        const count = n(0);
        for (let k = 0; k < count; k++) this.cells.splice(this.cursorRow, 0, blankRow(this.cols));
        this.cells.length = this.rows; // pushed-off bottom lines are lost, not scrollback
        return;
      }
      case "M": {
        this.cells.splice(this.cursorRow, n(0));
        while (this.cells.length < this.rows) this.cells.push(blankRow(this.cols));
        return;
      }
      case "m":
        return; // SGR: text-only golden, attributes ignored
      case "h":
      case "l":
        if (priv) {
          for (const p of params) {
            if (p === 2026 || p === 2004 || p === 25) this.modeLog.push(`?${p}${final}`);
          }
        }
        return;
      default:
        return; // outside the emitted subset: consume
    }
  }

  // ── OSC ────────────────────────────────────────────────────────────────

  private osc(s: string, start: number): number {
    for (let i = start; i < s.length; i++) {
      if (s[i] === "\x07") return i + 1;
      if (s[i] === ESC) return s[i + 1] === "\\" ? i + 2 : i;
    }
    return s.length;
  }
}

function blankRow(cols: number): string[] {
  return Array.from({ length: cols }, () => " ");
}

function rowText(row: string[]): string {
  return row.join("").replaceAll(FILLER, "").replace(/\s+$/, "");
}

/** Terminal seam backed by an in-memory Grid. resize() fires onResize subscribers like process.stdout. */
export class GridTerminal implements Terminal {
  readonly grid: Grid;
  rawMode = false;
  private listeners = new Set<() => void>();

  constructor(opts: { rows?: number; cols?: number } = {}) {
    this.grid = new Grid(opts.rows ?? 24, opts.cols ?? 80);
  }

  write(s: string): void {
    this.grid.feed(s);
  }

  get isTTY(): boolean {
    return true;
  }

  get columns(): number {
    return this.grid.cols;
  }

  get rows(): number {
    return this.grid.rows;
  }

  setRawMode(on: boolean): void {
    this.rawMode = on;
    this.grid.modeLog.push(on ? "raw:on" : "raw:off");
  }

  onResize(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Test helper: viewport change + resize event, in that order (matches stdout). */
  resize(cols: number, rows: number): void {
    this.grid.resize(cols, rows);
    for (const cb of [...this.listeners]) cb();
  }
}
