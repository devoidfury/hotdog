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
  fileSummary,
  genericResultSummary,
  codeRuns,
  proseHtml,
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

  it("keeps the per-side cap constant (huge edits still fold to markers)", () => {
    expect(MAX_DIFF_LINES).toBe(300);
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
    click(".tool-file .tool-box-summary");
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

  it("waits while pending, then collapses to a summary; body populates on open", () => {
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
    expect(box.querySelector(".tool-box-summary")!.textContent).toBe("readme.md — lines 1–50 of 100");
    // Collapsed: one summary line, no body bytes in the DOM (lazy).
    expect(box.querySelector(".tool-file-pre")).toBeNull();
    expect(box.children).toHaveLength(1);
    // The file part consumed the result: no generic result box.
    expect(block.querySelector(".tool-result-box")).toBeNull();

    click(".tool-file .tool-box-summary");
    expect(box.querySelector(".tool-file-pre")!.textContent).toBe(out);
  });

  it("caps rendered text and the show-full button unfolds it", () => {
    const { block, ctrl, click } = mountBlock({
      name: "read",
      args: JSON.stringify({ path: "big.md" }),
      display: [{ kind: "file", pathArg: "path" }],
    });
    ctrl.setResult({ output: "q".repeat(FILE_RENDER_CAP_CHARS + 50_000) });
    click(".tool-file .tool-box-summary");
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
      // The summary sizes the WRITTEN content (not a result), at call time.
      expect(box.querySelector(".tool-box-summary")!.textContent).toBe("notes.md — 2 lines · 17 chars");
      expect(block.querySelector(".tool-result-box")).toBeNull(); // nothing arrived yet
      // Auto-expand (owner ruling): the 2-line body is already open, no click.
      expect(box.querySelector(".tool-file-pre")!.textContent).toBe("line one\nline two");
      // No envelope exists yet, so the box has no footer line.
      expect(box.querySelector(".tool-file-meta")).toBeNull();
      // The user toggle overrides auto-expand in both directions.
      click(".tool-file .tool-box-summary");
      expect(box.querySelector(".tool-file-pre")).toBeNull();
      click(".tool-file .tool-box-summary");
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
      click(".tool-file .tool-box-summary");
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
      click(".tool-file .tool-box-summary");
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

describe("diff part (DOM)", () => {
  function mountDiff(args: Record<string, unknown>) {
    return mountBlock({
      name: "change",
      args: JSON.stringify(args),
      display: [{ kind: "diff", oldArg: "a", newArg: "b" }],
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
    // Gutter rows: +/- markers live in their own fixed column.
    expect(diff.querySelector(".diff-del .diff-gutter")!.textContent).toBe("-");
    expect(diff.querySelector(".diff-add .diff-gutter")!.textContent).toBe("+");
    // Still no click needed: the args body stays collapsed around it.
    expect(block.querySelector(".tool-call-body")!.classList.contains("hidden")).toBe(true);
    // The diff consumed the result.
    expect(block.querySelector(".tool-result-box")).toBeNull();
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
