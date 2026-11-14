// Owner ruling 2026-11-14: the read-only file viewer has NO head chrome.
// The tab already names the file, so the name row (and its air) is gone and
// the code sheet starts straight at the tab strip's hairline -- which means
// .file-view-rows must carry NO border-top (the tab strip's own
// border-bottom is that seam; another line would draw it twice). The
// viewer's whole chrome -- status, pager, reload -- rides a sticky-bottom
// foot bar instead of costing a line at the head.
//
// Same read-the-CSS doctrine as webui-composer-glyph-blend.test.ts: the
// dom-helper has no CSSOM, so these are structural pins on styles.css.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** The body of the rule whose selector line is exactly `sel {` (any indent,
 *  first match). */
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

/** The rule's DECLARATIONS (comments stripped -- prose may name the very
 *  property a pin forbids). */
function declarations(sel: string): string {
  return ruleBody(sel).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("file viewer: head is pure sheet, chrome rides the foot (styles.css)", () => {
  it("the head rules stay dead: no .file-view-header, no .file-view-name", () => {
    expect(CSS).not.toMatch(/\.file-view-header\s*\{/);
    expect(CSS).not.toMatch(/\.file-view-name\s*\{/);
  });

  it("the sheet keeps no frame: no border-top, the tab strip's hairline is the seam", () => {
    expect(declarations(".file-view-rows")).not.toContain("border-top");
  });

  it("the foot bar is sticky-bottom and opaque (files scroll under it)", () => {
    const body = declarations(".file-view-bar");
    expect(body).toContain("position: sticky");
    expect(body).toContain("bottom: 0");
    expect(body).toContain("background: var(--bg-secondary)");
    expect(body).toContain("border-top: 1px solid var(--border)");
  });
});
