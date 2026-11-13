// Item-3 structural pin (run 20261113-0701): the floating composer's attach
// and mic glyph buttons must BLEND into the field at rest -- the removed
// slab's --bg-tertiary tint made them read as mini-slabs on the transparent
// floating form (the same "slab is gone" doctrine #input-area/#chat-form
// already follow: transparent fill, no box). Hover/focus return the
// affordance per the composer-blend idiom (real fill + border on hover, the
// --border-focus token on focus-visible), and the 1px border keeps its WIDTH
// at rest so nothing shifts -- pinned here as: the rest rules carry
// `background: transparent` + `border: 1px solid transparent`, the hover
// rules restore --bg-active / --border-light, and the recorded shape is
// untouched (padding values unchanged in the same blocks).
//
// Same read-the-CSS doctrine as webui-theme-pref.test.ts's token-split pin:
// these rules are plain CSS, and the dom-helper has no CSSOM.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** The body of the rule whose selector is exactly `sel` (first match). */
function ruleBody(sel: string): string {
  const at = CSS.indexOf(`\n${sel} {`);
  if (at < 0) throw new Error(`rule ${sel} missing from styles.css`);
  const start = CSS.indexOf("{", at);
  const end = CSS.indexOf("}", start);
  return CSS.slice(start + 1, end);
}

describe("floating composer glyph buttons blend at rest (no mini-slabs)", () => {
  for (const sel of ["#attach-btn", "#mic-btn"]) {
    it(`${sel} rests transparent (field-blend), keeps the 1px border width, and carries no slab tint`, () => {
      const body = ruleBody(sel);
      expect(body).toContain("background: transparent");
      expect(body).toContain("border: 1px solid transparent");
      expect(body).not.toContain("--bg-tertiary");
      // No size/movement changes: the buttons keep their padding (the blend
      // is color-only -- the border WIDTH is retained, just invisible).
      expect(body).toMatch(/padding: 6px (10|12)px/);
    });
  }

  it("hover/focus return the affordance (composer-blend idiom)", () => {
    expect(CSS).toMatch(/#attach-btn:hover:not\(:disabled\)[^{]*\{[^}]*--bg-active[^}]*\}/);
    expect(CSS).toMatch(/#attach-btn:hover:not\(:disabled\)[^{]*\{[^}]*--border-light[^}]*\}/);
    expect(CSS).toMatch(/#attach-btn:focus-visible[^{]*\{[^}]*--border-focus[^}]*\}/);
    expect(CSS).toMatch(/#mic-btn:hover:not\(:disabled\)[^{]*\{[^}]*--bg-active[^}]*\}/);
    expect(CSS).toMatch(/#mic-btn:hover:not\(:disabled\):not\(\.recording\)[^{]*\{[^}]*--border-light[^}]*\}/);
    expect(CSS).toMatch(/#mic-btn:focus-visible:not\(\.recording\)[^{]*\{[^}]*--border-focus[^}]*\}/);
    // The recording state keeps its RED border (the only live-recording cue).
    expect(CSS).toMatch(/#mic-btn\.recording[^{]*\{[^}]*--error[^}]*\}/);
  });
});
