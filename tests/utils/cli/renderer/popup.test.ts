// Popup (§4 steal 13): pure model -- filtering, selection cycling, accept
// text, render rows with the selection marker, hidden-count hints, width cut.
// The data source is always injected here; wiring lands in 3b.

import { describe, it, expect } from "bun:test";
import { Popup, POPUP_MAX_ROWS } from "@utils/cli/renderer/popup.ts";

const cands = (...labels: string[]) => labels.map((label) => ({ label }));

describe("Popup -- open, filter, select", () => {
  it("openPopup with zero candidates stays closed", () => {
    const p = new Popup();
    p.openPopup([], 0, "");
    expect(p.isOpen).toBe(false);
    expect(p.renderRows(40)).toEqual([]);
  });

  it("non-empty candidates with zero matches never open (no phantom Enter-eater)", () => {
    const p = new Popup();
    p.openPopup(cands("/alpha", "/beta"), 0, "/zz");
    expect(p.isOpen).toBe(false);
    expect(p.renderRows(40)).toEqual([]);
    expect(p.matchCount).toBe(0);
  });

  it("filters case-insensitively on the full span text", () => {
    const p = new Popup();
    p.openPopup(cands("/model", "/models", "/mount", "/help"), 0, "/mo");
    expect(p.matchCount).toBe(3);
    p.setFilter("/moDe");
    expect(p.matchCount).toBe(2);
    p.setFilter("/mox");
    expect(p.matchCount).toBe(0);
    expect(p.exhausted).toBe(true);
  });

  it("next/prev cycle with wraparound", () => {
    const p = new Popup();
    p.openPopup(cands("a", "b", "c"), 0, "");
    expect(p.selectedIndex).toBe(0);
    p.next();
    p.next();
    expect(p.selectedIndex).toBe(2);
    p.next();
    expect(p.selectedIndex).toBe(0); // wraps
    p.prev();
    expect(p.selectedIndex).toBe(2);
  });

  it("filter re-clamps the selection index", () => {
    const p = new Popup();
    p.openPopup(cands("keep", "xa", "xb"), 0, "");
    p.next();
    p.next(); // index 2 ("xb")
    p.setFilter("keep");
    expect(p.selectedIndex).toBe(0);
    expect(p.selectedCompletion?.label).toBe("keep");
  });

  it("accept returns insert-text when present, closes the popup", () => {
    const p = new Popup();
    p.openPopup([{ label: "/skill:commit", insert: "/skill:commit " }, { label: "/skill:review" }], 0, "/sk");
    const acc = p.accept();
    expect(acc?.text).toBe("/skill:commit "); // trailing space from insert
    expect(p.isOpen).toBe(false);
  });

  it("accept with nothing left returns null", () => {
    const p = new Popup();
    p.openPopup(cands("a"), 0, "");
    p.setFilter("zzz");
    expect(p.accept()).toBeNull();
  });
});

describe("Popup -- render rows", () => {
  it("selection marker, two-cell indent, insertion order", () => {
    const p = new Popup();
    p.openPopup(cands("/help", "/history"), 0, "/");
    p.next();
    expect(p.renderRows(40)).toEqual([
      "  /help",
      "> /history",
    ]);
  });

  it("detail rides the label (display-only)", () => {
    const p = new Popup();
    p.openPopup([{ label: "src/", detail: "dir" }], 0, "");
    expect(p.renderRows(40)).toEqual(["> src/ dir"]);
  });

  it("default cap is POPUP_MAX_ROWS with a below-list hint", () => {
    const p = new Popup();
    p.openPopup(cands(...Array.from({ length: 12 }, (_, i) => `item-${i}`)), 0, "");
    const rows = p.renderRows(40);
    expect(rows.length).toBe(POPUP_MAX_ROWS);
    expect(rows[0]).toBe("> item-0");
    expect(rows[rows.length - 1]).toBe("  -5 more");
  });

  it("selection at the bottom keeps the selected row visible with an above hint", () => {
    const p = new Popup();
    p.openPopup(cands(...Array.from({ length: 12 }, (_, i) => `item-${i}`)), 0, "");
    for (let i = 0; i < 11; i++) p.next(); // select item-11
    const rows = p.renderRows(40);
    expect(rows.length).toBe(POPUP_MAX_ROWS);
    expect(rows[rows.length - 1]).toBe("> item-11");
    expect(rows[0]).toBe("  +5 more");
  });

  it("hint rows also appear above AND below for a mid-list selection", () => {
    const p = new Popup();
    p.openPopup(cands(...Array.from({ length: 20 }, (_, i) => `item-${i}`)), 0, "");
    for (let i = 0; i < 10; i++) p.next();
    const rows = p.renderRows(40);
    expect(rows.length).toBe(POPUP_MAX_ROWS);
    expect(rows[0]).toBe("  +7 more");
    expect(rows[rows.length - 1]).toBe("  -7 more");
    expect(rows).toContain("> item-10");
  });

  it("rows are cut to the viewport width without splitting double-wide glyphs", () => {
    const p = new Popup();
    p.openPopup(cands("你好你好你好"), 0, "");
    const rows = p.renderRows(6); // 2 prefix cells + 4 content cells
    expect(rows).toEqual(["> 你好"]);
    expect(rows[0]!.length).toBeLessThanOrEqual(6);
  });

  it("degenerate caps trim the overflow off the BOTTOM (1-2 rows)", () => {
    const p = new Popup();
    p.openPopup(cands("a", "b", "c", "d"), 0, "");
    p.next(); // select "b": hints exist on both sides
    // reality pinned: the tail (selection included) falls off below 3 rows
    expect(p.renderRows(40, 1)).toEqual(["  +1 more"]);
    expect(p.renderRows(40, 2)).toEqual(["  +1 more", "> b"]);
  });
});
