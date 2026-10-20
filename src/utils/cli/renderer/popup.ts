// Popup (design note §4 steal 13): completion candidate rendering + selection
// as a PURE model. The data source is injected -- the frame composer draws the
// rows immediately above the editor block inside the frame (frame h grows;
// the popup is never committed). No command/file logic lives here; stage 3b
// wires the existing core.completion providers (slash names, command args,
// shell-mode) and the path completer through EditorView.openPopup.
//
// Navigation choices (the note does not pin keys; documented 3a decisions):
// Tab cycles forward, Shift-Tab backward, Up/Down cycle WHILE OPEN (they walk
// history only when closed), Enter accepts when open and submits when closed,
// Esc closes when open and interrupts when closed.
//
// Filter-as-you-type: candidates were loaded for a replace span; the text
// typed INTO the span since is the filter (case-insensitive prefix). When the
// filter matches nothing the popup auto-closes with reason "no-match" -- the
// bridge may re-request providers at that point. open() REFUSES a zero-match
// set outright: an open popup painting no rows would still swallow Enter/Esc,
// so "invisible" and "open" never coexist.

import { visibleWidth } from "./width.ts";

export const POPUP_MAX_ROWS = 8;

export interface Completion {
  /** Displayed label. */
  label: string;
  /** Text written into the buffer (defaults to label). */
  insert?: string;
  /** Right-aligned hint (path dirs get "/", argument docs etc.); display only. */
  detail?: string;
}

export interface PopupAccepted {
  completion: Completion;
  text: string;
}

export type PopupCloseReason = "esc" | "no-match" | "edit" | "accept" | "submit" | "interrupt" | "provider";

/**
 * Selection state for one popup session. The span [from, to) names the buffer
 * region open() replaced-toward; accept() swaps the selection into
 * [from, cursorAtAccept) -- the typed prefix included.
 */
export class Popup {
  private candidates: Completion[] = [];
  private filtered: Completion[] = [];
  private spanFrom = 0;
  private selected = 0;
  private open = false;

  get isOpen(): boolean {
    return this.open;
  }

  get count(): number {
    return this.candidates.length;
  }

  get matchCount(): number {
    return this.filtered.length;
  }

  get selectedIndex(): number {
    return this.selected;
  }

  get from(): number {
    return this.spanFrom;
  }

  /** The selection after filtering; undefined when nothing matches. */
  get selectedCompletion(): Completion | undefined {
    return this.filtered[this.selected];
  }

  openPopup(candidates: Completion[], spanFrom: number, prefix: string): void {
    if (candidates.length === 0) {
      this.close();
      return;
    }
    this.candidates = candidates;
    this.spanFrom = spanFrom;
    this.open = true;
    this.setFilter(prefix);
    if (this.filtered.length === 0) this.close(); // refuse the phantom popup
  }

  close(): void {
    this.open = false;
    this.candidates = [];
    this.filtered = [];
    this.selected = 0;
  }

  /** Full span text typed so far (open() prefix + typed continuation). */
  setFilter(spanText: string): void {
    const needle = spanText.toLowerCase();
    this.filtered = this.candidates.filter(
      (c) => c.label.toLowerCase().startsWith(needle) || (c.insert ?? c.label).toLowerCase().startsWith(needle),
    );
    if (this.selected >= this.filtered.length) this.selected = 0;
  }

  next(): void {
    if (this.filtered.length === 0) return;
    this.selected = (this.selected + 1) % this.filtered.length;
  }

  prev(): void {
    if (this.filtered.length === 0) return;
    this.selected = (this.selected - 1 + this.filtered.length) % this.filtered.length;
  }

  /** Take the current selection; the caller writes `text` into the buffer. */
  accept(): PopupAccepted | null {
    const c = this.filtered[this.selected];
    if (!c) return null;
    const accepted = { completion: c, text: c.insert ?? c.label };
    this.close();
    return accepted;
  }

  /**
   * Frame rows: at most maxRows total, one selected, selection kept visible.
   * A "+N more"/"-N more" hint row replaces a candidate slot when the list is
   * truncated. Rows are cut to `width` cells (wide glyphs never split; the
   * stage-2 wrap utility does the cutting).
   */
  renderRows(width: number, maxRows = POPUP_MAX_ROWS): string[] {
    if (!this.open || this.filtered.length === 0) return [];
    const cap = Math.max(1, maxRows);
    const build = (want: number): { start: number; end: number } => {
      let start = Math.max(0, this.selected - Math.floor(want / 2));
      start = Math.min(start, Math.max(0, this.filtered.length - want));
      return { start, end: Math.min(this.filtered.length, start + want) };
    };
    let want = Math.min(this.filtered.length, cap);
    let { start, end } = build(want);
    const hints = (start > 0 ? 1 : 0) + (end < this.filtered.length ? 1 : 0);
    if (hints > 0 && want + hints > cap) {
      want = Math.max(1, cap - hints);
      ({ start, end } = build(want));
    }
    const rows: string[] = [];
    if (start > 0) rows.push(`  +${start} more`);
    for (let i = start; i < end; i++) {
      const c = this.filtered[i]!;
      const label = c.detail ? `${c.label} ${c.detail}` : c.label;
      rows.push(`${i === this.selected ? ">" : " "} ${label}`);
    }
    if (end < this.filtered.length) rows.push(`  -${this.filtered.length - end} more`);
    // overflow trims off the BOTTOM: with hints on both sides and a 1-2 row
    // cap the tail falls off (at cap 1 only the above-hint survives); a popup
    // below 3 rows carries no usable selection UI anyway.
    return rows.slice(0, cap).map((r) => cutToWidth(r, width));
  }

  /** True when the filter killed every candidate: auto-close signal. */
  get exhausted(): boolean {
    return this.open && this.filtered.length === 0;
  }
}

/** Hard-cut a row to w cells using the stage-2 width table (no wrap, no padding). */
function cutToWidth(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let out = "";
  let acc = 0;
  for (const ch of s) {
    const cw = visibleWidth(ch);
    if (acc + cw > w) break;
    out += ch;
    acc += cw;
  }
  return out;
}
