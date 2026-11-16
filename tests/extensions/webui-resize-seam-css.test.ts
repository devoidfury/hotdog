// The vertical resize seams (session<>chat, chat<>workspace,
// workspace<>files) must not cover the panes' 6px scrollbar tracks, and the
// hover/active highlight is a 2px line at the border, not a 6px slab. Each
// strip starts at the border it owns and rides
// the non-scrolling side, and the ::after hit pad widens outward only.
// Read-the-CSS pins (the dom-helper has no CSSOM), same style as
// webui-editor-dock-css.test.ts: the geometry lives in plain CSS, so the
// assertions read the stylesheet.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** Every rule body whose selector list ENDS with `sel` (the last selector
 *  before the `{`), so the compound rules the dock seams share
 *  (`#dock-resize,\n#tree-col-resize { ... }`) answer under BOTH names --
 *  unlike the single-name line match webui-editor-dock-css.test.ts uses.
 *  `#sidebar-resize` cannot catch `#sidebar-resize::after` / `:hover` (the
 *  selector must abut the brace). */
function bodies(sel: string): string[] {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...CSS.matchAll(new RegExp(`${esc}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!);
}

const some = (sel: string, needle: string): boolean => bodies(sel).some((b) => b.includes(needle));

// The active-state paint: a 2px-wide gradient run pinned to the strip's
// border edge (the `left/2px 100%` shorthand: position / size).
const SEAM_LINE = "left/2px 100% no-repeat";

describe("resize seams ride off the scrollbar track (styles.css)", () => {
  it("the webkit scrollbar track is 6px -- the width every seam offset is sized against", () => {
    expect(bodies("::-webkit-scrollbar").length).toBe(1);
    expect(bodies("::-webkit-scrollbar")[0]).toContain("width: 6px");
  });

  it("each strip starts AT its border and extends onto the non-scrolling side (no straddle)", () => {
    // Sidebar: the session list scrolls, so the strip rides the chat side.
    expect(some("#sidebar-resize", "right: -6px")).toBe(true);
    // Workbench + dock: the CHAT scrolls, so the strips ride the
    // workbench/dock side of their borders.
    expect(some("#workbench-resize", "left: 0;")).toBe(true);
    expect(some("#dock-resize", "right: calc(var(--editor-dock-width, 720px) - 6px)")).toBe(true);
    // Tree column: the TREE scrolls, so the strip rides the file-viewer side.
    expect(some("#tree-col-resize", "left: var(--tree-col-used)")).toBe(true);
    // The old geometry was a +/-3px straddle: half the 6px strip and most
    // of the ::after pad sat ON the 6px track, so a thumb press landed on
    // the handle instead. A negative half-width must stay gone.
    for (const sel of ["#sidebar-resize", "#workbench-resize", "#dock-resize", "#tree-col-resize"]) {
      for (const body of bodies(sel)) {
        expect(body).not.toContain("-3px");
      }
    }
  });

  it("hit pads widen OUTWARD only (left:0), never back across the border over the track", () => {
    for (const sel of ["#sidebar-resize::after", "#workbench-resize::after", "#tree-col-resize::after"]) {
      expect(bodies(sel).length).toBeGreaterThan(0);
      for (const body of bodies(sel)) {
        expect(body).toContain("left: 0;");
        expect(body).not.toContain("-4px");
      }
    }
    // The dock pad is the tree pad (one shared rule) -- pin the pairing so
    // the dock cannot regain a track-eating pad through a split rule.
    expect(CSS).toMatch(/#dock-resize::after,\s*#tree-col-resize::after\s*\{/);
  });

  it("the strips keep their full hit geometry (6px + col-resize) despite the slimmer paint", () => {
    for (const sel of ["#sidebar-resize", "#workbench-resize", "#dock-resize", "#tree-col-resize"]) {
      // dock/tree share their base rule (width lives there, answering under
      // the tree name); sidebar/workbench carry it on their own rules.
      const owner = sel === "#dock-resize" ? "#tree-col-resize" : sel;
      expect(some(owner, "width: 6px")).toBe(true);
      expect(some(owner, "cursor: col-resize")).toBe(true);
    }
    expect(CSS).toMatch(/#dock-resize,\s*#tree-col-resize\s*\{/);
  });
});

describe("resize seam highlight is a 2px line, not a 6px slab (styles.css)", () => {
  // Hover shares each drag rule (compound selector, one body).
  const activeStates = [
    "body.sidebar-resizing #sidebar-resize",
    "body.workbench-resizing #workbench-resize",
    "body.workbench-resizing #dock-resize",
    "body.sidebar-resizing #tree-col-resize",
  ];

  it("hover/drag paint a 2px accent-soft line at the border edge", () => {
    for (const sel of activeStates) {
      expect(bodies(sel).length).toBeGreaterThan(0);
      for (const body of bodies(sel)) {
        expect(body).toContain(SEAM_LINE);
        expect(body).not.toContain("background: var(--accent-soft);");
      }
    }
  });

  it("focus-visible paints the SAME line at full accent -- no outline box around the invisible strip", () => {
    for (const sel of [
      "#sidebar-resize:focus-visible",
      "#workbench-resize:focus-visible",
      "#dock-resize:focus-visible",
      "#tree-col-resize:focus-visible",
    ]) {
      expect(bodies(sel).length).toBeGreaterThan(0);
      for (const body of bodies(sel)) {
        expect(body).toContain(SEAM_LINE);
        expect(body).toContain("var(--accent)");
        expect(body).not.toContain("outline");
      }
    }
  });
});
