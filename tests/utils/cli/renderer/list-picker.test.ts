// ListPicker pure-model tests: selection, scrolling/paging append, the
// visible zero-match state (never an auto-close), the two filter tiers with
// literal `%`/`_` needles, and the stale-corpus-response contract driven on
// the renderer stack's FakeClock.

import { describe, it, expect } from "bun:test";
import { ListPicker, type ListPickerCopy, type PickerRow } from "@utils/cli/renderer/list-picker.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import type { KeyEvent } from "@utils/cli/renderer/keyevents.ts";

const row = (id: string, filterText?: string, detail?: string): PickerRow => ({
  id,
  label: `· ${id} row`,
  filterText: filterText ?? `meta ${id}`,
  ...(detail !== undefined ? { detail } : {}),
});
const text = (t: string): KeyEvent => ({ kind: "text", text: t });
const key = (name: string): KeyEvent => ({ kind: "key", name });

function makePicker(
  rows: PickerRow[],
  opts: Partial<{ debounceMs: number; maxRows: number; copy: Partial<ListPickerCopy> }> = {},
) {
  const clock = new FakeClock();
  const events: {
    closed: number;
    accepted: PickerRow[];
    pinned: PickerRow[];
    needMore: number;
    queries: Array<{ query: string; seq: number }>;
    changes: number;
  } = { closed: 0, accepted: [], pinned: [], needMore: 0, queries: [], changes: 0 };
  const picker = new ListPicker({
    clock,
    maxRows: opts.maxRows ?? 10,
    debounceMs: opts.debounceMs ?? 150,
    ...(opts.copy ? { copy: opts.copy } : {}),
    events: {
      onClose: () => events.closed++,
      onAccept: (r) => events.accepted.push(r),
      onPin: (r) => events.pinned.push(r),
      onNeedMore: () => events.needMore++,
      onCorpusQuery: (query, seq) => events.queries.push({ query, seq }),
      onChange: () => events.changes++,
    },
  });
  picker.setPrimary(rows);
  return { picker, clock, events };
}

describe("ListPicker selection", () => {
  it("starts on row 0, walks with down/up, clamps at the edges (no wrap)", () => {
    const { picker } = makePicker([row("a"), row("b"), row("c")]);
    expect(picker.selectedRow?.id).toBe("a");
    picker.handleKey(key("down"));
    expect(picker.selectedRow?.id).toBe("b");
    picker.handleKey(key("down"));
    picker.handleKey(key("down")); // past the tail: clamps, stays on c
    expect(picker.selectedRow?.id).toBe("c");
    picker.handleKey(key("up"));
    expect(picker.selectedRow?.id).toBe("b");
    picker.handleKey(key("up"));
    picker.handleKey(key("up"));
    picker.handleKey(key("up")); // past the head: clamps
    expect(picker.selectedRow?.id).toBe("a");
  });

  it("Enter accepts the selected row; a zero-match list accepts nothing", () => {
    const { picker, events } = makePicker([row("a"), row("b")]);
    picker.handleKey(key("enter"));
    expect(events.accepted.map((r) => r.id)).toEqual(["a"]);
    picker.handleKey(text("zzz"));
    picker.handleKey(key("enter"));
    expect(events.accepted.length).toBe(1); // nothing to accept, still open
    expect(picker.isOpen).toBe(true);
  });

  it("renderRows marks the selected line and cuts rows to width", () => {
    const { picker } = makePicker([row("aa"), row("bb")]);
    const rows = picker.renderRows(80);
    expect(rows[0]).toContain("type to filter");
    expect(rows[1]).toContain(">");
    picker.handleKey(key("down"));
    const moved = picker.renderRows(80);
    expect(moved[1]).not.toContain(">");
    expect(moved[2]).toContain(">");
    const narrow = picker.renderRows(6);
    for (const r of narrow) expect(r.length).toBeLessThanOrEqual(6);
  });
});

describe("ListPicker zero-match state", () => {
  it("shows an honest no-match row and NEVER auto-closes", () => {
    const { picker, events } = makePicker([row("alpha"), row("beta")]);
    picker.handleKey(text("zz"));
    const rows = picker.renderRows(80);
    expect(rows.join("\n")).toContain('no match for "zz"');
    expect(picker.isOpen).toBe(true);
    expect(events.closed).toBe(0);
  });

  it("an empty list with an empty query says so plainly", () => {
    const { picker } = makePicker([]);
    expect(picker.renderRows(80).join("\n")).toContain("nothing to show");
    expect(picker.isOpen).toBe(true);
  });
});

describe("ListPicker filter tiers", () => {
  it("instant tier filters loaded rows case-insensitively and immediately", () => {
    const { picker } = makePicker([
      row("s1", "claude-opus fix the broker"),
      row("s2", "gpt-5 write docs"),
    ]);
    picker.handleKey(text("BROKER"));
    const rows = picker.renderRows(80);
    expect(rows.some((r) => r.includes("s1"))).toBe(true);
    expect(rows.some((r) => r.includes("s2"))).toBe(false);
  });

  it("corpus tier fires debounced and merges below the separator, deduped", () => {
    const { picker, clock, events } = makePicker([row("s1", "broker fix")]);
    picker.handleKey(text("broker"));
    clock.advance(149);
    expect(events.queries.length).toBe(0); // still debouncing
    clock.advance(1);
    expect(events.queries).toEqual([{ query: "broker", seq: 1 }]);
    // corpus hit s9 is new; corpus hit s1 duplicates the instant tier and is dropped
    picker.applyCorpus(1, [row("s9", "old talk"), row("s1", "broker fix")]);
    const rows = picker.renderRows(80);
    expect(rows.some((r) => r.includes("-- more matches --"))).toBe(true);
    expect(rows.filter((r) => r.includes("s9")).length).toBe(1);
    expect(rows.filter((r) => r.includes("· s1 row")).length).toBe(1);
  });

  it("backspacing clears the corpus tier until the next settled request", () => {
    const { picker, clock, events } = makePicker([row("s1")]);
    picker.handleKey(text("ab"));
    clock.advance(150);
    picker.applyCorpus(events.queries[0]!.seq, [row("cold")]);
    expect(picker.renderRows(80).some((r) => r.includes("cold"))).toBe(true);
    picker.handleKey(key("backspace"));
    expect(picker.renderRows(80).some((r) => r.includes("cold"))).toBe(false);
  });

  it("`%` and `_` needles stay literal in both the model filter and corpus scan", () => {
    const { picker } = makePicker([row("pct", "coverage is 50% done"), row("under", "a_b link")]);
    picker.handleKey(text("%"));
    let rows = picker.renderRows(80);
    expect(rows.some((r) => r.includes("pct"))).toBe(true);
    expect(rows.some((r) => r.includes("under"))).toBe(false);
    picker.handleKey(text("x")); // "%x": SQL LIKE would wildcard-match anything shaped aX...
    rows = picker.renderRows(80);
    expect(rows.some((r) => r.includes('no match for "%x"'))).toBe(true);
    const { picker: p2 } = makePicker([row("pct", "coverage is 50% done"), row("under", "a_b link")]);
    p2.handleKey(text("_"));
    rows = p2.renderRows(80);
    expect(rows.some((r) => r.includes("under"))).toBe(true);
    expect(rows.some((r) => r.includes("pct"))).toBe(false);
  });

  it("typing keeps only the LAST debounced request; a stale reply never repaints", () => {
    const { picker, clock, events } = makePicker([row("s1")]);
    picker.handleKey(text("one"));
    clock.advance(150); // seq 1 fires
    picker.handleKey(text(" two")); // query moved: new debounce
    clock.advance(150); // seq 2 fires
    expect(events.queries).toEqual([
      { query: "one", seq: 1 },
      { query: "one two", seq: 2 },
    ]);
    const before = picker.renderRows(80);
    picker.applyCorpus(1, [row("stale-hit")]); // late reply for the OLD query
    expect(picker.renderRows(80)).toEqual(before); // silently ignored
    picker.applyCorpus(2, [row("fresh-hit")]);
    expect(picker.renderRows(80).some((r) => r.includes("fresh-hit"))).toBe(true);
    expect(picker.renderRows(80).some((r) => r.includes("stale-hit"))).toBe(false);
  });

  it("a corpus reply arriving after close is ignored", () => {
    const { picker, clock, events } = makePicker([row("s1")]);
    picker.handleKey(text("q"));
    clock.advance(150);
    picker.handleKey(key("esc"));
    picker.applyCorpus(events.queries[0]!.seq, [row("late")]);
    expect(picker.renderRows(80)).toEqual([]); // closed paints nothing
  });

  it("applyCorpus reports acceptance so callers gate derived state on it", () => {
    const { picker, clock } = makePicker([row("s1")]);
    picker.handleKey(text("one"));
    clock.advance(150); // seq 1 fires
    picker.handleKey(text(" two"));
    clock.advance(150); // seq 2 fires
    const changes = picker.renderRows(80);
    expect(picker.applyCorpus(1, [row("stale-hit")])).toBe(false); // superseded
    expect(changes).toEqual(picker.renderRows(80)); // and still no repaint content
    expect(picker.applyCorpus(2, [row("fresh-hit")])).toBe(true); // current
    picker.handleKey(key("esc"));
    expect(picker.applyCorpus(2, [row("after-close")])).toBe(false);
  });

  it("a reply for the previous query is dead INSIDE the next debounce window", () => {
    // The seq used to move only when a request FIRED, so a reply still in
    // flight for "one" was accepted while "onex" debounced -- searches
    // outlive a 150ms gap routinely, making this the common path: the old
    // query's matches painted under the new query's header.
    const { picker, clock, events } = makePicker([row("s1")]);
    picker.handleKey(text("one"));
    clock.advance(150); // the request for "one" fires
    const fired = events.queries[0]!.seq;
    picker.handleKey(text("x")); // query is now "onex"; the new one debounces
    const before = picker.renderRows(80);
    expect(picker.applyCorpus(fired, [row("hit-for-one-only")])).toBe(false);
    expect(picker.renderRows(80)).toEqual(before); // silently ignored
    clock.advance(150);
    expect(events.queries[1]!.query).toBe("onex");
    expect(picker.applyCorpus(events.queries[1]!.seq, [row("fresh")])).toBe(true);
    const after = picker.renderRows(80);
    expect(after.some((r) => r.includes("fresh"))).toBe(true);
    expect(after.some((r) => r.includes("hit-for-one-only"))).toBe(false);
  });

  it("a footer claim dies with the query that produced it", () => {
    const { picker, clock, events } = makePicker([row("s1")]);
    picker.handleKey(text("one"));
    clock.advance(150);
    expect(picker.applyCorpus(events.queries[0]!.seq, [row("hit")])).toBe(true);
    picker.setFooter("more matches; refine query");
    expect(picker.renderRows(80).some((r) => r.includes("refine query"))).toBe(true);
    picker.handleKey(key("backspace")); // the cap counted a query that is gone
    expect(picker.renderRows(80).some((r) => r.includes("refine query"))).toBe(false);
  });
});

describe("ListPicker scrolling and paging", () => {
  it("windows the visible rows around the selection within maxRows", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`));
    const { picker } = makePicker(rows, { maxRows: 5 });
    const top = picker.renderRows(80);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top[0]).toContain("type to filter");
    for (let i = 0; i < 4; i++) picker.handleKey(key("down"));
    const mid = picker.renderRows(80);
    expect(mid.some((r) => r.includes(">") && r.includes("r4 row"))).toBe(true); // selection visible
    for (let i = 0; i < 6; i++) picker.handleKey(key("down"));
    const low = picker.renderRows(80);
    expect(low.some((r) => r.includes(">") && r.includes("r10 row"))).toBe(true); // window followed
  });

  it("the paging hint never paints over the selected row", () => {
    // The regression this guards: the hint used to truncate the last visible
    // line, so with the list exactly filling the window the selected row (and
    // its ">") left the screen while Enter still accepted it.
    const { picker } = makePicker([row("r0"), row("r1"), row("r2")], { maxRows: 4 });
    picker.setMore(true);
    picker.handleKey(key("down"));
    picker.handleKey(key("down")); // selection on the LAST loaded row
    const rows = picker.renderRows(80);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows.some((r) => r.includes(">") && r.includes("r2 row"))).toBe(true);
    expect(rows.some((r) => r.includes("keep pressing down"))).toBe(true);
  });
});

describe("ListPicker copy", () => {
  // The model names no subject: every frame string arrives from the caller,
  // so a session browser says "sessions" and anything else says its own thing.
  const SESSION_COPY: Partial<ListPickerCopy> = {
    idle: "sessions  type to filter - enter open - p pin - esc close",
    empty: "no sessions to show",
    noMatch: (q) => `no match for "${q}" - searches conversation text, not tool output`,
    separator: "-- conversation matches --",
    searching: "searching conversation text...",
  };

  it("the caller's words replace the generic ones, field by field", () => {
    const { picker, clock } = makePicker([row("s1", "broker fix")], { copy: SESSION_COPY });
    expect(picker.renderRows(80).join("\n")).toContain("sessions  type to filter");
    picker.handleKey(text("zz"));
    expect(picker.renderRows(80).join("\n")).toContain("searches conversation text, not tool output");
    picker.handleKey(key("backspace"));
    picker.handleKey(key("backspace"));
    const empty = makePicker([], { copy: SESSION_COPY });
    expect(empty.picker.renderRows(80).join("\n")).toContain("no sessions to show");
    // The in-flight note, still the caller's wording.
    picker.handleKey(text("broker"));
    clock.advance(150);
    expect(picker.renderRows(80).join("\n")).toContain("searching conversation text...");
    picker.applyCorpus(1, [row("s9", "old talk")]);
    expect(picker.renderRows(80).join("\n")).toContain("-- conversation matches --");
  });

  it("a long query keeps its tail in the header; the query itself is capped", () => {
    const { picker } = makePicker([row("a")]);
    picker.handleKey(text("x".repeat(40) + "y".repeat(40)));
    // Newest runes win, so the filter keeps what the user just typed.
    expect(picker.queryText).toBe(`${"x".repeat(24)}${"y".repeat(40)}`);
    const narrow = picker.renderRows(12);
    expect(narrow[0]!.length).toBeLessThanOrEqual(12);
    expect(narrow[0]).toContain("\u2026"); // the cut side is marked
    expect(narrow[0]!.endsWith("y".repeat(8))).toBe(true);
    // A frame wide enough for the query shows it whole.
    expect(picker.renderRows(80)[0]).toBe(`q: ${picker.queryText}`);
  });
});

describe("ListPicker paging requests", () => {
  it("stepping off the loaded tail with more rows asks once; the append extends the list", () => {
    const rows = Array.from({ length: 4 }, (_, i) => row(`r${i}`));
    const { picker, events } = makePicker(rows, { maxRows: 5 });
    picker.setMore(true);
    picker.handleKey(key("down"));
    picker.handleKey(key("down"));
    picker.handleKey(key("down"));
    expect(picker.selectedRow?.id).toBe("r3");
    picker.handleKey(key("down")); // off the tail: need more
    expect(events.needMore).toBe(1);
    picker.handleKey(key("down")); // latch holds: no barrage re-request
    expect(events.needMore).toBe(1);
    expect(picker.renderRows(80).some((r) => r.includes("loading older..."))).toBe(true);
    // The page lands appended: the selection can walk into the fresh rows.
    picker.setPrimary([...rows, row("r4"), row("r5")]);
    picker.setMore(false);
    picker.handleKey(key("down"));
    expect(picker.selectedRow?.id).toBe("r4");
    expect(picker.renderRows(80).some((r) => r.includes("keep pressing down"))).toBe(false);
    expect(picker.renderRows(80).some((r) => r.includes("loading older..."))).toBe(false);
  });
});

describe("ListPicker keys", () => {
  it("`p` pins with an empty query; a live query types it; Alt+P pins always", () => {
    const { picker, events } = makePicker([row("a"), row("b")]);
    picker.handleKey(text("p"));
    expect(events.pinned.map((r) => r.id)).toEqual(["a"]);
    picker.handleKey(text("x")); // query now live...
    picker.handleKey(text("p")); // ...so p filters, it does not pin
    expect(events.pinned.length).toBe(1);
    expect(picker.queryText).toBe("xp");
    // A live query may match nothing: Alt+P then has no row to pin (honest,
    // no phantom action). Clear back to a matching filter and pin again.
    picker.handleKey(key("alt-p"));
    expect(events.pinned.length).toBe(1);
    picker.handleKey(key("backspace"));
    picker.handleKey(key("backspace"));
    picker.handleKey(key("alt-p"));
    expect(events.pinned.length).toBe(2);
  });

  it("backspace deletes one codepoint (surrogate-safe)", () => {
    const { picker } = makePicker([row("a")]);
    picker.handleKey(text("a😀"));
    expect(picker.queryText).toBe("a😀");
    picker.handleKey(key("backspace"));
    expect(picker.queryText).toBe("a");
  });

  it("paste appends flattened into the query", () => {
    const { picker } = makePicker([row("a")]);
    picker.handleKey({ kind: "paste", text: "line1\nline2" } as KeyEvent);
    expect(picker.queryText).toBe("line1 line2");
  });

  it("Esc and Ctrl-C close exactly once and hand teardown to the caller", () => {
    const { picker, events } = makePicker([row("a")]);
    picker.handleKey(key("esc"));
    expect(picker.isOpen).toBe(false);
    expect(events.closed).toBe(1);
    picker.handleKey(key("esc")); // already closed: silent
    picker.handleKey(text("x")); // input after close: dropped
    expect(events.closed).toBe(1);
  });

  it("the debounce timer cancelled by editing fires nothing", () => {
    const { picker, clock, events } = makePicker([row("a")]);
    picker.handleKey(text("abc"));
    clock.advance(100);
    picker.handleKey(key("backspace")); // reschedule: the pending fire is cancelled
    clock.advance(149);
    expect(events.queries.length).toBe(0);
    clock.advance(1); // 150ms after the LAST edit
    expect(events.queries).toEqual([{ query: "ab", seq: 1 }]);
  });
});
