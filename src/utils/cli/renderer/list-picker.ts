// ListPicker: a generic filtered-list browser as a PURE model, beside popup.ts.
// Rows arrive pre-composed (the caller owns the data source and the column
// grammar) and the frame's wording arrives through `copy` -- the header, the
// empty and no-match states, the tier separator, the in-flight note; keys
// arrive as KeyEvents; the debounce rides the injected Clock. Nothing here
// knows about sessions, the editor buffer, or the process.
//
// Deliberate differences from Popup (the browsing job inverts the completion
// posture):
// - A zero-match state SHOWS an honest no-match row. Popup refuses/closes on
//   zero matches because an invisible open popup would swallow Enter/Esc in a
//   completion flow; a browser that vanishes on no-match instead hides the
//   only evidence a search ran at all.
// - It never writes anywhere: Enter reports the selected row and the caller
//   decides what opening means; closing is the caller's teardown.
// - Paging: rows append BELOW the visible window (stepping off the bottom of
//   the loaded tail fires onNeedMore once); selection clamps instead of
//   wrapping -- a wrapped selection on a paged list hides the page seam.
// - Two-tier filter over the typed query: the instant tier is a
//   case-insensitive SUBSTRING (never a glob or SQL LIKE: `%` and `_` stay
//   literal characters) over the loaded rows' filterText; the corpus tier is
//   delegated -- after a quiet window of `debounceMs` the picker fires
//   onCorpusQuery(query, seq). Correlation is the seq AND the query that
//   request went out for: applyCorpus is a silent no-op unless both still
//   name the live request, so a reply that lands after the user backspaced
//   -- including one still in flight inside the next debounce window, where
//   the seq has not moved yet -- never repaints.

import type { KeyEvent } from "./keyevents.ts";
import type { Clock } from "./seams.ts";
import { cutToWidth } from "./popup.ts";
import { visibleWidth } from "./width.ts";

export const LIST_PICKER_MAX_ROWS = 10;
export const LIST_PICKER_DEBOUNCE_MS = 150;

/** Query ceiling. The header paints the query's TAIL (that is what typing
 *  produces), so an unbounded paste would grow a line nobody can read; the
 *  newest runes win. */
const QUERY_MAX_RUNES = 64;

/** Frame copy, supplied by the caller: the model names no subject. */
export interface ListPickerCopy {
  /** Header while no query is live (the key legend). */
  idle: string;
  /** Header prefix once a query is live: rendered as `${prefix}${query}`. */
  queryPrefix: string;
  /** Empty list with an empty query. */
  empty: string;
  /** Nothing matched `query`. */
  noMatch: (query: string) => string;
  /** Line above the second (delegated) tier. */
  separator: string;
  /** Note while a delegated request is in flight. */
  searching: string;
}

const GENERIC_COPY: ListPickerCopy = {
  idle: "type to filter - enter open - esc close",
  queryPrefix: "q: ",
  empty: "nothing to show",
  noMatch: (query) => `no match for "${query}"`,
  separator: "-- more matches --",
  searching: "searching...",
};

export interface PickerRow {
  /** Identity for dedupe and routing (the session id). */
  id: string;
  /** Composed display line (glyph, columns, title -- all upstream policy). */
  label: string;
  /** Optional second line rendered under the label (a corpus snippet). */
  detail?: string;
  /** Case-folded substring material for the instant tier (id, model,
   *  profile, title -- the displayed metadata). */
  filterText: string;
}

export interface ListPickerEvents {
  /** Enter on a row. The picker does NOT close: opening may fail, and a
   *  refused accept must leave the list up. */
  onAccept?: (row: PickerRow) => void;
  /** Esc or ctrl-c pressed; the picker already closed itself, the caller
   *  tears the overlay down and repaints. */
  onClose: () => void;
  /** Stepping down off the last loaded row while more rows exist. Fires
   *  once until the next setPrimary (a barrage of Down keys cannot
   *  re-request the same page). */
  onNeedMore?: () => void;
  /** `p` (with an empty query) or Alt+P: toggle the row's pin. */
  onPin?: (row: PickerRow) => void;
  /** Debounced corpus request; answer with applyCorpus(sameSeq, rows). */
  onCorpusQuery?: (query: string, seq: number) => void;
  /** Any consumed key: the caller repaints the frame. */
  onChange?: () => void;
}

export interface ListPickerOptions {
  clock: Clock;
  events: ListPickerEvents;
  /** Frame rows the picker may paint, header, tail hints and footer included. */
  maxRows?: number;
  debounceMs?: number;
  /** Frame wording; omitted fields fall back to the generic strings. */
  copy?: Partial<ListPickerCopy>;
}

/** A rendered frame line; selectable lines carry their row index. */
interface PickerLine {
  text: string;
  rowIndex: number | null;
}

export class ListPicker {
  private readonly clock: Clock;
  private readonly events: ListPickerEvents;
  private readonly maxRows: number;
  private readonly debounceMs: number;
  private readonly copy: ListPickerCopy;

  private primary: PickerRow[] = [];
  private corpus: PickerRow[] = [];
  private query = "";
  private selected = 0;
  private more = false;
  private loadingMore = false;
  private footer: string | null = null;
  private searchPending = false;
  private seq = 0;
  /** The query the current seq's request went out for (null: nothing fired).
   *  The seq only moves when a request fires, so this is what keeps a reply
   *  for an edited-away query from landing inside the next debounce window. */
  private firedQuery: string | null = null;
  private timer: unknown = null;
  private open = true;

  constructor(opts: ListPickerOptions) {
    this.clock = opts.clock;
    this.events = opts.events;
    this.maxRows = Math.max(3, opts.maxRows ?? LIST_PICKER_MAX_ROWS);
    this.debounceMs = Math.max(0, opts.debounceMs ?? LIST_PICKER_DEBOUNCE_MS);
    this.copy = { ...GENERIC_COPY, ...opts.copy };
  }

  get isOpen(): boolean {
    return this.open;
  }

  get queryText(): string {
    return this.query;
  }

  /** The row Enter would accept (null while nothing matches). */
  get selectedRow(): PickerRow | null {
    return this.selectable()[this.selected] ?? null;
  }

  /** Replace the loaded primary set (paging re-calls with the appended
   *  list). Clears the needMore latch so the bottom edge can ask again. */
  setPrimary(rows: PickerRow[]): void {
    this.primary = rows;
    this.loadingMore = false;
    this.clampSelection();
    this.changed();
  }

  /** Older rows exist below the loaded set (the page walk has a cursor). */
  setMore(v: boolean): void {
    this.more = v;
    this.changed();
  }

  /** Honest tail line (e.g. "more matches; refine query"). A query edit clears
   *  it: the claim describes the query that produced it. */
  setFooter(text: string | null): void {
    this.footer = text;
    this.changed();
  }

  /** Answer a fired onCorpusQuery. A reply is dead, dropped WITHOUT
   *  repainting, once the picker closed, once a newer request went out, or
   *  once the query moved after THIS request went out -- that last case is
   *  the debounce window, where the seq still names the previous request.
   *  Returns whether the reply was accepted; derived state (footer lines
   *  etc.) must follow that boolean, not the arrival of the reply itself. */
  applyCorpus(seq: number, rows: PickerRow[]): boolean {
    if (!this.open || seq !== this.seq || this.firedQuery !== this.query.trim()) return false;
    this.searchPending = false;
    this.corpus = rows;
    this.clampSelection();
    this.changed();
    return true;
  }

  /** Consume one injected key event (text, paste, or key). While the picker
   *  is mounted every key belongs to it; unmapped keys are consumed silently
   *  rather than leaking to the line editor. */
  handleKey(e: KeyEvent): void {
    if (!this.open) return;
    if (e.kind === "text" || e.kind === "paste") {
      // `p` is the action key while browsing (empty query); the moment a
      // query is live, every printable character -- including p -- filters.
      // Alt+P pins in both states.
      if (e.kind === "text" && e.text === "p" && this.query === "" && this.events.onPin) {
        const row = this.selectedRow;
        if (row) this.events.onPin(row);
        this.changed();
        return;
      }
      const flat = e.text.replace(/[\r\n]+/g, " ");
      if (flat !== "") {
        const runes = Array.from(this.query + flat);
        this.query = runes.length > QUERY_MAX_RUNES
          ? runes.slice(runes.length - QUERY_MAX_RUNES).join("")
          : runes.join("");
        this.afterQueryEdit();
      }
      this.changed();
      return;
    }
    switch (e.name.toLowerCase()) {
      case "up":
        this.move(-1);
        return;
      case "down":
        this.move(1);
        return;
      case "enter":
      case "ctrl-j": {
        const row = this.selectedRow;
        if (row && this.events.onAccept) this.events.onAccept(row);
        return;
      }
      case "backspace": {
        const runes = Array.from(this.query);
        if (runes.length === 0) return;
        this.query = runes.slice(0, -1).join("");
        this.afterQueryEdit();
        this.changed();
        return;
      }
      case "alt-p": {
        const row = this.selectedRow;
        if (row && this.events.onPin) this.events.onPin(row);
        this.changed();
        return;
      }
      case "esc":
      case "interrupt":
        this.close();
        this.events.onClose();
        return;
      default:
        // Consumed: the editor must not receive a keystroke the picker ate.
        return;
    }
  }

  close(): void {
    this.open = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Instant tier: literal case-insensitive substring over filterText. */
  private filtered(): PickerRow[] {
    const needle = this.query.toLowerCase();
    if (needle === "") return this.primary;
    return this.primary.filter((r) => r.filterText.toLowerCase().includes(needle));
  }

  /** Corpus tier as displayed: deduped against the visible instant rows. */
  private corpusShown(): PickerRow[] {
    if (this.query.trim() === "") return [];
    const primaryIds = new Set(this.filtered().map((r) => r.id));
    return this.corpus.filter((r) => !primaryIds.has(r.id));
  }

  private selectable(): PickerRow[] {
    return [...this.filtered(), ...this.corpusShown()];
  }

  private clampSelection(): void {
    const list = this.selectable();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
  }

  private move(delta: number): void {
    const list = this.selectable();
    if (list.length === 0) return;
    const next = this.selected + delta;
    if (next < 0) return;
    if (next >= list.length) {
      this.selected = list.length - 1;
      if (delta > 0 && this.more && !this.loadingMore) {
        this.loadingMore = true;
        this.events.onNeedMore?.();
      }
      this.changed();
      return;
    }
    this.selected = next;
    this.changed();
  }

  private afterQueryEdit(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    // A stale corpus never survives a query edit -- only the instant tier
    // repaints until the new request settles (applyCorpus drops the reply that
    // is already in flight for the previous query). The footer's claim -- a
    // cap, a failure -- describes the query that produced it, so it goes too.
    this.corpus = [];
    this.searchPending = false;
    this.footer = null;
    const q = this.query.trim();
    if (q !== "") {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        if (!this.open) return;
        this.seq += 1;
        this.firedQuery = q;
        this.searchPending = true;
        this.events.onCorpusQuery?.(q, this.seq);
      }, this.debounceMs);
    }
    this.clampSelection();
  }

  private changed(): void {
    this.events.onChange?.();
  }

  /** Header line: the legend, or the live query. A query longer than the
   *  frame keeps its TAIL (the newest typing is what the user is reading)
   *  with the cut side marked. */
  private headerLine(width: number): string {
    if (this.query === "") return cutToWidth(this.copy.idle, width);
    const full = `${this.copy.queryPrefix}${this.query}`;
    if (visibleWidth(full) <= width) return full;
    const room = Math.max(1, width - visibleWidth(this.copy.queryPrefix) - 1);
    const tail = Array.from(this.query).slice(-room).join("");
    return cutToWidth(`${this.copy.queryPrefix}\u2026${tail}`, width);
  }

  /**
   * Frame lines: header, the instant section, a separator and the corpus
   * section (deduped), then the optional honest footer. The window keeps the
   * selected row visible (details cost a line each); every persistent tail
   * line (footer, the searching note, the paging hint) is reserved OUT of the
   * row budget -- a hint that truncated a row could hide the selected one.
   */
  renderRows(width: number, maxRows = this.maxRows): string[] {
    if (!this.open) return [];
    const pending = this.searchPending && this.query.trim() !== "";
    const budget = Math.max(
      1,
      maxRows - 1 - (this.footer ? 1 : 0) - (pending ? 1 : 0) - (this.more ? 1 : 0),
    );

    const lines: PickerLine[] = [];
    const add = (text: string, rowIndex: number | null = null): void => {
      lines.push({ text, rowIndex });
    };

    const rows = this.selectable();
    if (rows.length === 0) {
      add(
        this.query.trim() === ""
          ? `  ${this.copy.empty}`
          : `  ${this.copy.noMatch(this.query)}`,
      );
    } else {
      const primaryCount = this.filtered().length;
      rows.forEach((r, i) => {
        if (i === primaryCount) add(`  ${this.copy.separator}`);
        add(`${i === this.selected ? ">" : " "} ${r.label}`, i);
        if (r.detail) add(`  ${r.detail}`);
      });
    }

    // Window: keep the selected line on screen; small lists never scroll.
    let top = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.rowIndex === this.selected && i >= top + budget) top = i - budget + 1;
    }
    const visible = lines.slice(top, top + budget);
    const out = [this.headerLine(width), ...visible.map((l) => l.text)];
    if (this.more && top + budget >= lines.length) {
      // The tail is in view and more rows exist: name the affordance (the
      // request itself latches until the appended page lands).
      out.push(this.loadingMore ? "  loading older..." : "  keep pressing down for older rows");
    }
    if (pending) out.push(`  ${this.copy.searching}`);
    if (this.footer !== null) out.push(this.footer);
    return out.map((r) => cutToWidth(r, width));
  }
}
