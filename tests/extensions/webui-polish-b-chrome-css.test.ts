// Batch-3 chrome polish (owner ruling 2026-11-18) structural pins on
// styles.css -- the same read-the-CSS doctrine as
// webui-file-view-foot-css.test.ts (the dom-helper has no CSSOM).
//
// Pinned here:
//  * the read-only banners' close controls carry the house focus grammar
//        (keyboard focus must be VISIBLE -- the field tell of "not in the
//        interactive set" was mostly focus you could not see);
//  * the secret-row layout: the "set (redacted)" badge reads as one
//        right-aligned unit, the write-only field keeps a real min-width so
//        its placeholder stops clipping against Set;
//  * the Recent Logs day-section labels + header date are light type,
//        no surface (clean-surface ruling);
//  * foot bars never wrap (nowrap + ellipsis status + container-type),
//        the composer's fixed segments never squeeze, and the collapse tiers
//        live at the FOOT of the sheet (they must win over every base rule,
//        and they must never shadow a base selector for these test helpers).

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

/** The body of the rule whose selector line is exactly `sel {` (any indent,
 *  first match), declarations only (comments stripped). */
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

describe("read-only banner chips: visible keyboard focus", () => {
  it("the close controls carry the inset accent outline focus grammar", () => {
    expect(CSS).toMatch(
      /\.close-view-btn:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--accent\)/,
    );
  });

  it("the peek's Take over button carries the same focus grammar", () => {
    expect(CSS).toMatch(
      /\.peek-takeover-btn:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--accent\)/,
    );
  });
});

describe("secret row lays out cleanly", () => {
  it("the redacted value reads as one right-aligned unit", () => {
    // The SECOND .settings-row-redacted .settings-value rule is the layout
    // one (the first keeps the italic color); together they say: nowrap,
    // no shrink, margin-left auto owns the right edge.
    const matches = CSS.match(/\.settings-row-redacted \.settings-value \{[^}]*\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const layout = matches.map((m) => m.replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
    expect(layout).toContain("white-space: nowrap");
    expect(layout).toContain("flex-shrink: 0");
    expect(layout).toContain("margin-left: auto");
  });

  it("the REPLACE pair stays one unit and the field keeps a real minimum", () => {
    expect(declarations(".settings-edit.settings-edit-secret-wrap")).toContain("flex-wrap: nowrap");
    const input = declarations(
      ".settings-edit-secret-wrap .settings-edit-input.settings-edit-secret",
    );
    expect(input).toMatch(/min-width:\s*120px/);
    expect(input).toMatch(/flex:\s*1 1 170px/);
    expect(declarations(".settings-edit-secret-wrap .settings-save")).toContain("flex-shrink: 0");
  });

  it("the control row wraps as units when the column narrows", () => {
    // The later .settings-row-control block adds the wrap; the base block
    // stays the flex grammar.
    const blocks = CSS.match(/\.settings-row-control \{[^}]*\}/g) ?? [];
    expect(blocks.map((b) => b.replace(/\/\*[\s\S]*?\*\//g, "")).join("\n")).toContain("flex-wrap: wrap");
  });
});

describe("Recent Logs day sections are light labels, not surfaces", () => {
  it("the section label is quiet type with no fill or border", () => {
    const body = declarations(".log-section-label");
    expect(body).toContain("color: var(--text-muted)");
    expect(body).not.toContain("background");
    expect(body).not.toContain("border");
  });

  it("the header's first-date stamp exists and rides quiet", () => {
    const body = declarations(".logs-header-date");
    expect(body).toContain("font-weight: 400");
  });
});

describe("narrow widths: bars fold, they never pile", () => {
  it("the foot bar never wraps and the status ellipsizes", () => {
    const bar = declarations(".file-view-bar");
    expect(bar).toContain("flex-wrap: nowrap");
    const status = declarations(".file-view-status");
    expect(status).toContain("white-space: nowrap");
    expect(status).toContain("text-overflow: ellipsis");
  });

  it("the foot's columns are query containers", () => {
    const idx = CSS.indexOf(".editor,\n.file-view {\n    container-type: inline-size;\n}");
    expect(idx).toBeGreaterThan(-1);
  });

  it("the collapse tiers live at the foot of the sheet (cascade wins, helpers stay honest)", () => {
    const firstCollapse = CSS.indexOf("@container (max-width: 440px)");
    expect(firstCollapse).toBeGreaterThan(-1);
    // After every base rule they collapse.
    for (const base of [".file-view-lang {", ".editor-goto-btn {", ".mic-btn {", ".profile-selector {"]) {
      expect(CSS.indexOf(base)).toBeLessThan(firstCollapse);
    }
    // And the tier selectors are scoped, so the FIRST-MATCH helper (and the
    // sheet's readers) never mistake a collapse rule for a base rule.
    expect(declarations(".file-view-lang")).not.toContain("display: none");
    expect(declarations(".profile-selector")).not.toContain("display: none");
  });

  it("the fixed composer segments keep their hit areas; the pills own the squeeze", () => {
    // Every rule seated at #composer-actions #connection-status (the group
    // ends there, and its own white-space rule follows).
    const fixed = (CSS.match(/\.composer-actions \.connection-status \{[^}]*\}/g) ?? []).join("\n");
    expect(fixed).toContain("flex-shrink: 0");
    expect(fixed).toContain("white-space: nowrap");
    // The group rule names every fixed segment; the pills are NOT in it.
    const group = CSS.slice(
      CSS.indexOf(".composer-actions .attach-btn,"),
      CSS.indexOf(".composer-actions .connection-status {"),
    );
    expect(group).toContain(".composer-actions .mic-btn");
    expect(group).toContain(".composer-actions .send-btn");
    expect(group).toContain(".composer-actions .cancel-btn");
    expect(group).not.toContain(".model-selector");
    expect(group).not.toContain(".profile-selector");
  });

  it("Send is never hidden at any tier", () => {
    // No collapse rule (media or container) may take the send button.
    for (const block of CSS.match(/@(container|media)[^{]*\{[\s\S]*?\n\}/g) ?? []) {
      if (!/display:\s*none/.test(block)) continue;
      expect(block).not.toMatch(/\.send-btn/);
    }
  });
});
