// The terminal posture for a declared kind "diff" part: which calls take the
// diff shape at all (the declaration decides -- no tool names here), and what
// one committed block looks like (header, gutter, colors, cap, spoofing).
// The sink wiring itself is pinned in cli-output-sink.test.ts.

import { describe, it, expect } from "bun:test";
import {
  CLI_MAX_DIFF_LINES,
  CLI_MAX_DIFF_PATH_RUNES,
  CLI_MAX_DIFF_ROW_RUNES,
  renderCliDiff,
  resolveCliDiff,
  type CliDiffView,
} from "@utils/cli/diff-render.ts";
import { ColorPalette } from "@utils/cli/colors.ts";
import type { ToolDisplaySpec } from "@core/extensions/tool-registry.ts";

// The declarations the core tools ship (pinned against them in
// tests/extensions/tools-index.test.ts); mirrored here so a sink test reads
// like a real call without importing the tool registry.
const EDIT: ToolDisplaySpec[] = [{ kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" }];
const APPEND: ToolDisplaySpec[] = [{ kind: "diff", source: "args", arg: "content", pathArg: "path" }];
const OVERWRITE: ToolDisplaySpec[] = [
  { kind: "diff", source: "args", arg: "content", pathArg: "path", addStart: 1 },
];

const editArgs = (oldString: string, newString: string, path = "src/a.ts"): string =>
  JSON.stringify({ path, oldString, newString });

describe("resolveCliDiff: the declaration decides", () => {
  it("renders nothing without a declaration, unknown kinds, or unparseable args", () => {
    const args = editArgs("a", "b");
    expect(resolveCliDiff(undefined, args)).toBeNull();
    expect(resolveCliDiff([], args)).toBeNull();
    expect(resolveCliDiff([{ kind: "file" }, { kind: "prose" }, { kind: "tomorrow" }] as ToolDisplaySpec[], args)).toBeNull();
    expect(resolveCliDiff(EDIT, "not json")).toBeNull();
    expect(resolveCliDiff(EDIT, "[1,2]")).toBeNull();
  });

  it("keeps the generic posture when the declared keys are missing or not strings", () => {
    expect(resolveCliDiff(EDIT, JSON.stringify({ path: "a.ts", newString: "b" }))).toBeNull();
    expect(resolveCliDiff(EDIT, JSON.stringify({ path: "a.ts", oldString: "a", newString: 7 }))).toBeNull();
    expect(resolveCliDiff(APPEND, JSON.stringify({ path: "a.ts" }))).toBeNull();
    expect(resolveCliDiff(APPEND, JSON.stringify({ path: "a.ts", content: "" }))).toBeNull();
  });

  it("skips a replace that changed nothing: an empty block says less than the result text", () => {
    expect(resolveCliDiff(EDIT, editArgs("same\nlines", "same\nlines"))).toBeNull();
  });

  it("renders nothing for a failed call: a write that did not happen has no diff", () => {
    expect(resolveCliDiff(EDIT, editArgs("a", "b"), { failed: true })).toBeNull();
    expect(resolveCliDiff(APPEND, JSON.stringify({ path: "a.md", content: "x" }), { failed: true })).toBeNull();
  });

  it("numbers the gutter from the result's start_line when there is one", () => {
    const plain = resolveCliDiff(EDIT, editArgs("a\nb\nc", "a\nB\nc"));
    const withMeta = resolveCliDiff(EDIT, editArgs("a\nb\nc", "a\nB\nc"), { startLine: 41 });
    expect(plain!.lines.map((l) => (l.kind === "del" ? l.oldNo : l.newNo))).toEqual([1, 2, 2, 3]);
    expect(withMeta!.lines.map((l) => (l.kind === "del" ? l.oldNo : l.newNo))).toEqual([41, 42, 42, 43]);
    // Anything that is not a positive integer is no fact: snippet numbering stands.
    for (const bad of [0, -1, 2.5, null, undefined]) {
      expect(resolveCliDiff(EDIT, editArgs("a\nb", "a\nB"), { startLine: bad })!.lines[1]!.oldNo).toBe(2);
    }
  });

  it("renders an args-sourced write as pure adds, numbered only when addStart says where it lands", () => {
    const append = resolveCliDiff(APPEND, JSON.stringify({ path: "notes.md", content: "one\ntwo" }))!;
    expect(append.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(append.lines.every((l) => l.newNo === undefined)).toBe(true);
    expect(append.path).toBe("notes.md");

    const over = resolveCliDiff(OVERWRITE, JSON.stringify({ path: "f.ts", content: "one\ntwo" }))!;
    expect(over.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it("caps at CLI_MAX_DIFF_LINES rows per side and reports the total it dropped", () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join("\n");
    const write = resolveCliDiff(APPEND, JSON.stringify({ path: "f.ts", content: `${many(50, "l")}\n` }))!;
    expect(write.lines).toHaveLength(CLI_MAX_DIFF_LINES);
    expect(write.elided).toBe(51 - CLI_MAX_DIFF_LINES); // 50 lines + the trailing empty row

    const both = resolveCliDiff(EDIT, editArgs(many(30, "o"), many(30, "n")))!;
    expect(both.lines.filter((l) => l.kind === "del")).toHaveLength(CLI_MAX_DIFF_LINES);
    expect(both.lines.filter((l) => l.kind === "add")).toHaveLength(CLI_MAX_DIFF_LINES);
    expect(both.elided).toBe((30 - CLI_MAX_DIFF_LINES) * 2);
  });

  it("renders the first renderable diff part and skips the parts it cannot draw", () => {
    const declared: ToolDisplaySpec[] = [
      { kind: "prose", icon: "hourglass" },
      { kind: "diff", arg: "missing" },
      { kind: "diff", source: "args", arg: "content", pathArg: "path" },
      { kind: "diff", oldArg: "oldString", newArg: "newString" },
    ];
    const view = resolveCliDiff(declared, JSON.stringify({ path: "a.md", content: "hello" }))!;
    expect(view.path).toBe("a.md");
    expect(view.lines.map((l) => l.text)).toEqual(["hello"]);
  });
});

describe("renderCliDiff", () => {
  const plainPalette = new ColorPalette({ use_colors: false });
  const view = (): CliDiffView => resolveCliDiff(EDIT, editArgs("a\nb\nc", "a\nB\nc"))!;

  it("prints a path+stat header, the rows, and nothing else", () => {
    expect(renderCliDiff(view()).split("\n")).toEqual([
      "src/a.ts +1 \u22121",
      "    1 a",
      "-   2 b",
      "+   2 B",
      "    3 c",
    ]);
  });

  it("omits a zero side of the stat and a missing path", () => {
    const adds = resolveCliDiff(OVERWRITE, JSON.stringify({ path: "f.ts", content: "one\ntwo" }))!;
    expect(renderCliDiff(adds).split("\n")[0]).toBe("f.ts +2");
    const noPath = resolveCliDiff([{ kind: "diff", oldArg: "o", newArg: "n" }], JSON.stringify({ o: "a", n: "b" }))!;
    expect(renderCliDiff(noPath).split("\n")[0]).toBe("+1 \u22121");
  });

  it("drops the gutter entirely when the diff has no numbers at all", () => {
    const append = resolveCliDiff(APPEND, JSON.stringify({ path: "n.md", content: "one\ntwo" }))!;
    expect(renderCliDiff(append).split("\n")).toEqual(["n.md +2", "+ one", "+ two"]);
  });

  it("folds the per-side cap into one elision line naming the total", () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join("\n");
    const both = renderCliDiff(resolveCliDiff(EDIT, editArgs(many(21, "o"), many(21, "n")))!, {});
    const rows = both.split("\n");
    expect(rows[rows.length - 1]).toBe("  \u2026 2 more changed lines");
    expect(rows.filter((r) => r.includes("more removed") || r.includes("more added"))).toEqual([]);
    // One changed line elided reads singular, and it is the block's last row.
    expect(renderCliDiff(resolveCliDiff(EDIT, editArgs(many(21, "o"), many(20, "n")))!, {}))
      .toMatch(/\u2026 1 more changed line$/);
  });

  it("indents and labels every row (the approval prompt's grammar)", () => {
    const block = renderCliDiff(view(), { indent: "  ", label: "will change" });
    expect(block.split("\n").every((r) => r.startsWith("  "))).toBe(true);
    expect(block.split("\n")[0]).toBe("  will change src/a.ts +1 \u22121");
  });

  it("colors rows through the palette and emits zero escape bytes when colors are off", () => {
    const dark = ColorPalette.default();
    const painted = renderCliDiff(view(), { palette: dark });
    expect(painted).toContain("\x1b[31m-   2 b\x1b[0m"); // diff_del
    expect(painted).toContain("\x1b[32m+   2 B\x1b[0m"); // diff_add
    expect(painted).toContain("\x1b[90m    1 a\x1b[0m"); // diff_ctx
    expect(painted).toContain("\x1b[90msrc/a.ts +1 \u22121\x1b[0m"); // diff_meta header
    // Each row closes its own SGR: the sink wraps the block in the result
    // color, and a row that left one open would strand every line after it.
    for (const row of painted.split("\n")) expect(row.endsWith("\x1b[0m")).toBe(true);

    expect(renderCliDiff(view(), { palette: plainPalette })).toBe(renderCliDiff(view()));
  });

  it("honors a custom palette (a theme can repaint adds/dels without a code change)", () => {
    const custom = new ColorPalette({ diff_add: "bold_green", diff_del: "bold_red" });
    const painted = renderCliDiff(view(), { palette: custom });
    expect(painted).toContain("\x1b[1;32m+   2 B\x1b[0m");
    expect(painted).toContain("\x1b[1;31m-   2 b\x1b[0m");
  });

  it("neutralizes spoofing code points in the row text and the path, leaving the harness chrome alone", () => {
    const evil = resolveCliDiff(
      EDIT,
      editArgs("keep\u200bme", "repl\u202eace", "src/weird\u001b[2Kname.ts"),
    )!;
    const block = renderCliDiff(evil, { palette: plainPalette });
    expect(block).toContain("[U+200B]");
    expect(block).toContain("[U+202E]");
    expect(block).toContain("[U+001B]");
    expect(block).not.toContain("\u200b");
    expect(block).not.toContain("\u202e");
    expect(block).not.toContain("\x1b[2K");
    // The signs, gutter and stat are ours and stay literal.
    expect(block).toContain("-   1 keep[U+200B]me");
  });

  it("caps one long row with an inline marker, so a minified line cannot flood scrollback", () => {
    const long = "x".repeat(CLI_MAX_DIFF_ROW_RUNES + 5_000);
    const block = renderCliDiff(resolveCliDiff(EDIT, editArgs("a", long))!);
    const row = block.split("\n").find((r) => r.startsWith("+"))!;
    expect(row).toBe(`+   1 ${"x".repeat(CLI_MAX_DIFF_ROW_RUNES)} \u2026 +5000 chars`);
    // Exactly at the cap: no marker, the row is the file's own bytes.
    const exact = renderCliDiff(resolveCliDiff(EDIT, editArgs("a", "y".repeat(CLI_MAX_DIFF_ROW_RUNES)))!);
    expect(exact).toContain("y".repeat(CLI_MAX_DIFF_ROW_RUNES));
    expect(exact).not.toContain("chars");
  });

  it("caps the header's path the same way, cutting before it neutralizes", () => {
    // 4 + 1 + 300 + 3 runes; the zero-width sits inside the kept prefix.
    const path = "src/\u200b" + "p".repeat(300) + ".ts";
    const header = renderCliDiff(resolveCliDiff(EDIT, editArgs("a", "b", path))!).split("\n")[0]!;
    expect(header.startsWith(`src/[U+200B]${"p".repeat(CLI_MAX_DIFF_PATH_RUNES - 5)}`)).toBe(true);
    expect(header).toContain(`\u2026 +${308 - CLI_MAX_DIFF_PATH_RUNES} chars`);
    // A cut that ran AFTER neutralization could split a token in half; the
    // token survives whole and no raw zero-width byte reaches the terminal.
    expect(header).not.toContain("\u200b");
  });

  it("widens the gutter past 4 columns when the file line needs it", () => {
    const deep = resolveCliDiff(EDIT, editArgs("a\nb", "a\nB"), { startLine: 123_456 })!;
    const rows = renderCliDiff(deep).split("\n");
    expect(rows[0]).toBe("src/a.ts +1 \u22121");
    expect(rows[1]).toBe(" 123456 a");
    expect(rows[2]).toBe("-123457 b");
    expect(rows[3]).toBe("+123457 B");
  });
});
