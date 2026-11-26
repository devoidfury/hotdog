// Structural pins on styles.css (the
// dom-helper has no CSSOM, same doctrine as webui-file-view-foot-css.test.ts):
//
//   (A) FULL HEIGHT: a file tab (editor or read-only viewer) owns the WHOLE
//       pane. #workbench-body must stop being the scroller for those kinds and
//       become a definite-height flex COLUMN (overflow hidden), the tab body a
//       flex:1 column, the sheet flex:1 -- a ratio chain, no magic px. The tree
//       tab keeps #workbench-body's own y-scroll (unchanged). --bg-canvas paints
//       the empty area, --bg-surface-2 must never show between content and bar.
//
//   (B) CARET CELL MODEL: the caret/hit cell needs one code unit == one
//       fixed advance, i.e. a MONOSPACE face with ligatures OFF and no
//       letter-spacing. The code renders in .editor; the probe that measures
//       the advance (.editor-measure) must inherit the SAME chain, else the
//       caret drifts by (measured - real) x column.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The tab-stop pin binds the CSS number to the EXPORTED model constant.
import { TAB_STOP } from "../../src/extensions/webui/ui/editor-buffer";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** The body of the rule whose selector line is exactly `sel {` (any indent,
 *  first match), comments stripped. */
function declarations(sel: string): string {
  const lines = CSS.split("\n");
  const idx = lines.findIndex((l) => l.trim() === `${sel} {`);
  if (idx < 0) throw new Error(`rule ${sel} missing from styles.css`);
  let body = "";
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i]!.includes("}")) break;
    body += lines[i] + "\n";
  }
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("workbench file tabs own the full pane (styles.css)", () => {
  it("the tree/empty default still scrolls in #workbench-body", () => {
    expect(declarations("#workbench-body")).toContain("overflow-y: auto");
  });

  it("editor + viewer tabs: #workbench-body is a non-scrolling flex column", () => {
    // The compound rule ends its selector list on this line with `{`.
    const body = declarations("#workbench-body:has(.file-view)");
    expect(CSS).toMatch(/#workbench-body:has\(\.editor\),\s*\n\s*#workbench-body:has\(\.file-view\)\s*\{/);
    expect(body).toContain("display: flex");
    expect(body).toContain("flex-direction: column");
    expect(body).toContain("overflow: hidden"); // no double scrollbar
  });

  it("the tab body fills the pane as a flex:1 column", () => {
    const body = declarations("#workbench-body:has(.file-view) .workbench-tab-body");
    expect(body).toContain("display: flex");
    expect(body).toContain("flex: 1");
    expect(body).toContain("min-height: 0");
  });

  it("the editor is a flex column (viewport flexes, bar is the last row)", () => {
    const body = declarations(".editor");
    expect(body).toContain("display: flex");
    expect(body).toContain("flex-direction: column");
    expect(body).toContain("flex: 1");
    expect(body).toContain("min-height: 0");
    expect(body).not.toContain("height: 100%"); // no content-sized collapse
  });

  it("the editor viewport scrolls itself and paints the sheet to --bg-canvas", () => {
    const body = declarations(".editor-viewport");
    expect(body).toContain("flex: 1");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow: auto");
    expect(body).toContain("background: var(--bg-canvas)");
  });

  it("the read-only viewer fills the pane and its rows scroll under the foot", () => {
    const view = declarations(".file-view");
    expect(view).toContain("display: flex");
    expect(view).toContain("flex: 1");
    expect(view).toContain("background: var(--bg-canvas)");
    const rows = declarations(".file-view-rows");
    expect(rows).toContain("flex: 1 1 auto");
    expect(rows).toContain("min-height: 0");
    expect(rows).toContain("overflow: auto");
  });
});

describe("the caret cell model is monospace + ligature-free (styles.css)", () => {
  it("the code renders in the mono face with ligatures and letter-spacing off", () => {
    const body = declarations(".editor");
    expect(body).toContain("font-family: var(--font-mono)");
    expect(body).toContain("font-size: 14px");
    expect(body).toContain("letter-spacing: normal");
    expect(body).toContain("font-variant-ligatures: none");
    expect(body).toContain('font-feature-settings: "liga" 0, "calt" 0');
  });

  it("the measure probe inherits the SAME chain it is measuring", () => {
    const probe = declarations(".editor-measure");
    const code = declarations(".editor");
    for (const prop of ["font-family", "font-size", "font-weight", "letter-spacing"]) {
      const from = (src: string): string | undefined =>
        src.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${prop}:`));
      expect(from(probe)).toBeTruthy();
      expect(from(probe)).toBe(from(code)); // the advance the caret trusts
    }
    expect(probe).toContain("font-variant-ligatures: none");
  });
});

describe("tab stops: CSS paint equals the model's TAB_STOP", () => {
  // Raw tabs paint under white-space:pre. The CSS default tab-size is 8
  // while the buffer model counts TAB_STOP=4 cells -- every caret/click on
  // a tab-indented file would land mid-glyph. The number must therefore be
  // bound to the EXPORTED constant, not a literal that can silently drift.
  const ruleOf = (sel: string): string => {
    const lines = CSS.split("\n");
    const idx = lines.findIndex((l) => l.trim() === `${sel} {`);
    if (idx < 0) throw new Error(`rule ${sel} missing from styles.css`);
    let body = "";
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i]!.includes("}")) break;
      body += lines[i] + "\n";
    }
    return body.replace(/\/\*[\s\S]*?\*\//g, "");
  };
  const tabSize = (sel: string): string | undefined =>
    ruleOf(sel).match(/(?:^|\s)tab-size:\s*(\d+)/)?.[1];

  it("editor code, the measure probe, and the viewer all tab at TAB_STOP", () => {
    const stop = String(TAB_STOP);
    expect(tabSize(".editor-code")).toBe(stop);
    expect(tabSize(".editor-measure")).toBe(stop); // probe/paint parity
    expect(tabSize(".file-code")).toBe(stop); // viewer paints identically
  });

  it("the capture textarea never steals a mouse press", () => {
    // Parked under the caret it must be pointer-transparent: focus/IME ride
    // programmatic focus(), clicks reach the rows underneath.
    expect(ruleOf(".editor-input")).toContain("pointer-events: none");
  });
});

describe("selection paint and the whitespace overlay (styles.css)", () => {
  // Two live-app traps:
  //
  //   (1) INVISIBLE SELECTION: the .editor-sel rect is an EMPTY absolutely
  //       positioned span -- with no vertical extent Blink paints it ZERO
  //       pixels tall, so a correct model selection highlighted nothing.
  //       Every rect must carry the caret's row-height extent.
  //   (2) CARET DRIFT LEFT OF THE CLICK: the UA stylesheet claims code
  //       elements with a specified monospace family, overriding the
  //       --font-mono inherited from .editor -- the probe measures the house
  //       face while the rows paint the system one (the tokenizer's
  //       600-weight runs fell through per-glyph fallbacks at a narrower
  //       advance: 7.33px vs the model's 8.00, cumulative from the line
  //       start). The code element must PIN the probe's family against the
  //       UA. And the ws marks are real-whitespace overlays: the glyph
  //       leaves the flow entirely, so the marked row's advance equals the
  //       unmarked row's whatever the face.
  it("every selection/match rect carries the row height (the invisible-highlight cure)", () => {
    const sel = declarations(".editor-sel");
    expect(sel).toContain("position: absolute");
    expect(sel).toContain("height: 20px"); // EDIT_LINE_H, the caret's own extent
    const match = declarations(".editor-match");
    expect(match).toContain("position: absolute");
    expect(match).toContain("height: 20px");
  });

  it("editor AND viewer code pin the probe's face over the UA code default", () => {
    expect(declarations(".editor-code")).toContain("font-family: var(--font-mono)");
    expect(declarations(".file-code")).toContain("font-family: var(--font-mono)");
  });

  it("the whitespace mark glyph is out of flow (position:relative wrapper, absolute overlay)", () => {
    expect(declarations(".ws")).toContain("position: relative");
    const glyph = declarations(".ws-glyph");
    expect(glyph).toContain("position: absolute");
    expect(glyph).toContain("pointer-events: none");
    // No width control: the real character in the flow owns the advance.
    expect(glyph).not.toContain("width");
  });
});
