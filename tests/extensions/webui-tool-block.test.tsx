// Unit tests for the webui tool block: header summary fallback, args
// pretty/raw, edit diff computation, and SSR shape.

import { describe, it, expect } from "bun:test";
import {
  argsSummary,
  prettyArgs,
  computeDiffLines,
  editDiff,
  ToolBlock,
} from "@extensions/webui/ui/tool-block.tsx";
import { renderToString } from "@utils/jsx";

describe("argsSummary", () => {
  it("reduces path args to the basename", () => {
    expect(argsSummary('{"path":"src/deep/nested/file.ts","offset":10}')).toBe("file.ts");
    expect(argsSummary(JSON.stringify({ file_path: "a\\b\\c.md" }))).toBe("c.md");
  });

  it("flattens command/pattern args to one line", () => {
    expect(argsSummary('{"command":"ls -la\\n  | grep x"}')).toBe("ls -la | grep x");
    expect(argsSummary('{"pattern":"TODO: fix"}')).toBe("TODO: fix");
  });

  it("falls back to any string value, then key names, then the raw first line", () => {
    expect(argsSummary('{"alpha":"beta"}')).toBe("beta");
    expect(argsSummary('{"count":3,"mode":null}')).toBe("{count, mode}");
    expect(argsSummary("not json at all")).toBe("not json at all");
    expect(argsSummary("{}")).toBe("");
  });

  it("truncates long values", () => {
    const summary = argsSummary(JSON.stringify({ command: "x".repeat(200) }));
    expect(summary.length).toBeLessThanOrEqual(81); // 80 + ellipsis
  });
});

describe("prettyArgs", () => {
  it("pretty-prints valid JSON and passes garbage through", () => {
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyArgs("nope")).toBe("nope");
  });
});

describe("computeDiffLines", () => {
  it("trims common prefix/suffix and shows one context line per side", () => {
    const lines = computeDiffLines("a\nb\nc\nd", "a\nB\nc\nd");
    expect(lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
    ]);
  });

  it("renders an insertion as add-only (no bogus del/add pairing)", () => {
    const lines = computeDiffLines("a\nd", "a\nb\nc\nd");
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(0);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["b", "c"]);
  });

  it("identical texts produce no change lines", () => {
    const lines = computeDiffLines("same\ntext", "same\ntext");
    expect(lines.filter((l) => l.kind !== "ctx")).toHaveLength(0);
  });

  it("caps each side at maxLines with an omitted marker", () => {
    const oldT = Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n");
    const newT = Array.from({ length: 20 }, (_, i) => `n${i}`).join("\n");
    const lines = computeDiffLines(oldT, newT, 5);
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(5);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(5);
    expect(lines.some((l) => l.text.includes("more removed"))).toBe(true);
    expect(lines.some((l) => l.text.includes("more added"))).toBe(true);
  });
});

describe("editDiff", () => {
  it("returns diff lines only for edit-named calls with both sides", () => {
    const args = JSON.stringify({ path: "a", oldString: "x", newString: "y" });
    expect(editDiff("edit", args)).toEqual([
      { kind: "del", text: "x" },
      { kind: "add", text: "y" },
    ]);
    expect(editDiff("bash", args)).toBeNull();
    expect(editDiff("edit", '{"path":"a"}')).toBeNull();
    expect(editDiff("edit", "garbage")).toBeNull();
  });
});

describe("ToolBlock SSR", () => {
  const base = { expanded: false, raw: false, fullResult: false };

  it("renders the display header and pending status collapsed", () => {
    const html = renderToString(
      ToolBlock({
        state: { name: "read", args: '{"path":"a.ts"}', display: "a.ts (lines 1-5)", ...base },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
      }),
    );
    expect(html).toContain('class="tool-call-block status-pending"');
    expect(html).toContain("a.ts (lines 1-5)");
    expect(html).toContain('class="tool-call-body hidden"');
    // No result section until a result exists.
    expect(html).not.toContain("tool-result-section");
  });

  it("escapes hostile headers and args (never injects markup)", () => {
    const html = renderToString(
      ToolBlock({
        state: { name: "evil", args: '{"path":"<img src=x onerror=alert(1)>"}', ...base },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("marks error results", () => {
    const html = renderToString(
      ToolBlock({
        state: {
          name: "bash",
          args: "{}",
          ...base,
          expanded: true,
          result: { error: "boom" },
        },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
      }),
    );
    expect(html).toContain("status-error");
    expect(html).toContain("Error: boom");
    expect(html).toContain("tool-result-error");
  });
});
