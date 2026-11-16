/// <reference lib="dom" />
// The shared line-span renderer for BOTH the read-only viewer and the
// editor's line layer: tokenizer runs in, `<span class="tk tk-<type>">`
// children out, optionally with the whitespace marks (a per-browser VIEW
// pref -- no server, no config key):
//
//   - a space runs a faint middle dot (·),
//   - a tab runs an arrow (→) at its cell start,
//   - any trailing whitespace (the run matched by /\s+$/ on the line) wears
//     .ws-trail, the subtle end-of-line highlight.
//
// THE MARKS ARE ZERO-IMPACT OVERLAYS: the REAL whitespace character stays
// in the text flow, so the rendered advance equals the unmarked line's BY
// CONSTRUCTION -- whatever face is loaded, whatever glyph metrics the arrow
// or the dot happen to have (CSS tab-size still expands the tab to its
// stop). The mark glyph itself is an absolutely positioned, aria-hidden
// overlay inside the position:relative wrapper (see .ws / .ws-glyph in
// styles.css); it contributes no width and the DOM text stays honest
// (spaces and tabs, not decoration characters). Column tracking uses VISUAL
// columns (editor-buffer's visualCol), so a tab advance lands the next
// run's marks on the right cell even inside a decorated line.
//
// Marks are SPLIT INTO the token runs, never around them: a run's children
// mix plain text and mark wrappers, so syntax color survives decoration.

import type { JsxChild } from "@utils/jsx";
import type { SyntaxRun } from "@utils/syntax/index.ts";
import { TAB_STOP } from "./editor-buffer.ts";

/** Index of the first char of the line's trailing whitespace run, or -1.
 *  A whole-whitespace line is fully trailing. */
export function trailingWsStart(line: string): number {
  const m = /\s+$/.exec(line);
  return m ? m.index : -1;
}

/** One run's children with whitespace marks applied. `startVisual` is the
 *  run's visual column at the line start position `startIndex`; the caller
 *  advances by the run's own visual width. */
function markRun(
  text: string,
  startIndex: number,
  startVisual: number,
  trailStart: number,
): JsxChild[] {
  const out: JsxChild[] = [];
  let plain = "";
  let visual = startVisual;
  const flush = (): void => {
    if (plain !== "") {
      out.push(plain);
      plain = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const trail = trailStart >= 0 && startIndex + i >= trailStart;
    if (ch === " ") {
      flush();
      out.push(
        <span key={out.length} className={trail ? "ws ws-space ws-trail" : "ws ws-space"}>
          <span className="ws-glyph" aria-hidden="true">
            {"\u00b7"}
          </span>
          {" "}
        </span>,
      );
      visual += 1;
    } else if (ch === "\t") {
      flush();
      out.push(
        <span key={out.length} className={trail ? "ws ws-tab ws-trail" : "ws ws-tab"}>
          <span className="ws-glyph" aria-hidden="true">
            {"\u2192"}
          </span>
          {"\t"}
        </span>,
      );
      visual += TAB_STOP - (visual % TAB_STOP);
    } else {
      plain += ch;
      visual += 1;
    }
  }
  flush();
  return out;
}

/** The <code> children for one line: token spans, decorated when showWs is
 *  on. With showWs off the output is what the viewer has always rendered --
 *  one `tk tk-<type>` span per run, text untouched. */
export function codeSpans(runs: SyntaxRun[], showWs: boolean, lineText = ""): JsxChild[] {
  if (!showWs) {
    return runs.map((run, i) => (
      <span key={i} className={`tk tk-${run.type}`}>
        {run.text}
      </span>
    ));
  }
  const trailStart = trailingWsStart(lineText);
  let index = 0;
  let visual = 0;
  const out: JsxChild[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    out.push(
      <span key={i} className={`tk tk-${run.type}`}>
        {markRun(run.text, index, visual, trailStart)}
      </span>,
    );
    index += run.text.length;
    visual += runVisualWidth(run.text, visual);
  }
  return out;
}

/** Visual cells a text run occupies starting at visual column `from`. */
function runVisualWidth(text: string, from: number): number {
  let v = 0;
  for (const ch of text) {
    v += ch === "\t" ? TAB_STOP - ((from + v) % TAB_STOP) : 1;
  }
  return v;
}
