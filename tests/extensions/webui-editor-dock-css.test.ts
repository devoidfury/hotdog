// Two fixes that live in plain CSS (the dom-helper has no CSSOM), pinned
// read-the-CSS style like webui-composer-glyph-blend.test.ts:
//
// 1) Owner ruling 2026-11-14 (follow-up on the editor-mode swap): closing
//    the dock in EDITOR mode closes the WHOLE block. The sessions rail is
//    dock furniture in this shape -- it leaves with the chat instead of
//    standing alone at the row's end -- regardless of the DOM structure (the
//    rail is a child of #workspace-row, not of #chat-area, so the hide is a
//    :has() lookup across the row).
// 2) The block's anchor: #dock-resize is the ROW's child with
//    position:absolute, so the row must be the positioned ancestor -- and
//    the rule that says so must be written on the COMPOUND selector:
//    `.editor-mode #workspace-row` is a dead descendant selector (the class
//    rides the row itself), which left the handle anchored to the viewport.
// 3) The narrow dock keeps the send button on screen: #composer-actions
//    wraps at the BASE rule (any column can get narrower than the pill row;
//    the editor-mode dock floors the chat at 280px), so the phone block no
//    longer needs its own wrap.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** The body of the rule whose selector line is exactly `sel {` (any indent,
 *  first match). Indent-tolerant: the editor-mode rules ride an @media. */
function ruleBody(sel: string): string {
  const lines = CSS.split("\n");
  const idx = lines.findIndex((l) => l.trim() === `${sel} {`);
  if (idx < 0) throw new Error(`rule ${sel} missing from styles.css`);
  let body = "";
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i]!.includes("}")) break;
    body += lines[i] + "\n";
  }
  return body;
}

describe("editor dock closes as one block (styles.css)", () => {
  const railSel = ".editor-mode:has(#chat-area.chat-dock-hidden) #sidebar";

  it("a closed dock takes the sessions rail with the chat", () => {
    expect(ruleBody(railSel)).toContain("display: none");
  });

  it("the rail hide lives inside the desktop @media of the CHAT/EDITOR MODE block (phone keeps the drawer grammar)", () => {
    const banner = CSS.indexOf("CHAT/EDITOR MODE");
    const media = CSS.indexOf("@media (min-width: 769px)", banner);
    const rule = CSS.indexOf(railSel);
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(media).toBeGreaterThan(banner);
    expect(rule).toBeGreaterThan(media);
    // Brace balance from the @media's opening to the rule: exactly 1 means
    // the rule sits INSIDE that block (0 would mean it landed after it
    // closed). The block contains no braces inside comments, so counting is
    // exact here.
    const depth = [...CSS.slice(media, rule)].reduce(
      (d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0),
      0,
    );
    expect(depth).toBe(1);
  });

  it("the chat's own hide and the block's handle release ride the same flag", () => {
    expect(ruleBody(".editor-mode #chat-area.chat-dock-hidden")).toContain("display: none");
    expect(ruleBody(".editor-mode #chat-area.chat-dock-hidden ~ #dock-resize")).toContain("display: none");
  });

  it("the ROW -- not the viewport -- anchors the block's handle", () => {
    expect(ruleBody("#workspace-row.editor-mode")).toContain("position: relative");
    // The dead descendant form must stay gone (the class rides the row itself).
    expect(CSS).not.toMatch(/\.editor-mode #workspace-row\s*\{/);
  });
});

describe("narrow columns keep the send button on screen (styles.css)", () => {
  it("#composer-actions wraps at the base rule, and the base is the ONLY wrap", () => {
    const bodies = [...CSS.matchAll(/#composer-actions\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(bodies).toHaveLength(2); // base + phone block
    expect(bodies[0]).toContain("flex-wrap: wrap");
    // The phone block keeps only the tighter row-gap: one wrap rule owns the
    // behavior, so a future edit cannot re-break the desktop side.
    expect(bodies[1]).not.toContain("flex-wrap");
    expect(bodies[1]).toContain("row-gap: 6px");
  });
});
