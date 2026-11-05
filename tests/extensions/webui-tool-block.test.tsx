/// <reference lib="dom.iterable" />
// Unit tests for the webui tool block: header summary fallback, args
// pretty/raw, diff computation, the display-DSL posture matrix (file / diff /
// prose / code / generic), and the tokenizer highlight seam. DOM behavior
// runs through the preloaded dom-helper environment (bunfig preload), which
// is how message-list drives real mounts and clicks.

import { describe, it, expect } from "bun:test";
import {
  argsSummary,
  prettyArgs,
  computeDiffLines,
  diffStat,
  fileSummary,
  genericResultSummary,
  codeRuns,
  proseHtml,
  splitPath,
  ToolBlock,
  ToolBlockController,
  MAX_INLINE_DIFF_LINES,
  MAX_DIFF_LINES,
  RESULT_PREVIEW_CHARS,
  FILE_RENDER_CAP_CHARS,
  type ToolDisplayWire,
} from "@extensions/webui/ui/tool-block.tsx";
import { renderToString, type DomNode } from "@utils/jsx";

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
  // Numbering is the GitHub body's reason to exist, so every shape of change
  // is pinned exact: the two gutters must never agree on a row that only
  // exists on one side.
  it("trims common prefix/suffix and shows one context line per side", () => {
    const lines = computeDiffLines("a\nb\nc\nd", "a\nB\nc\nd");
    expect(lines).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
    ]);
  });

  it("renders an insertion as add-only (no bogus del/add pairing)", () => {
    const lines = computeDiffLines("a\nd", "a\nb\nc\nd");
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(0);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["b", "c"]);
  });

  it("numbers a pure insertion on the NEW side only", () => {
    expect(computeDiffLines("a\nd", "a\nb\nc\nd")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "add", text: "b", newNo: 2 },
      { kind: "add", text: "c", newNo: 3 },
      // The trailing context row numbers differently per side: old line 2 is
      // new line 4 after the insertion.
      { kind: "ctx", text: "d", oldNo: 2, newNo: 4 },
    ]);
  });

  it("numbers a pure deletion on the OLD side only", () => {
    expect(computeDiffLines("a\nb\nc\nd", "a\nd")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "del", text: "c", oldNo: 3 },
      { kind: "ctx", text: "d", oldNo: 4, newNo: 2 },
    ]);
  });

  it("numbers an in-place change so the del and the add sit on one number", () => {
    expect(computeDiffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
    ]);
  });

  it("numbers a both-changed middle (context rows bookend one del-then-add block)", () => {
    // Prefix/suffix trimming keeps a single changed middle: old 2..4 against
    // new 2..4, bookended by line 1 on both sides and old 5 / new 5 after it.
    expect(computeDiffLines("a\nb\nc\nd\ne", "a\nB\nc\nD\ne")).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "del", text: "c", oldNo: 3 },
      { kind: "del", text: "d", oldNo: 4 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "add", text: "c", newNo: 3 },
      { kind: "add", text: "D", newNo: 4 },
      { kind: "ctx", text: "e", oldNo: 5, newNo: 5 },
    ]);
  });

  it("numbers nothing at the start of the file (no leading context exists)", () => {
    expect(computeDiffLines("a\nb", "A\nb")).toEqual([
      { kind: "del", text: "a", oldNo: 1 },
      { kind: "add", text: "A", newNo: 1 },
      { kind: "ctx", text: "b", oldNo: 2, newNo: 2 },
    ]);
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

  it("carries no line numbers on the cap placeholders (info rows are not lines)", () => {
    const oldT = Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n");
    const newT = Array.from({ length: 20 }, (_, i) => `n${i}`).join("\n");
    const lines = computeDiffLines(oldT, newT, 5);
    const info = lines.filter((l) => l.kind === "info");
    expect(info).toHaveLength(2);
    expect(info.every((l) => l.oldNo === undefined && l.newNo === undefined)).toBe(true);
    // The rows that did render keep counting from 1 on their own side.
    expect(lines.filter((l) => l.kind === "del").map((l) => l.oldNo)).toEqual([1, 2, 3, 4, 5]);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts the stat from change rows only", () => {
    expect(diffStat(computeDiffLines("a\nb\nc", "a\nB\nC\nc"))).toEqual({ add: 2, del: 1 });
    expect(diffStat(computeDiffLines("x", "x"))).toEqual({ add: 0, del: 0 });
    // The cap placeholder never counts as an added line.
    const capped = computeDiffLines("x", Array.from({ length: 12 }, (_, i) => `n${i}`).join("\n"), 5);
    expect(diffStat(capped)).toEqual({ add: 5, del: 1 });
  });

  it("keeps the per-side cap constant (huge edits still fold to markers)", () => {
    expect(MAX_DIFF_LINES).toBe(300);
  });
});

describe("splitPath", () => {
  it("cuts at the last separator and keeps both pieces byte-identical", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", base: "b.ts" });
    expect(splitPath("b.ts")).toEqual({ dir: "", base: "b.ts" });
    // Backslash paths split on the normalized separator but slice the ORIGINAL
    // bytes, so dir + base re-joins to exactly what the arg said (and exactly
    // what the copy button puts on the clipboard).
    expect(splitPath("a\\b\\c.ts")).toEqual({ dir: "a\\b\\", base: "c.ts" });
    const weird = "a dir / with /spaces/file name.md";
    const { dir, base } = splitPath(weird);
    expect(base).toBe("file name.md");
    expect(dir + base).toBe(weird);
    // A name-less path (trailing separator) has nothing to emphasize: the whole
    // arg is the primary piece, and no muted prefix is rendered.
    expect(splitPath("dir/")).toEqual({ dir: "", base: "dir/" });
  });
});

describe("fileSummary", () => {
  const spec: ToolDisplayWire = { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" };
  const lines1234 = Array.from({ length: 1234 }, (_, i) => `l${i}`).join("\n");

  it("builds the range form from pathArg/offsetArg/limitArg", () => {
    const args = JSON.stringify({ path: "x/f.ts", offset: 0, limit: 500 });
    expect(fileSummary(args, lines1234, spec)).toBe("f.ts — lines 1–500 of 1234");
  });

  it("shifts the range by the offset and clamps the limit at the end", () => {
    expect(fileSummary(JSON.stringify({ path: "f.ts", offset: 10, limit: 5 }), lines1234, spec)).toBe(
      "f.ts — lines 11–15 of 1234",
    );
    expect(fileSummary(JSON.stringify({ path: "f.ts", offset: 1230 }), lines1234, spec)).toBe(
      "f.ts — lines 1231–1234 of 1234",
    );
    expect(fileSummary(JSON.stringify({ path: "f.ts", offset: 0, limit: 5000 }), lines1234, spec)).toBe(
      "f.ts — lines 1–1234 of 1234",
    );
  });

  it("falls back to the size form when no range args are named or present", () => {
    expect(fileSummary('{"path":"src/a/b/f.ts","offset":10}', "l1\nl2\nl3", { kind: "file", pathArg: "path" })).toBe(
      "f.ts — 3 lines · 8 chars",
    );
    expect(fileSummary('{"path":"f.ts"}', "l1\nl2\nl3", spec)).toBe("f.ts — 3 lines · 8 chars");
    expect(fileSummary('{"path":"f.ts","offset":"x"}', "l1\nl2\nl3", spec)).toBe("f.ts — 3 lines · 8 chars");
    // Empty result: sizes, never a nonsense range over 0 lines.
    expect(fileSummary('{"path":"f.ts","offset":0,"limit":50}', "", spec)).toBe("f.ts — 0 lines · 0 chars");
  });

  it("sizes an args-sourced body (append/overwrite) with no result in sight", () => {
    // The args variant passes the written content as the body bytes: the
    // summary is the content's own size, computed at call time -- a missing
    // result changes nothing (that is the whole point of source: "args").
    const argsSpec: ToolDisplayWire = { kind: "file", source: "args", arg: "content", pathArg: "path" };
    const args = JSON.stringify({ path: "/tmp/notes.md", content: "one\ntwo\nthree" });
    expect(fileSummary(args, "one\ntwo\nthree", argsSpec)).toBe("notes.md — 3 lines · 13 chars");
    expect(fileSummary('{"path":"a/b.md","content":""}', "", argsSpec)).toBe("b.md — 0 lines · 0 chars");
    // Range form stays a result-sourced (read) idea: no offset/limit declared.
    expect(fileSummary(args, "one\ntwo\nthree", spec)).toBe("notes.md — 3 lines · 13 chars");
  });

  it("returns null (skip the part) when the path is missing or not a string", () => {
    expect(fileSummary('{"offset":0}', "x", spec)).toBeNull();
    expect(fileSummary('{"path":42}', "x", spec)).toBeNull();
    expect(fileSummary("not json", "x", spec)).toBeNull();
    expect(fileSummary('{"path":"f.ts"}', "x", { kind: "file" })).toBeNull();
  });
});

describe("genericResultSummary", () => {
  it("collapses ok results to a size line", () => {
    expect(genericResultSummary({ output: "a\nb\nc" })).toBe("result — 3 lines · 5 chars");
    expect(genericResultSummary({ output: "" })).toBe("result — 0 lines · 0 chars");
  });

  it("names error results after their first line", () => {
    expect(genericResultSummary({ error: "bad thing\nstack\ntrace" })).toBe("error — bad thing");
    const long = genericResultSummary({ error: "e".repeat(200) });
    expect(long.length).toBeLessThanOrEqual("error — ".length + 81);
  });
});

describe("codeRuns (shared tokenizer seam)", () => {
  it("maps shell token runs to tok-* classes via @utils/syntax", () => {
    const cmd = 'git add -A && git commit | grep "msg"';
    const runs = codeRuns(cmd, "shell");
    expect(runs).not.toBeNull();
    // Lossless: the runs reproduce the input byte for byte.
    expect(runs!.map((r) => r.text).join("")).toBe(cmd);
    expect(runs!.some((r) => r.cls === "tok-command" && r.text === "git")).toBe(true);
    expect(runs!.some((r) => r.cls === "tok-operator" && r.text === "&&")).toBe(true);
    expect(runs!.some((r) => r.cls === "tok-operator" && r.text === "|")).toBe(true);
    // A quoted word is default text (unstyled), never a command.
    expect(runs!.some((r) => r.cls === null && r.text.includes("msg"))).toBe(true);
    // Adjacent same-class runs coalesce.
    for (let i = 1; i < runs!.length; i++) {
      expect(runs![i - 1]!.cls === runs![i]!.cls && runs![i]!.text !== "" && runs![i - 1]!.text !== "").toBe(false);
    }
  });

  it("returns null for unknown or absent langs (plain <pre> render)", () => {
    expect(codeRuns("a: 1", "yaml")).toBeNull();
    expect(codeRuns("a: 1")).toBeNull();
    expect(codeRuns("a: 1", "constructor")).toBeNull();
  });
});

describe("proseHtml", () => {
  it("renders markdown through the sanitizer-backed route and neutralizes markup", () => {
    expect(proseHtml("**bold**")).toContain("<strong>bold</strong>");
    const hostile = proseHtml("<script>alert(1)</script>");
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;");
  });
});

describe("auto-expand (owner ruling 2026-11-05)", () => {
  it("a generic result under 20 lines is open on arrival; exactly 20 lines stays closed", () => {
    const small = mountBlock({ name: "cat", args: "{}" });
    small.ctrl.setResult({ output: Array.from({ length: 19 }, (_, i) => `l${i}`).join("\n") });
    expect(small.block.querySelector(".tool-result-pre")!.textContent).toContain("l18");

    const at20 = mountBlock({ name: "cat", args: "{}" });
    at20.ctrl.setResult({ output: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") });
    expect(at20.block.querySelector(".tool-result-pre")).toBeNull();
    expect(at20.block.querySelector(".tool-box-summary")!.textContent).toContain("20 lines");
  });

  it("empty output stays closed; a past-cap one-line blob stays closed and still toggles", () => {
    const empty = mountBlock({ name: "touch", args: "{}" });
    empty.ctrl.setResult({ output: "" });
    expect(empty.block.querySelector(".tool-result-pre")).toBeNull();

    const blob = mountBlock({ name: "blob", args: "{}" });
    blob.ctrl.setResult({ output: "x".repeat(RESULT_PREVIEW_CHARS + 1) });
    expect(blob.block.querySelector(".tool-result-pre")).toBeNull();
    blob.click(".tool-result-box .tool-box-summary");
    expect(blob.block.querySelector(".tool-result-pre")!.textContent).toContain("more chars");
  });

  it("a result-sourced file body under 20 lines auto-opens; the first click collapses it", () => {
    const { block, ctrl, click } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "/p/small.md" }),
      display: [{ kind: "file", pathArg: "path" }],
    });
    ctrl.setResult({ output: "a\nb\nc" });
    expect(block.querySelector(".tool-file-pre")!.textContent).toBe("a\nb\nc");
    click(".tool-file .part-head");
    expect(block.querySelector(".tool-file-pre")).toBeNull();
  });
});

describe("ToolBlock SSR", () => {
  const base = { expanded: false, raw: false, fullResult: false, boxes: {}, unfolded: {} };

  it("renders the header and pending status collapsed", () => {
    const html = renderToString(
      ToolBlock({
        state: { name: "read", args: '{"path":"a.ts"}', argsSummary: "a.ts (lines 1-5)", ...base },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
        onToggleBox: () => {},
        onUnfold: () => {},
      }),
    );
    expect(html).toContain('class="tool-call-block status-pending"');
    expect(html).toContain("a.ts (lines 1-5)");
    expect(html).toContain('class="tool-call-body hidden"');
    // No result box until a result exists.
    expect(html).not.toContain("tool-result-box");
  });

  it("prefers the server argsSummary over the local heuristic", () => {
    const render = (state: Record<string, unknown>) =>
      renderToString(
        ToolBlock({
          state: { name: "read", args: '{"path":"src/deep/x.ts"}', ...base, ...state } as never,
          onToggle: () => {},
          onToggleRaw: () => {},
          onShowFull: () => {},
          onToggleBox: () => {},
          onUnfold: () => {},
        }),
      );
    // The server's hint-driven fold wins.
    expect(render({ argsSummary: "FOLD" })).toContain('<span class="tool-call-display">FOLD</span>');
    // No fold -> the old heuristic (basename) still covers old servers.
    expect(render({})).toContain('<span class="tool-call-display">x.ts</span>');
  });

  it("escapes hostile headers and args (never injects markup)", () => {
    const html = renderToString(
      ToolBlock({
        state: { name: "evil", args: '{"path":"<img src=x onerror=alert(1)>"}', ...base },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
        onToggleBox: () => {},
        onUnfold: () => {},
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("marks error results: tinted generic box, open, naming the error", () => {
    const html = renderToString(
      ToolBlock({
        state: {
          name: "run",
          args: "{}",
          ...base,
          expanded: true,
          boxes: { g: true },
          result: { error: "boom" },
        },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
        onToggleBox: () => {},
        onUnfold: () => {},
      }),
    );
    expect(html).toContain("status-error");
    expect(html).toContain("tool-result-error");
    expect(html).toContain("error — boom");
    expect(html).toContain("Error: boom");
  });

  it("unknown kinds skip silently and leave the generic posture standing", () => {
    const html = renderToString(
      ToolBlock({
        state: {
          name: "plot",
          args: "{}",
          ...base,
          display: [{ kind: "chart" }, { kind: "widget" }],
          boxes: { g: true },
          result: { output: "series" },
        },
        onToggle: () => {},
        onToggleRaw: () => {},
        onShowFull: () => {},
        onToggleBox: () => {},
        onUnfold: () => {},
      }),
    );
    expect(html).toContain("tool-result-box");
    expect(html).toContain("result — 1 lines · 6 chars");
    expect(html).not.toContain("tool-code");
    expect(html).not.toContain("tool-prose");
  });
});

// ── DOM postures: mounts, results and clicks through the dom-helper DOM ─────

type MountInit = { name: string; args: string; argsSummary?: string; display?: ToolDisplayWire[] };

function mountBlock(init: MountInit) {
  const host = document.createElement("div");
  const ctrl = new ToolBlockController(host as unknown as DomNode, init);
  const block = host.querySelector(".tool-call-block") as HTMLElement;
  const click = (sel: string) => {
    const el = block.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no element for selector ${sel}`);
    el.click();
  };
  return { block, ctrl, click };
}

describe("file part (DOM)", () => {
  const spec: ToolDisplayWire = { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" };

  it("waits while pending, then shows the path header; body populates on open", () => {
    const { block, ctrl, click } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "/x/y/readme.md", offset: 0, limit: 50 }),
      display: [spec],
    });
    expect(block.querySelector(".tool-file")).toBeNull();
    expect(block.querySelector(".tool-result-box")).toBeNull(); // pending: no result box

    const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    ctrl.setResult({ output: out });
    const box = block.querySelector(".tool-file")!;
    // The path header replaced the centered summary: verbatim path split into
    // a muted directory and the primary basename, the range meta far right
    // WITHOUT the basename prefix the centered summary repeated.
    const head = box.querySelector(".part-head")!;
    expect(head.querySelector(".part-path-dir")!.textContent).toBe("/x/y/");
    expect(head.querySelector(".part-path-base")!.textContent).toBe("readme.md");
    expect(head.querySelector(".part-meta")!.textContent).toBe("lines 1–50 of 100");
    // Collapsed: one header row, no body bytes in the DOM (lazy).
    expect(box.querySelector(".tool-file-pre")).toBeNull();
    expect(box.children).toHaveLength(1);
    // The file part consumed the result: no generic result box.
    expect(block.querySelector(".tool-result-box")).toBeNull();

    click(".tool-file .part-head");
    expect(box.querySelector(".tool-file-pre")!.textContent).toBe(out);
  });

  it("caps rendered text and the show-full button unfolds it", () => {
    const { block, ctrl, click } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "big.md" }),
      display: [{ kind: "file", pathArg: "path" }],
    });
    ctrl.setResult({ output: "q".repeat(FILE_RENDER_CAP_CHARS + 50_000) });
    click(".tool-file .part-head");
    const pre = block.querySelector(".tool-file-pre")!;
    expect(pre.textContent).toHaveLength(FILE_RENDER_CAP_CHARS);
    const more = block.querySelector(".tool-file .tool-raw-toggle")!;
    expect(more.textContent).toContain("50000 more — show full");
    (more as HTMLElement).click();
    expect(block.querySelector(".tool-file-pre")!.textContent).toHaveLength(FILE_RENDER_CAP_CHARS + 50_000);
  });

  describe("args-sourced body (append/overwrite: the written content)", () => {
    const argsSpec: ToolDisplayWire = { kind: "file", source: "args", arg: "content", pathArg: "path" };
    const args = JSON.stringify({ path: "/srv/notes.md", content: "line one\nline two" });

    it("renders on the call, before any result; a small body auto-opens, click collapses", () => {
      const { block, click } = mountBlock({ name: "append", args, display: [argsSpec] });
      const box = block.querySelector(".tool-file")!;
      // The header sizes the WRITTEN content (not a result), at call time.
      const head = box.querySelector(".part-head")!;
      expect(head.querySelector(".part-path-dir")!.textContent).toBe("/srv/");
      expect(head.querySelector(".part-path-base")!.textContent).toBe("notes.md");
      expect(head.querySelector(".part-meta")!.textContent).toBe("2 lines · 17 chars");
      expect(block.querySelector(".tool-result-box")).toBeNull(); // nothing arrived yet
      // Auto-expand (owner ruling): the 2-line body is already open, no click.
      expect(box.querySelector(".tool-file-pre")!.textContent).toBe("line one\nline two");
      // No envelope exists yet, so the box has no footer line.
      expect(box.querySelector(".tool-file-meta")).toBeNull();
      // The user toggle overrides auto-expand in both directions.
      click(".tool-file .part-head");
      expect(box.querySelector(".tool-file-pre")).toBeNull();
      click(".tool-file .part-head");
      expect(box.querySelector(".tool-file-pre")!.textContent).toBe("line one\nline two");
    });

    it("the ok envelope is a quiet footer line inside the box, never a second box", () => {
      const { block, ctrl, click } = mountBlock({ name: "append", args, display: [argsSpec] });
      ctrl.setResult({ output: '{"path":"/srv/notes.md","bytes_appended":17}' });
      // The envelope is consumed: no generic result box alongside the content.
      expect(block.querySelector(".tool-result-box")).toBeNull();
      // Auto-expand leaves the small box open: the envelope rides as the
      // footer line, one line, after the body inside the same box.
      const meta = block.querySelector(".tool-file-meta")!;
      expect(meta.textContent).toBe('{"path":"/srv/notes.md","bytes_appended":17}');
      expect(meta.textContent).not.toContain("\n");
      expect(Array.from(block.querySelector(".tool-file")!.children).indexOf(meta)).toBe(2);
      // Collapsed face (user toggle): the envelope text is nowhere to see.
      click(".tool-file .part-head");
      expect(block.textContent).not.toContain("bytes_appended");
    });

    it("an error result is never swallowed by the file part", () => {
      const { block, ctrl } = mountBlock({ name: "overwrite", args, display: [argsSpec] });
      ctrl.setResult({ error: "EACCES: permission denied" });
      // The written-what content stays, and the tinted error box arrives.
      expect(block.querySelector(".tool-file")).not.toBeNull();
      expect(block.querySelector(".tool-file-meta")).toBeNull();
      const box = block.querySelector(".tool-result-box.tool-result-error")!;
      expect(box.querySelector(".tool-box-summary")!.textContent).toBe("error — EACCES: permission denied");
    });

    it("missing or non-string content arg skips the part; the generic fallback covers it", () => {
      for (const bad of [
        { path: "/srv/notes.md" }, // no content key at all
        { path: "/srv/notes.md", content: 7 }, // not a string
        { path: "/srv/notes.md", content: "" }, // empty bytes never count
        "not json at all", // unparseable args
      ]) {
        const { block, ctrl } = mountBlock({
          name: "append",
          args: typeof bad === "string" ? bad : JSON.stringify(bad),
          display: [argsSpec],
        });
        expect(block.querySelector(".tool-file")).toBeNull();
        ctrl.setResult({ output: "wrote 0 bytes" });
        expect(block.querySelector(".tool-file")).toBeNull();
        // The short generic body auto-opens; the fallback still carries the bytes.
        expect(block.querySelector(".tool-result-pre")!.textContent).toBe("wrote 0 bytes");
      }
    });

    it("a non-string path skips the part too (no header to name)", () => {
      const { block, ctrl } = mountBlock({
        name: "append",
        args: JSON.stringify({ path: 3, content: "x" }),
        display: [argsSpec],
      });
      expect(block.querySelector(".tool-file")).toBeNull();
      ctrl.setResult({ output: "ok" });
      expect(block.querySelector(".tool-file")).toBeNull();
      expect(block.querySelector(".tool-result-box")).not.toBeNull();
    });

    it("caps a huge written body like the result-sourced part", () => {
      const big = "w".repeat(FILE_RENDER_CAP_CHARS + 1_000);
      const { block, click } = mountBlock({
        name: "overwrite",
        args: JSON.stringify({ path: "big.md", content: big }),
        display: [argsSpec],
      });
      click(".tool-file .part-head");
      expect(block.querySelector(".tool-file-pre")!.textContent).toHaveLength(FILE_RENDER_CAP_CHARS);
      expect(block.querySelector(".tool-file .tool-raw-toggle")!.textContent).toContain("1000 more — show full");
    });
  });

  it("never renders error results as file parts: the error posture takes over", () => {
    const { block, ctrl } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "/x/missing.md" }),
      display: [spec],
    });
    ctrl.setResult({ error: "ENOENT: missing.md" });
    expect(block.querySelector(".tool-file")).toBeNull();
    const box = block.querySelector(".tool-result-box.tool-result-error")!;
    // Errors render OPEN and tinted.
    expect(box.querySelector(".tool-box-summary")!.textContent).toBe("error — ENOENT: missing.md");
    expect(box.querySelector(".tool-result-pre")!.textContent).toBe("Error: ENOENT: missing.md");
  });
});

describe("path header + copy (DOM)", () => {
  const spec: ToolDisplayWire = { kind: "file", pathArg: "path" };
  const deep = "src/extensions/webui/ui/tool-block.tsx";

  /** Swap the clipboard out for a recorder (the message-footer copy idiom). */
  function stubClipboard(write: (t: string) => void): () => void {
    const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            write(t);
          },
        },
      },
      configurable: true,
    });
    return () => {
      if (prev) Object.defineProperty(globalThis, "navigator", prev);
      else delete (globalThis as Record<string, unknown>).navigator;
    };
  }

  function stubRejectedClipboard(): () => void {
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    const doc = document as unknown as { execCommand?: (cmd: string) => boolean };
    const prevExec = doc.execCommand;
    doc.execCommand = () => false; // the legacy path reports failure
    return () => {
      doc.execCommand = prevExec;
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      else delete (globalThis as Record<string, unknown>).navigator;
    };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("renders the verbatim path split into a muted dir and the basename", () => {
    const { block, ctrl } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: deep }),
      display: [spec],
    });
    ctrl.setResult({ output: "one\ntwo" });
    const path = block.querySelector(".part-path")!;
    // The full string is there, byte for byte, and the split keeps it whole.
    expect(path.textContent).toBe(deep);
    expect(path.querySelector(".part-path-dir")!.textContent).toBe("src/extensions/webui/ui/");
    expect(path.querySelector(".part-path-base")!.textContent).toBe("tool-block.tsx");
  });

  it("shows the meta without the basename prefix, plus a copy-path button", () => {
    const { block, ctrl } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "/x/y/readme.md", offset: 10, limit: 5 }),
      display: [{ kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" }],
    });
    ctrl.setResult({ output: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") });
    const head = block.querySelector(".part-head")!;
    expect(head.querySelector(".part-meta")!.textContent).toBe("lines 11–15 of 40");
    const copy = head.querySelector(".part-copy")!;
    expect(copy.getAttribute("title")).toBe("copy path");
    // A name with no directory at all still renders (no muted prefix to speak of).
    const bare = mountBlock({ name: "read", args: '{"path":"f.ts"}', display: [spec] });
    bare.ctrl.setResult({ output: "x" });
    const barePath = bare.block.querySelector(".part-path")!;
    expect(barePath.querySelector(".part-path-dir")).toBeNull();
    expect(barePath.querySelector(".part-path-base")!.textContent).toBe("f.ts");
  });

  it("copies the path arg verbatim and flashes only on an acknowledged copy", async () => {
    const written: string[] = [];
    const restore = stubClipboard((t) => written.push(t));
    try {
      const { block, ctrl } = mountBlock({
        name: "read",
        args: JSON.stringify({ path: deep }),
        display: [spec],
      });
      ctrl.setResult({ output: "one\ntwo" });
      const copy = block.querySelector<HTMLElement>(".part-copy")!;
      expect(copy.classList.contains("copied")).toBe(false);
      copy.click();
      await settle();
      expect(written).toEqual([deep]); // the relative arg as declared: no resolution
      expect(copy.classList.contains("copied")).toBe(true);
    } finally {
      restore();
    }
  });

  it("a failed copy confirms nothing", async () => {
    const restore = stubRejectedClipboard();
    try {
      const { block, ctrl } = mountBlock({
        name: "read",
        args: JSON.stringify({ path: "a/b.md" }),
        display: [spec],
      });
      ctrl.setResult({ output: "one\ntwo" });
      const copy = block.querySelector<HTMLElement>(".part-copy")!;
      copy.click();
      await settle();
      expect(copy.classList.contains("copied")).toBe(false);
    } finally {
      restore();
    }
  });

  it("the header toggles the body; the copy button does not", () => {
    // 25 lines: past the auto-expand ceiling, so the body starts closed and
    // both clicks have an unambiguous effect to compare.
    const { block, ctrl, click } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "notes.md" }),
      display: [spec],
    });
    ctrl.setResult({ output: Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n") });
    expect(block.querySelector(".tool-file-pre")).toBeNull();

    block.querySelector<HTMLElement>(".part-copy")!.click();
    expect(block.querySelector(".tool-file-pre")).toBeNull(); // stopPropagation: no fold

    click(".tool-file .part-head");
    expect(block.querySelector(".tool-file-pre")!.textContent).toContain("l24");
    click(".tool-file .part-head");
    expect(block.querySelector(".tool-file-pre")).toBeNull();
  });

  it("the keyboard folds the file part too (div fold restates the button semantics)", () => {
    const { block, ctrl } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "notes.md" }),
      display: [spec],
    });
    ctrl.setResult({ output: Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n") });
    const head = block.querySelector<HTMLElement>(".part-head")!;
    expect(head.getAttribute("role")).toBe("button");
    expect(head.getAttribute("tabindex")).toBe("0");
    // dispatchEvent returns !defaultPrevented: Enter/Space toggle AND swallow
    // (Space must never scroll the row), a stray key does neither.
    expect(head.dispatchEvent({ type: "keydown", key: "Enter" } as unknown as Event)).toBe(false);
    expect(block.querySelector(".tool-file-pre")!.textContent).toContain("l24");
    expect(head.dispatchEvent({ type: "keydown", key: "x" } as unknown as Event)).toBe(true);
    expect(block.querySelector(".tool-file-pre")).not.toBeNull();
    expect(head.dispatchEvent({ type: "keydown", key: " " } as unknown as Event)).toBe(false);
    expect(block.querySelector(".tool-file-pre")).toBeNull();
  });
});

describe("diff part (DOM)", () => {
  function mountDiff(args: Record<string, unknown>, spec?: ToolDisplayWire) {
    return mountBlock({
      name: "change",
      args: JSON.stringify(args),
      display: [spec ?? { kind: "diff", oldArg: "a", newArg: "b" }],
    });
  }

  it("is the primary inline content once the result arrives -- no expand click", () => {
    const { block, ctrl } = mountDiff({ a: "one\ntwo\nthree", b: "one\nTWO\nthree" });
    expect(block.querySelector(".tool-diff")).toBeNull(); // pending: nothing yet
    ctrl.setResult({ output: "ok" });
    const diff = block.querySelector(".tool-diff")!;
    expect(diff.querySelector(".diff-del")!.textContent).toContain("two");
    expect(diff.querySelector(".diff-add")!.textContent).toContain("TWO");
    expect(diff.querySelector(".diff-ctx")!.textContent).toContain("one");
    // GitHub cells: [old-no][new-no][sign][text]. The marker now lives in its
    // own sign column -- this replaces the old single .diff-gutter shape, which
    // is exactly the structure the redesign rules out.
    expect(diff.querySelector(".diff-del .diff-sign")!.textContent).toBe("-");
    expect(diff.querySelector(".diff-add .diff-sign")!.textContent).toBe("+");
    expect(diff.querySelector(".diff-ctx .diff-sign")!.textContent).toBe("");
    expect(diff.querySelector(".diff-gutter")).toBeNull();
    // Still no click needed: the args body stays collapsed around it.
    expect(block.querySelector(".tool-call-body")!.classList.contains("hidden")).toBe(true);
    // The diff consumed the result.
    expect(block.querySelector(".tool-result-box")).toBeNull();
  });

  it("populates the two line-number gutters per row kind", () => {
    const { block, ctrl } = mountDiff({ a: "one\ntwo\nthree", b: "one\nTWO\nthree" });
    ctrl.setResult({ output: "ok" });
    const rows = Array.from(block.querySelectorAll(".diff-row"));
    // ctx 1/1, del old-2, add new-2, ctx 3/3 -- and the side a row does not
    // exist on renders an EMPTY cell, not a dash (nothing to select by mistake).
    expect(rows.map((r) => r.querySelector(".diff-ln-old")!.textContent)).toEqual(["1", "2", "", "3"]);
    expect(rows.map((r) => r.querySelector(".diff-ln-new")!.textContent)).toEqual(["1", "", "2", "3"]);
    // Numbers are gutter ink, not row content: they stay out of the text cell.
    expect(rows[1]!.querySelector(".diff-text")!.textContent).toBe("two");
  });

  it("renders a capped side's placeholder as .diff-info, gutterless", () => {
    const { block, ctrl, click } = mountDiff({
      a: "x",
      b: Array.from({ length: MAX_DIFF_LINES + 3 }, (_, i) => `n${i}`).join("\n"),
    });
    ctrl.setResult({ output: "ok" });
    click(".diff-expand"); // past the inline fold, so the placeholder row is rendered
    const info = block.querySelector(".diff-row.diff-info")!;
    expect(info.textContent).toContain("3 more added");
    expect(info.querySelector(".diff-sign")).toBeNull();
    expect(info.querySelector(".diff-ln-old")).toBeNull();
    expect(info.querySelector(".diff-ln-new")).toBeNull();
    // Not a fake context row either.
    expect(info.classList.contains("diff-ctx")).toBe(false);
  });

  it("carries a path header with the +N −M stat when the declaration names a pathArg", () => {
    const { block, ctrl } = mountDiff(
      { path: "src/a/b/f.ts", a: "one\ntwo\nthree\nfour", b: "one\nTWO\n2.5\nthree\nfour" },
      { kind: "diff", oldArg: "a", newArg: "b", pathArg: "path" },
    );
    expect(block.querySelector(".tool-diff .part-head")).toBeNull(); // pending
    ctrl.setResult({ output: "ok" });
    const head = block.querySelector(".tool-diff .part-head")!;
    expect(head.querySelector(".part-path-dir")!.textContent).toBe("src/a/b/");
    expect(head.querySelector(".part-path-base")!.textContent).toBe("f.ts");
    // The stat is two tinted cells (the gap between them is CSS, not bytes).
    expect(head.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(head.querySelector(".diff-stat-del")!.textContent).toBe("−1");
    // The diff header is NOT a toggle: the body is inline primary content and
    // the line fold stays the diff's only fold.
    expect(head.className).not.toContain("part-head-toggle");
    (head as HTMLElement).click();
    expect(block.querySelectorAll(".diff-row")).toHaveLength(5);
  });

  it("renders no path header (and no copy button) when no pathArg is declared", () => {
    const { block, ctrl } = mountDiff({ path: "a.ts", a: "x", b: "y" });
    ctrl.setResult({ output: "ok" });
    expect(block.querySelector(".tool-diff")).not.toBeNull();
    expect(block.querySelector(".tool-diff .part-head")).toBeNull();
    expect(block.querySelector(".part-copy")).toBeNull();
  });

  it("folds at MAX_INLINE_DIFF_LINES: exactly 30 inline, 31 behind a working expand", () => {
    expect(MAX_INLINE_DIFF_LINES).toBe(30);
    // 1 del + 29 add = 30 rows: fully inline.
    const exact = mountDiff({ a: "x", b: Array.from({ length: 29 }, (_, i) => `n${i}`).join("\n") });
    exact.ctrl.setResult({ output: "ok" });
    expect(exact.block.querySelectorAll(".diff-row")).toHaveLength(30);
    expect(exact.block.querySelector(".diff-expand")).toBeNull();

    // 1 del + 30 add = 31 rows: 30 inline + expand button for the rest.
    const over = mountDiff({ a: "x", b: Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n") });
    over.ctrl.setResult({ output: "ok" });
    expect(over.block.querySelectorAll(".diff-row")).toHaveLength(30);
    const btn = over.block.querySelector<HTMLElement>(".diff-expand")!;
    expect(btn.textContent).toContain("expand remaining 1 lines");
    btn.click();
    expect(over.block.querySelectorAll(".diff-row")).toHaveLength(31);
    expect(over.block.querySelector(".diff-expand")).toBeNull();
  });

  it("missing or non-string keys skip the part; the generic fallback covers it", () => {
    for (const args of [{ a: "x" }, { a: "x", b: 5 }, { b: "y" }, {}]) {
      const { block, ctrl } = mountDiff(args);
      ctrl.setResult({ output: "done" });
      expect(block.querySelector(".tool-diff")).toBeNull();
      const box = block.querySelector(".tool-result-box")!;
      expect(box.querySelector(".tool-box-summary")!.textContent).toBe("result — 1 lines · 4 chars");
    }
  });

  it("error results skip the diff part too (error posture instead)", () => {
    const { block, ctrl } = mountDiff({ a: "x", b: "y" });
    ctrl.setResult({ error: "denied" });
    expect(block.querySelector(".tool-diff")).toBeNull();
    expect(block.querySelector(".tool-result-box.tool-result-error")).not.toBeNull();
  });

  it("hides a zero-del side even on the edit posture (a stat never says −0)", () => {
    // Pure insertion into the file: the stat's minus side would be pure
    // noise, and the same gate the all-add write posture relies on covers it.
    const { block, ctrl } = mountDiff(
      { path: "f.ts", a: "x\ny", b: "x\ny\nz" },
      { kind: "diff", oldArg: "a", newArg: "b", pathArg: "path" },
    );
    ctrl.setResult({ output: "ok" });
    const head = block.querySelector(".tool-diff .part-head")!;
    expect(head.querySelector(".diff-stat-add")!.textContent).toBe("+1");
    expect(head.querySelector(".diff-stat-del")).toBeNull();
  });
});

describe("args-sourced diff (append/overwrite: the written content is all adds)", () => {
  // Owner ruling (run 20261105-0435): what a write call wrote wears the
  // same all-green add posture the edit diff uses -- rendered at
  // CALL time, sign +, path header with copy. The asymmetry is the truth:
  // overwrite replaces the whole file (addStart: 1 numbers the rail),
  // append lands after unknown content (blank rail, no fake 1..N).
  const overwriteSpec: ToolDisplayWire = { kind: "diff", source: "args", arg: "content", pathArg: "path", addStart: 1 };
  const appendSpec: ToolDisplayWire = { kind: "diff", source: "args", arg: "content", pathArg: "path" };

  function mountWrite(spec: ToolDisplayWire, content: unknown, path: unknown = "/srv/notes.md") {
    return mountBlock({ name: "write", args: JSON.stringify({ path, content }), display: [spec] });
  }
  const cells = (root: Element, sel: string): string[] =>
    Array.from(root.querySelectorAll(sel)).map((c) => c.textContent!);

  it("renders at call time: add rows before any result, + signs, blank old rail", () => {
    const { block } = mountWrite(overwriteSpec, "line one\nline two");
    const diff = block.querySelector(".tool-diff")!;
    expect(block.querySelector(".tool-result-box")).toBeNull(); // nothing arrived yet
    const rows = Array.from(diff.querySelectorAll(".diff-row"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.classList.contains("diff-add"))).toBe(true);
    expect(cells(diff, ".diff-sign")).toEqual(["+", "+"]);
    expect(cells(diff, ".diff-ln-old")).toEqual(["", ""]); // no old side exists
    expect(cells(diff, ".diff-text")).toEqual(["line one", "line two"]);
    // The declared-path header (with its copy button) rides from the call.
    const head = diff.querySelector(".part-head")!;
    expect(head.querySelector(".part-path-dir")!.textContent).toBe("/srv/");
    expect(head.querySelector(".part-path-base")!.textContent).toBe("notes.md");
    expect(head.querySelector(".part-copy")).not.toBeNull();
    // No envelope exists before the result.
    expect(diff.querySelector(".tool-file-meta")).toBeNull();
  });

  it("addStart: 1 numbers the new rail 1..N (overwrite replaces the whole file)", () => {
    const { block } = mountWrite(overwriteSpec, "a\nb\nc");
    expect(cells(block, ".diff-ln-new")).toEqual(["1", "2", "3"]);
    expect(cells(block, ".diff-ln-old")).toEqual(["", "", ""]);
  });

  it("no addStart leaves the new rail blank (append: unknown offset, no fake numbers)", () => {
    const { block } = mountWrite(appendSpec, "a\nb\nc");
    // The cells exist and paint the continuity band; they carry no digits.
    expect(block.querySelectorAll(".diff-ln-new")).toHaveLength(3);
    expect(cells(block, ".diff-ln-new")).toEqual(["", "", ""]);
  });

  it("addStart is a number or it is nothing: 0/negatives/fractions paint no rail", () => {
    for (const bad of [0, -3, 1.5]) {
      const { block } = mountWrite({ ...appendSpec, addStart: bad }, "a\nb");
      expect(cells(block, ".diff-ln-new")).toEqual(["", ""]);
    }
    // A positive offset is honored from wherever it says (not 1-biased).
    const { block } = mountWrite({ ...appendSpec, addStart: 40 }, "a\nb");
    expect(cells(block, ".diff-ln-new")).toEqual(["40", "41"]);
  });

  it("the write stat shows +N with no minus side", () => {
    const { block } = mountWrite(overwriteSpec, "a\nb\nc");
    const head = block.querySelector(".tool-diff .part-head")!;
    expect(head.querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(head.querySelector(".diff-stat-del")).toBeNull();
  });

  it("the ok envelope rides under the body as the quiet footer, consumed", () => {
    const { block, ctrl } = mountWrite(appendSpec, "line one\nline two");
    ctrl.setResult({ output: '{"path":"/srv/notes.md","bytes_appended":17}' });
    // Consumed: the envelope never returns as a second framed box.
    expect(block.querySelector(".tool-result-box")).toBeNull();
    const meta = block.querySelector(".tool-diff .tool-file-meta")!;
    expect(meta.textContent).toBe('{"path":"/srv/notes.md","bytes_appended":17}');
  });

  it("an error result skips the part and opens the tinted error box", () => {
    const { block, ctrl } = mountWrite(appendSpec, "a\nb");
    expect(block.querySelector(".tool-diff")).not.toBeNull(); // call-time body
    ctrl.setResult({ error: "EACCES: permission denied" });
    expect(block.querySelector(".tool-diff")).toBeNull(); // nothing was written
    const box = block.querySelector(".tool-result-box.tool-result-error")!;
    expect(box.querySelector(".tool-box-summary")!.textContent).toBe("error — EACCES: permission denied");
  });

  it("long written content folds at the inline diff limit and expands", () => {
    const content = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    const { block } = mountWrite(overwriteSpec, content);
    expect(block.querySelectorAll(".diff-row")).toHaveLength(MAX_INLINE_DIFF_LINES);
    const btn = block.querySelector<HTMLElement>(".diff-expand")!;
    expect(btn.textContent).toContain("expand remaining 10 lines");
    btn.click();
    expect(block.querySelectorAll(".diff-row")).toHaveLength(40);
  });

  it("splits on \\n only: a \\r rides inside the line, a trailing \\n keeps its empty add row", () => {
    // The house diff idiom (computeDiffLines splits the same way) and the
    // same line accounting the file posture shipped ("a\nb\n" counted as 3
    // lines), kept on purpose: a trailing newline renders as a final empty
    // add row -- the line its closing newline terminates.
    const crlf = mountWrite(appendSpec, "a\r\nb");
    expect(cells(crlf.block, ".diff-text")).toEqual(["a\r", "b"]);
    const trailing = mountWrite(overwriteSpec, "a\nb\n");
    expect(cells(trailing.block, ".diff-text")).toEqual(["a", "b", ""]);
    expect(cells(trailing.block, ".diff-ln-new")).toEqual(["1", "2", "3"]);
  });

  it("missing, non-string or empty content skips the part; the generic fallback covers it", () => {
    for (const bad of [
      { path: "/srv/notes.md" }, // no content key at all
      { path: "/srv/notes.md", content: 7 }, // not a string
      { path: "/srv/notes.md", content: "" }, // empty bytes never count
      "not json at all", // unparseable args
    ]) {
      const { block, ctrl } = mountBlock({
        name: "append",
        args: typeof bad === "string" ? bad : JSON.stringify(bad),
        display: [appendSpec],
      });
      expect(block.querySelector(".tool-diff")).toBeNull();
      ctrl.setResult({ output: "wrote 0 bytes" });
      expect(block.querySelector(".tool-diff")).toBeNull();
      expect(block.querySelector(".tool-result-pre")!.textContent).toBe("wrote 0 bytes");
    }
  });

  it("a non-string path still renders the rows (just no header to name them)", () => {
    // Unlike the file posture (whose header IS the box, so no path skips
    // everything), the diff body is inline primary content: declaredPath
    // just drops the header, exactly like the edit posture.
    const { block } = mountWrite(overwriteSpec, "a", 3);
    expect(block.querySelector(".tool-diff")).not.toBeNull();
    expect(block.querySelector(".tool-diff .part-head")).toBeNull();
    expect(block.querySelector(".part-copy")).toBeNull();
  });
});

describe("prose part (DOM)", () => {
  function mountProse(icon?: string) {
    return mountBlock({
      name: "wait",
      args: '{"seconds":30}',
      display: [{ kind: "prose", source: "result", ...(icon ? { icon } : {}) }],
    });
  }

  it("pending shows a quiet icon + name chip row; no framed tool header", () => {
    const { block } = mountProse("hourglass");
    expect(block.className).toContain("posture-prose");
    expect(block.querySelector(".tool-call-header")).toBeNull();
    expect(block.querySelector(".tool-prose-chip")!.textContent).toBe("wait");
    expect(block.querySelector(".tool-prose-icon svg")).not.toBeNull();
  });

  it("renders the result as a normal agent message (markdown, sanitizer-backed)", () => {
    const { block, ctrl } = mountProse("hourglass");
    ctrl.setResult({ output: "Waited **30s** for the task." });
    const md = block.querySelector(".tool-prose-md")!;
    expect(md.querySelector("strong")!.textContent).toBe("30s");
    expect(md.classList.contains("md-content")).toBe(true);
    // The prose part consumed the result.
    expect(block.querySelector(".tool-result-box")).toBeNull();
  });

  it("hostile payloads stay inert text: no script element, no onerror img", () => {
    const { block, ctrl } = mountProse();
    ctrl.setResult({ output: '<script>alert(1)</script> <img src=x onerror=alert(2)>' });
    const md = block.querySelector(".tool-prose-md")!;
    expect(md.querySelector("script")).toBeNull();
    expect(md.querySelector("img")).toBeNull();
    // The bytes survive as escaped text, not markup.
    expect(md.textContent).toContain("<script>alert(1)</script>");
    expect(md.textContent).toContain("onerror");
  });

  it("icon is chosen by name from the sink set; unknown names render no slot", () => {
    const known = mountProse("hourglass");
    known.ctrl.setResult({ output: "done" });
    expect(known.block.querySelector(".tool-prose-icon")).not.toBeNull();

    const unknown = mountProse("sparkle");
    unknown.ctrl.setResult({ output: "done" });
    expect(unknown.block.querySelector(".tool-prose-icon")).toBeNull();
    expect(unknown.block.querySelector(".tool-prose-md")!.textContent).toContain("done");
  });

  it("keeps raw args reachable via the slim disclosure", () => {
    const { block, ctrl, click } = mountProse("hourglass");
    ctrl.setResult({ output: "done" });
    expect(block.querySelector(".tool-args")).toBeNull();
    click(".tool-prose-raw .tool-raw-toggle"); // "json" opens the disclosure
    const pre = block.querySelector(".tool-args")!;
    expect(pre.textContent).toContain('"seconds": 30'); // pretty
    const toggles = block.querySelectorAll<HTMLElement>(".tool-prose-raw .tool-raw-toggle");
    expect(toggles).toHaveLength(2); // [hide json, raw json]
    toggles[1]!.click();
    expect(block.querySelector(".tool-args")!.textContent).toBe('{"seconds":30}');
    toggles[0]!.click(); // "hide json" folds it back away
    expect(block.querySelector(".tool-args")).toBeNull();
  });
});

describe("code part (DOM)", () => {
  const cmd = 'set -e\ngit add -A && git commit -m "wip" | tee log';

  it("args-sourced code renders immediately on the call, unfolded, shell-highlighted", () => {
    const { block } = mountBlock({
      name: "run",
      args: JSON.stringify({ command: cmd }),
      display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
    });
    // Pending already shows the command: it rides the call, not the result.
    const pre = block.querySelector(".tool-code")!;
    // Real newlines, not escaped JSON.
    expect(pre.textContent).toBe(cmd);
    const spans = [...pre.querySelectorAll("span")];
    expect(spans.some((s) => s.classList.contains("tok-command") && s.textContent === "git")).toBe(true);
    expect(spans.some((s) => s.classList.contains("tok-operator") && s.textContent === "&&")).toBe(true);
    expect(spans.some((s) => s.classList.contains("tok-operator") && s.textContent === "|")).toBe(true);
  });

  it("unknown langs render a plain block with the raw text", () => {
    const yaml = "name: demo\nsteps:\n  - run: echo hi\n";
    const { block } = mountBlock({
      name: "check",
      args: JSON.stringify({ yaml }),
      display: [{ kind: "code", source: "args", arg: "yaml", lang: "yaml" }],
    });
    const pre = block.querySelector(".tool-code")!;
    // REAL content, never a JSON object with escaped \n.
    expect(pre.textContent).toBe(yaml);
    expect(pre.querySelectorAll("span")).toHaveLength(0);
  });

  it("long commands stay unfolded", () => {
    const long = Array.from({ length: 200 }, (_, i) => `echo step${i}`).join("\n");
    const { block } = mountBlock({
      name: "run",
      args: JSON.stringify({ command: long }),
      display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
    });
    const pre = block.querySelector(".tool-code")!;
    expect(pre.textContent!.split("\n")).toHaveLength(200);
    expect(block.querySelector(".diff-expand")).toBeNull();
    expect(block.querySelectorAll(".tool-code button")).toHaveLength(0);
  });

  it("an args-sourced code part does not consume the result: the generic box still arrives", () => {
    const { block, ctrl } = mountBlock({
      name: "run",
      args: JSON.stringify({ command: "echo hi" }),
      display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
    });
    ctrl.setResult({ output: "hi" });
    expect(block.querySelector(".tool-code")).not.toBeNull();
    const box = block.querySelector(".tool-result-box")!;
    expect(box.querySelector(".tool-box-summary")!.textContent).toBe("result — 1 lines · 2 chars");
    // The short generic body auto-opens (owner ruling): no click needed.
    expect(block.querySelector(".tool-result-pre")!.textContent).toBe("hi");
  });

  it("missing/non-string arg keys skip the code part", () => {
    const { block } = mountBlock({
      name: "run",
      args: JSON.stringify({ cmd: 42 }),
      display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
    });
    expect(block.querySelector(".tool-code")).toBeNull();
    expect(block.querySelector(".tool-call-header")).not.toBeNull(); // framed posture stands
  });
});

describe("generic posture and fallbacks (DOM)", () => {
  it("collapsed-with-huge-result costs one summary line and populates on open", () => {
    const { block, ctrl, click } = mountBlock({ name: "cat", args: "{}" });
    const huge = "z".repeat(500_000);
    ctrl.setResult({ output: huge });
    const box = block.querySelector(".tool-result-box")!;
    expect(box.querySelector(".tool-box-summary")!.textContent).toBe(`result — 1 lines · ${huge.length} chars`);
    // Collapsed: the body bytes never reach the DOM.
    expect(block.querySelector(".tool-result-pre")).toBeNull();
    expect(block.innerHTML.length).toBeLessThan(5_000);
    expect(box.children).toHaveLength(1);

    click(".tool-result-box .tool-box-summary");
    const pre = block.querySelector(".tool-result-pre")!;
    expect(pre.textContent).toContain(`${huge.length - RESULT_PREVIEW_CHARS} more chars`);
    expect(pre.textContent!.startsWith("zzz")).toBe(true);
    block.querySelector<HTMLElement>(".tool-result-box .tool-raw-toggle")!.click(); // show full
    expect(block.querySelector(".tool-result-pre")!.textContent).toHaveLength(huge.length);
  });

  it("pending blocks show no result box; an all-unknown array keeps the framed generic", () => {
    const { block, ctrl } = mountBlock({ name: "plot", args: "{}", display: [{ kind: "chart" }] });
    expect(block.querySelector(".tool-result-box")).toBeNull();
    expect(block.querySelector(".tool-call-header")).not.toBeNull();
    ctrl.setResult({ output: "series" });
    expect(block.querySelector(".tool-result-box")!.textContent).toContain("result — 1 lines · 6 chars");
    // Unknown kinds rendered nothing frame-worthy: no part classes anywhere.
    expect(block.querySelector(".tool-file, .tool-diff, .tool-prose, .tool-code")).toBeNull();
  });

  it("multi-part declaration order survives: prose then diff renders in that order", () => {
    const { block, ctrl } = mountBlock({
      name: "finish",
      args: JSON.stringify({ a: "x", b: "y" }),
      display: [
        { kind: "prose", source: "result", icon: "hourglass" },
        { kind: "diff", oldArg: "a", newArg: "b" },
      ],
    });
    ctrl.setResult({ output: "All done." });
    const classes = Array.from(block.children).map((c) => c.className.split(" ")[0]);
    const proseAt = classes.indexOf("tool-prose");
    const diffAt = classes.indexOf("tool-diff");
    expect(proseAt).toBeGreaterThanOrEqual(0);
    expect(diffAt).toBeGreaterThanOrEqual(0);
    expect(proseAt).toBeLessThan(diffAt);
    expect(block.querySelector(".tool-prose-md strong")).toBeNull(); // plain text renders as a paragraph
    expect(block.querySelector(".tool-prose-md")!.textContent).toContain("All done.");
  });

  it("images keep their ImagesView placement", () => {
    const { block, ctrl } = mountBlock({ name: "screenshot", args: "{}" });
    ctrl.setResult({ output: "shot", images: [{ mimeType: "image/png", skipped: true, note: "too big" }] });
    const imgs = block.querySelector(".message-images")!;
    expect(imgs.textContent).toContain("too big");
    // Images sit after the result box, last in the block.
    expect(block.children[Array.from(block.children).length - 1]).toBe(imgs as unknown as Element);
  });
});
