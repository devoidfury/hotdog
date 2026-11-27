/// <reference lib="dom" />
// DOM tests for the read-only file viewer (file-view.tsx) on the dom-helper:
// line-addressed rows (data-line grammar -- the Phase 7 reveal seam), the
// tokenizer contract (unknown lang = plain text), the pager on truncated
// reads, stale requestIds dropped as the same state object, the server's
// honest error text rendered verbatim (binary / escape / denied classes),
// and revealLine() finding -- or honestly missing -- a row.

import { describe, it, expect, afterEach } from "bun:test";
import {
  FileView,
  emptyFileViews,
  openFileView,
  reloadFileView,
  moreFileView,
  applyReadFile,
  setFileViewLang,
  retargetFileView,
  forgetFileViews,
  guessLang,
  tokenizeLine,
  tokenizeFileLines,
  revealLine,
  type FileViewsState,
} from "@extensions/webui/ui/file-view.tsx";
import { FileEditor } from "@extensions/webui/ui/editor.tsx";
import { getTokenizer, registerTokenizer } from "@utils/syntax/index.ts";
import { bufferFromContent, type EditorSession } from "@extensions/webui/ui/editor-buffer.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

let current: Mounted | null = null;

const PATH = "/rootA/src/app.sh";


function renderView(props: {
  path?: string;
  view: FileViewsState["views"][string] | undefined;
  onReload?: (p: string) => void;
  onMore?: (p: string) => void;
  onLang?: (p: string, lang: string | null) => void;
}): HTMLElement {
  const host = document.createElement("div");
  current = mount(
    <FileView
      path={props.path ?? PATH}
      view={props.view}
      onReload={props.onReload ?? noop}
      onMore={props.onMore ?? noop}
      onLang={props.onLang}
    />,
    host as unknown as DomNode,
  );
  return host.querySelector(".file-view") as unknown as HTMLElement;
}

afterEach(() => {
  current?.unmount();
  current = null;
});

const text = (el: Element | null): string => el?.textContent ?? "";
const click = (el: Element | null): void => (el as unknown as HTMLElement).click();

// ── Language guess + tokenizer contract ──────────────────────────────────────

describe("viewer language + tokens", () => {
  it("extension map: shell guesses shell; unknown/absent extensions read undefined", () => {
    expect(guessLang("/a/b/run.sh")).toBe("shell");
    expect(guessLang("main.ts")).toBe("typescript");
    // jsx/tsx are def aliases: the guess answers the scanner's canonical
    // name now (byte-identical render; one def per family).
    expect(guessLang("app.jsx")).toBe("javascript");
    expect(guessLang("app.tsx")).toBe("typescript");
    expect(guessLang("notes.txt")).toBeUndefined();
    expect(guessLang("LICENSE")).toBeUndefined();
    // Dotfiles miss the last-dot rule, so the basename index claims them.
    expect(guessLang(".bashrc")).toBe("shell");
    expect(guessLang("/home/u/.zshrc")).toBe("shell");
    expect(guessLang(".profile")).toBe("shell");
    expect(guessLang("/app/.env")).toBe("env"); // dotenv gets its own tokenizer
    expect(guessLang(".editorconfig")).toBe("ini");
    expect(guessLang(".gitconfig")).toBe("ini");
    expect(guessLang(".gitignore")).toBe("gitignore");
    expect(guessLang("schema.graphql")).toBe("graphql");
    expect(guessLang("init.lua")).toBe("lua");
    expect(guessLang("weird.dotfile")).toBeUndefined(); // unclaimed basename AND ext
    // Alias-free extension claims (the format IS the lang).
    expect(guessLang("assets/icon.svg")).toBe("xml");
    expect(guessLang("schema.xsd")).toBe("xml");
    expect(guessLang("page.xhtml")).toBe("html");
    expect(guessLang("events.jsonl")).toBe("json");
    expect(guessLang("stubs.pyi")).toBe("python");
    expect(guessLang("Containerfile")).toBe("dockerfile"); // the podman spelling
    expect(guessLang("Containerfile.dev")).toBe("dockerfile");
    // The batch's new guesses (.ini/.xml) plus the pre-existing .toml one.
    expect(guessLang("config.ini")).toBe("ini");
    expect(guessLang("page.xml")).toBe("xml");
    expect(guessLang("Cargo.toml")).toBe("toml");
    // The C family splits at the re-split: c keeps .c/.h (a header's
    // dialect is undecidable display-wise -- the guard pin) plus the
    // CUDA/shader spellings; the C++ spellings guess "cpp" now.
    expect(guessLang("main.c")).toBe("c");
    expect(guessLang("header.h")).toBe("c");
    expect(guessLang("widget.cc")).toBe("cpp");
    expect(guessLang("widget.cpp")).toBe("cpp");
    expect(guessLang("widget.hpp")).toBe("cpp");
    expect(guessLang("main.cpp")).toBe("cpp"); // the batch's new pin
    // The batch's three: .go keeps its (now scanning) guess, .mk/.mak land,
    // and Makefile is the extensionless basename shape (variant spelling and
    // GNUmakefile included).
    expect(guessLang("main.go")).toBe("go");
    expect(guessLang("query.sql")).toBe("sql");
    expect(guessLang("build.mk")).toBe("make");
    expect(guessLang("rules.mak")).toBe("make");
    expect(guessLang("/repo/Makefile")).toBe("make");
    expect(guessLang("GNUmakefile")).toBe("make");
    expect(guessLang("Makefile.dev")).toBe("make");
    // CMake: the extension plus the CMakeLists.txt basename shape (the
    // .in template variant rides the Dockerfile prefix rule).
    expect(guessLang("/repo/CMakeLists.txt")).toBe("cmake");
    expect(guessLang("CMakeLists.txt.in")).toBe("cmake");
    expect(guessLang("modules.cmake")).toBe("cmake");
    expect(guessLang("CMakeCache.txt")).toBeUndefined(); // generated ini-shape, unclaimed
    expect(guessLang("main.rs")).toBe("rust");
    expect(guessLang("index.php")).toBe("php");
    expect(guessLang("Main.java")).toBe("java");
    expect(guessLang("Program.cs")).toBe("csharp");
    expect(guessLang("app.rb")).toBe("ruby");
    expect(guessLang("Main.kt")).toBe("kotlin");
    expect(guessLang("build.gradle")).toBe("groovy");
    expect(guessLang("Jenkinsfile")).toBe("groovy");
    expect(guessLang("main.dart")).toBe("dart");
    expect(guessLang("Main.swift")).toBe("swift");
    expect(guessLang("main.zig")).toBe("zig");
    expect(guessLang("web.ex")).toBe("elixir");
    expect(guessLang("script.exs")).toBe("elixir");
    expect(guessLang("page.heex")).toBeUndefined(); // HTML-in-a-sigil: honestly unclaimed
    // Diff/patch: the extension pair, git-format-patch naming included;
    // the conflict output (.rej) is its own honest shape, unclaimed.
    expect(guessLang("a.diff")).toBe("diff");
    expect(guessLang("0001-fix.patch")).toBe("diff");
    expect(guessLang("MAIN.DIFF")).toBe("diff");
    expect(guessLang("file.rej")).toBeUndefined();
    // Crystal: the ruby clone claims .cr; the .ecr template dialect is
    // html-with-tags and stays unclaimed.
    expect(guessLang("main.cr")).toBe("crystal");
    expect(guessLang("index.ecr")).toBeUndefined();
    // Erlang: the source and the include header, same syntax.
    expect(guessLang("main.erl")).toBe("erlang");
    expect(guessLang("header.hrl")).toBe("erlang");
    // HCL: the Terraform spellings and the native syntax; the JSON
    // profile (`*.tf.json`) rides json through the last-dot rule.
    expect(guessLang("main.tf")).toBe("hcl");
    expect(guessLang("terraform.tfvars")).toBe("hcl");
    expect(guessLang("main.hcl")).toBe("hcl");
    // SCSS: the braced superset claims .scss (partials and capitals too);
    // the indented .sass syntax is honestly UNCLAIMED (no scanner speaks it
    // line-wise -- the .ecr/.heex ruling).
    expect(guessLang("main.scss")).toBe("scss");
    expect(guessLang("_variables.scss")).toBe("scss");
    expect(guessLang("MAIN.SCSS")).toBe("scss");
    expect(guessLang("index.sass")).toBeUndefined();
    // Nix: the one extension carries everything (flake.nix, default.nix and
    // shell.nix included -- no basenames needed).
    expect(guessLang("default.nix")).toBe("nix");
    expect(guessLang("flake.nix")).toBe("nix");
    expect(guessLang("shell.nix")).toBe("nix");
    expect(guessLang("file.nixx")).toBeUndefined();
    // Protobuf: canonical "protobuf" with "proto" as the fence alias (the
    // graphql precedent); the extension lands the guess, and the wrong
    // extension stays unclaimed.
    expect(guessLang("user.proto")).toBe("protobuf");
    expect(guessLang("message.protos")).toBeUndefined();
    // The cheap claims (no scanner needed, the shape is already covered):
    // CUDA/shaders ride c, module spellings ride the script langs,
    // GeoJSON/Avro ARE json, systemd units are ini.
    expect(guessLang("kernel.cu")).toBe("c");
    expect(guessLang("kernels.cuh")).toBe("c");
    expect(guessLang("blur.glsl")).toBe("c");
    expect(guessLang("post.hlsl")).toBe("c");
    expect(guessLang("chunk.mts")).toBe("typescript");
    expect(guessLang("legacy.cts")).toBe("typescript");
    expect(guessLang("map.geojson")).toBe("json");
    expect(guessLang("user.avsc")).toBe("json");
    expect(guessLang("myapp.service")).toBe("ini");
    expect(guessLang("notify.socket")).toBe("ini");
    expect(guessLang("nightly.timer")).toBe("ini");
    expect(guessLang("my.Makefile")).toBeUndefined(); // not the Makefile.* shape
    // Dockerfile has no extension: the basename special case catches the
    // bare name and the build-variant spelling (case-insensitive), while a
    // plain stemless dotfile still answers undefined.
    expect(guessLang("/repo/Dockerfile")).toBe("dockerfile");
    expect(guessLang("Dockerfile.dev")).toBe("dockerfile");
    expect(guessLang("dockerfile")).toBe("dockerfile");
    expect(guessLang("my.Dockerfile")).toBeUndefined(); // not the Dockerfile.* shape
  });

  it("shell lines tokenize; unknown lang renders ONE plain run (the registry contract)", () => {
    const runs = tokenizeLine("ls -l | wc -l", "shell");
    expect(runs[0]).toEqual({ type: "command", text: "ls" });
    // Lossless: concatenating runs reproduces the line exactly.
    expect(runs.map((r) => r.text).join("")).toBe("ls -l | wc -l");
    expect(tokenizeLine("anything", undefined)).toEqual([{ type: "default", text: "anything" }]);
    // rust's scanner landed: the last guess-only def renders runs now.
    expect(tokenizeLine("anything { 1", "rust")).toEqual([
      { type: "default", text: "anything" },
      { type: "default", text: " " },
      { type: "operator", text: "{" },
      { type: "default", text: " " },
      { type: "number", text: "1" },
    ]);
    // The four new langs resolve (the registry contract, now held for them).
    expect(tokenizeLine("[table]", "toml")[0]).toEqual({ type: "section", text: "[table]" });
    expect(tokenizeLine("k = v", "ini")[0]).toEqual({ type: "key", text: "k" });
    expect(tokenizeLine("<a/>", "xml")[0]).toEqual({ type: "operator", text: "<" });
    expect(tokenizeLine("def f():", "python")[0]).toEqual({ type: "keyword", text: "def" });
    // The two newest resolve too.
    expect(tokenizeLine("#include <x.h>", "c")[0]).toEqual({ type: "preproc", text: "#include <x.h>" });
    expect(tokenizeLine("FROM alpine", "dockerfile")[0]).toEqual({ type: "keyword", text: "FROM" });
    // This batch resolves: go/sql/make all answer through the registry now.
    expect(tokenizeLine("x := 3", "go")[2]).toEqual({ type: "operator", text: ":=" });
    expect(tokenizeLine("SELECT 1;", "sql")[0]).toEqual({ type: "keyword", text: "SELECT" });
    expect(tokenizeLine("all: app", "make")[0]).toEqual({ type: "key", text: "all" });
  });
});

// ── Pure ops ─────────────────────────────────────────────────────────────────

describe("viewer state ops", () => {
  it("open fetches once per unseen path; re-open reuses the entry (no fetch, no wipe)", () => {
    const { state, fetch } = openFileView(emptyFileViews(), PATH);
    expect(fetch).toEqual({ requestId: 1, path: PATH, offset: 0 });
    expect(state.views[PATH]?.status).toBe("loading");
    const again = openFileView(state, PATH);
    expect(again.fetch).toBeNull();
    expect(again.state).toBe(state);
  });

  it("reply appends lines and clears loading; stale ids return the SAME state", () => {
    const { state } = openFileView(emptyFileViews(), PATH);
    const stale = applyReadFile(state, 99, { type: "readFileResult", requestId: 99, path: PATH, content: "x\n" });
    expect(stale).toBe(state);
    const applied = applyReadFile(state, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      offset: 0,
      content: "echo one\necho two\n",
    });
    expect(applied.views[PATH]?.status).toBe("ready");
    expect(applied.views[PATH]?.lines).toEqual(["echo one", "echo two"]);
    expect(applied.views[PATH]?.truncated).toBe(false);
  });

  it("pager: continuation offset = loaded lines; concatenated pages reassemble the file", () => {
    let s = emptyFileViews();
    const first = openFileView(s, PATH);
    s = first.state;
    s = applyReadFile(s, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      content: "l1\nl2\nl3\n",
      truncated: true,
    });
    const more = moreFileView(s, PATH);
    expect(more.fetch).toEqual({ requestId: 2, path: PATH, offset: 3 });
    s = more.state;
    // Double-click while in flight: no second fetch.
    expect(moreFileView(s, PATH).fetch).toBeNull();
    s = applyReadFile(s, 2, { type: "readFileResult", requestId: 2, path: PATH, content: "l4\nl5" });
    expect(s.views[PATH]?.lines).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    expect(s.views[PATH]?.truncated).toBe(false);
    expect(s.views[PATH]!.lines.join("\n") + "\n").toBe("l1\nl2\nl3\nl4\nl5\n"); // (no trailing \n in the source EOF slice)
    // No truncated flag => the pager is done.
    expect(moreFileView(s, PATH).fetch).toBeNull();
  });

  it("reload drops accumulated pages and re-reads from the top", () => {
    let s = applyReadFile(openFileView(emptyFileViews(), PATH).state, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      content: "old\n",
    });
    const r = reloadFileView(s, PATH);
    expect(r.fetch).toEqual({ requestId: 2, path: PATH, offset: 0 });
    expect(r.state.views[PATH]?.status).toBe("loading");
    expect(r.state.views[PATH]?.lines).toEqual([]);
  });

  it("a hard error (no lines yet) keeps only the honest text; a pager error keeps the lines and stops paging", () => {
    let s = openFileView(emptyFileViews(), PATH).state;
    s = applyReadFile(s, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      error: "binary file (21 bytes) -- not displayed",
    });
    expect(s.views[PATH]).toEqual({
      status: "error",
      lines: [],
      truncated: false,
      error: "binary file (21 bytes) -- not displayed",
    });
    let p = openFileView(emptyFileViews(), PATH).state;
    p = applyReadFile(p, 1, { type: "readFileResult", requestId: 1, path: PATH, content: "l1\n", truncated: true });
    p = moreFileView(p, PATH).state;
    p = applyReadFile(p, 2, { type: "readFileResult", requestId: 2, path: PATH, error: "not found: gone" });
    expect(p.views[PATH]!.lines).toEqual(["l1"]);
    expect(p.views[PATH]!.status).toBe("ready");
    expect(p.views[PATH]!.truncated).toBe(false); // pager stopped; Reload is the affordance
    expect(p.views[PATH]!.error).toBe("not found: gone");
    expect(moreFileView(p, PATH).fetch).toBeNull();
  });

  it("retargetFileView MOVES the entry with its lines + lang and drops stale pending; forgetFileViews sweeps the subtree", () => {
    let p = openFileView(emptyFileViews(), PATH).state;
    p = applyReadFile(p, 1, { type: "readFileResult", requestId: 1, path: PATH, content: "a\nb\n" });
    p = setFileViewLang(p, PATH, "go");
    const moved = retargetFileView(p, PATH, "/rootA/renamed.ts");
    expect(moved.views[PATH]).toBeUndefined();
    expect(moved.views["/rootA/renamed.ts"]!.lines).toEqual(["a", "b"]);
    expect(moved.views["/rootA/renamed.ts"]!.lang).toBe("go"); // the paint override rides
    // An in-flight request for the OLD path drops (no resurrection).
    let q = openFileView(emptyFileViews(), PATH).state;
    expect(Object.keys(q.pending)).toHaveLength(1);
    q = retargetFileView(q, PATH, "/rootA/moved.ts");
    expect(Object.keys(q.pending)).toHaveLength(0);
    const dead = applyReadFile(q, 1, { type: "readFileResult", requestId: 1, content: "ghost\n" });
    expect(dead.views[PATH]).toBeUndefined();
    // forgetFileViews: the deleted dir takes every under-path view with it.
    let f = openFileView(emptyFileViews(), "/rootA/dir/a.ts").state;
    f = openFileView(f, "/rootA/dir/deep/b.ts").state;
    f = openFileView(f, "/rootA/keep.ts").state;
    f = forgetFileViews(f, "/rootA/dir");
    expect(Object.keys(f.views)).toEqual(["/rootA/keep.ts"]);
    expect(forgetFileViews(f, "/rootA/dir")).toBe(f); // no-op: same object
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("viewer rendering", () => {
  it("rows carry 1-based data-line numbers and the gutter mirrors them", () => {
    let s = openFileView(emptyFileViews(), PATH).state;
    s = applyReadFile(s, 1, { type: "readFileResult", requestId: 1, path: PATH, content: "echo one\necho two\necho three" });
    const root = renderView({ view: s.views[PATH] });
    const rows = Array.from(root.querySelectorAll(".file-line")) as unknown as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-line"))).toEqual(["1", "2", "3"]);
    expect(text(rows[1]!.querySelector(".file-ln"))).toBe("2");
    // Shell tokens land as spans; the lossless contract shows in the text.
    expect(rows[2]!.querySelector(".tk-command")!.textContent).toBe("echo");
    expect(text(rows[2]!.querySelector(".file-code"))).toBe("echo three");
  });

  it("unknown lang renders plain text (single default run), never a crash", () => {
    let s = openFileView(emptyFileViews(), "/rootA/notes.txt").state;
    s = applyReadFile(s, 1, { type: "readFileResult", requestId: 1, path: "/rootA/notes.txt", content: "plain <b>text</b>\n" });
    const root = renderView({ path: "/rootA/notes.txt", view: s.views["/rootA/notes.txt"] });
    const code = root.querySelector(".file-code")!;
    expect(code.querySelectorAll(".tk-command")).toHaveLength(0);
    expect(text(code)).toBe("plain <b>text</b>"); // escaped as text, markup inert
    expect(code.querySelector("b")).toBeNull();
  });

  it("states: pending note, empty file note, server error VERBATIM (role=alert)", () => {
    const loading = renderView({ view: undefined });
    expect(text(loading.querySelector(".file-view-note"))).toContain("Reading file");
    const empty = renderView({ view: { status: "ready", lines: [], truncated: false } });
    expect(text(empty.querySelector(".file-view-note"))).toBe("(empty file)");
    const errored = renderView({ view: { status: "error", lines: [], truncated: false, error: "Denylisted path rejected (.env): .env" } });
    expect(text(errored.querySelector(".file-view-error"))).toBe("Denylisted path rejected (.env): .env");
    expect(errored.querySelector(".file-view-error")!.getAttribute("role")).toBe("alert");
    expect(errored.querySelector(".file-view-rows")).toBeNull();
  });

  it("truncated: the pager names the next line; click asks the app for more; a pager error rides the status line", () => {
    let more = "";
    const root = renderView({
      view: { status: "ready", lines: ["a", "b", "c"], truncated: true },
      onMore: (p) => {
        more = p;
      },
    });
    const btn = root.querySelector(".file-view-more")!;
    expect(text(btn)).toBe("Load more from line 4");
    click(btn);
    expect(more).toBe(PATH);
    const errored = renderView({ view: { status: "ready", lines: ["a"], truncated: false, error: "not found: gone" } });
    expect(text(errored.querySelector(".file-view-error"))).toBe("not found: gone");
    expect(errored.querySelector(".file-view-more")).toBeNull();
  });

  it("Reload re-reads: the glyph button carries no text, keeps title + aria-label, and fires the same reload", () => {
    let reloaded = "";
    const root = renderView({ view: { status: "ready", lines: ["a"], truncated: false }, onReload: (p) => { reloaded = p; } });
    const btn = root.querySelector(".file-reload-btn")!;
    expect(text(btn)).toBe(""); // glyph-only: no text label
    expect(btn.getAttribute("aria-label")).toBe("Reload");
    expect(btn.getAttribute("title")).toBe("Re-read the file from the top");
    expect(btn.querySelector("svg.file-reload-glyph[aria-hidden='true']")).toBeTruthy();
    click(btn);
    expect(reloaded).toBe(PATH);
  });

  it("revealLine finds [data-line] rows and honestly misses unloaded ones", () => {
    let s = openFileView(emptyFileViews(), PATH).state;
    s = applyReadFile(s, 1, { type: "readFileResult", requestId: 1, path: PATH, content: "l1\nl2\nl3\n", truncated: true });
    const root = renderView({ view: s.views[PATH] });
    expect(revealLine(root, 2)).toBe(true);
    const row = root.querySelector('[data-line="2"]') as unknown as { scrollIntoViewCalls: unknown[] };
    expect(row.scrollIntoViewCalls).toEqual([{ block: "center" }]);
    // Line 4 exists server-side but was never loaded: false, not a guess.
    expect(revealLine(root, 4)).toBe(false);
  });

  it("the head is pure sheet: no name row; status, pager and reload ride the foot bar, the view's last node", () => {
    const root = renderView({ view: { status: "ready", lines: ["a"], truncated: true } });
    // The tab already names the file (owner ruling 2026-11-14): the header
    // row -- name + air -- is gone and the sheet starts at the tab strip.
    expect(root.querySelector(".file-view-header")).toBeNull();
    expect(root.querySelector(".file-view-name")).toBeNull();
    // The foot bar is the viewer's whole chrome, rendered LAST: the sticky
    // foot needs nothing under it in the scrolling pane.
    const bar = root.querySelector(".file-view-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    const kids = (root as unknown as { children: Element[] }).children;
    expect(kids[kids.length - 1]).toBe(bar);
    expect(bar.querySelector(".file-view-status")).toBeTruthy();
    expect(bar.querySelector(".file-view-more")).toBeTruthy(); // the pager rides the foot
    expect(bar.querySelector(".file-reload-btn")).toBeTruthy();
  });

  it("status states honestly (foot bar): loaded line count, 'so far' while truncated, unread after a hard error", () => {
    const ready = renderView({ view: { status: "ready", lines: ["a", "b"], truncated: false } });
    expect(text(ready.querySelector(".file-view-status"))).toBe("2 lines");
    const part = renderView({ view: { status: "ready", lines: ["a"], truncated: true } });
    expect(text(part.querySelector(".file-view-status"))).toBe("1 line so far");
    const err = renderView({ view: { status: "error", lines: [], truncated: false, error: "x" } });
    expect(text(err.querySelector(".file-view-status"))).toBe("unread");
  });

  it("lang override state: set / clear; survives reload and every reply shape; viewless paths are inert", () => {
    let s = openFileView(emptyFileViews(), PATH).state;
    s = applyReadFile(s, 1, { type: "readFileResult", requestId: 1, path: PATH, content: "echo one", truncated: true });
    s = setFileViewLang(s, PATH, "go");
    expect(s.views[PATH]!.lang).toBe("go");
    // Reload re-reads the BYTES; the chosen paint rides through.
    const r = reloadFileView(s, PATH);
    expect(r.state.views[PATH]!.lang).toBe("go");
    const s2 = applyReadFile(r.state, r.fetch.requestId, {
      type: "readFileResult",
      requestId: r.fetch.requestId,
      path: PATH,
      content: "echo one\necho two",
    });
    expect(s2.views[PATH]!.lang).toBe("go");
    // Back to the guess.
    const cleared = setFileViewLang(s2, PATH, null);
    expect(cleared.views[PATH]!.lang).toBeUndefined();
    // A path with no entry has nothing mounted to repaint: same object back.
    expect(setFileViewLang(cleared, "/rootA/never.txt", "go")).toBe(cleared);
  });

  it("foot-bar paint list: Auto leads, the guess is marked, overrides repaint and ride the accent", () => {
    // PATH ends .sh -- shell is the honest guess, and the tokens prove it.
    const auto = renderView({ view: { status: "ready", lines: ["echo one"], truncated: false }, onLang: () => {} });
    expect(text(auto.querySelector(".file-line .tk-command")!)).toBe("echo");
    const sel = auto.querySelector(".file-view-lang")!;
    expect(sel.getAttribute("aria-label")).toBe("Syntax highlighting language");
    const opts = Array.from(sel.querySelectorAll("option"));
    const marked = opts.filter((o) => o.hasAttribute("selected"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute("value")).toBe(""); // AUTO: the selection IS the no-override state
    expect(text(marked[0]!)).toContain("Auto (Shell)");
    expect(text(opts.find((o) => o.getAttribute("value") === "shell")!)).toContain("(auto)");
    expect(opts.some((o) => o.getAttribute("value") === "plain" && text(o).includes("Plain text"))).toBe(true);

    // Forced plain: the runs vanish, the plain option is chosen, the
    // override reads at a glance (accent class).
    const plain = renderView({ view: { status: "ready", lines: ["echo one"], truncated: false, lang: "plain" }, onLang: () => {} });
    expect(plain.querySelector(".file-line .tk-command")).toBeNull();
    expect(plain.querySelector(".file-view-lang")!.classList.contains("is-overridden")).toBe(true);
    const plainMarked = Array.from(plain.querySelector(".file-view-lang")!.querySelectorAll("option")).filter((o) =>
      o.hasAttribute("selected"),
    );
    expect(plainMarked).toHaveLength(1);
    expect(plainMarked[0]!.getAttribute("value")).toBe("plain");

    // A chosen lang paints a file the guess would leave plain...
    const chosen = renderView({
      path: "/rootA/notes.xyz",
      view: { status: "ready", lines: ["echo one"], truncated: false, lang: "shell" },
      onLang: () => {},
    });
    expect(text(chosen.querySelector(".file-line .tk-command")!)).toBe("echo");
    expect(chosen.querySelector(".file-view-lang")!.classList.contains("is-overridden")).toBe(true);
    // ...and a choice EQUAL to the guess is not an override (nothing to flag).
    const same = renderView({ view: { status: "ready", lines: ["echo"], truncated: false, lang: "shell" }, onLang: () => {} });
    expect(same.querySelector(".file-view-lang")!.classList.contains("is-overridden")).toBe(false);
  });

  it("chooser changes: the selection maps to the app, the empty value hands back the auto-guess", () => {
    const asked: [string, string | null][] = [];
    const root = renderView({
      view: { status: "ready", lines: ["a"], truncated: false },
      onLang: (p, lang) => {
        asked.push([p, lang]);
      },
    });
    const sel = root.querySelector(".file-view-lang")!;
    (sel as unknown as { value: string }).value = "python";
    sel.dispatchEvent({ type: "change", currentTarget: sel } as unknown as Event);
    (sel as unknown as { value: string }).value = "";
    sel.dispatchEvent({ type: "change", currentTarget: sel } as unknown as Event);
    expect(asked).toEqual([
      [PATH, "python"],
      [PATH, null],
    ]);
  });

  it("no wiring, no select: the foot keeps status, pager and reload alone", () => {
    const root = renderView({ view: { status: "ready", lines: ["a"], truncated: true } });
    expect(root.querySelector(".file-view-lang")).toBeNull();
    expect(root.querySelector(".file-view-more")).toBeTruthy();
  });
});

// ── Markdown documents: frontmatter + carried fence state ───────────────────

const PROFILE_LINES = [
  "---",
  "name: explorer",
  "description: A codebase scout # gather context",
  "whitelist-tools: [\"find\", \"read\", \"grep\"]",
  "visible-worker: true",
  "---",
  "# Your job: codebase explorer",
  "- read **everything**",
  "---",
];

describe("markdown file rendering (frontmatter behind prescan)", () => {
  it("profiles light up: fence rules, yaml-routed keys, markdown body", () => {
    const host = renderView({
      path: "/rootA/config/profiles/explorer.profile.md",
      view: { status: "ready", lines: PROFILE_LINES, truncated: false },
    });
    const rows = host.querySelectorAll(".file-line");
    expect(rows.length).toBe(PROFILE_LINES.length);
    // Rows still rejoin their source exactly (spans never eat bytes; the
    // empty-line nbsp never fires here -- no empty rows in the sample).
    for (let i = 0; i < PROFILE_LINES.length; i++) {
      expect((rows[i] as Element).querySelector("code")!.textContent).toBe(PROFILE_LINES[i]!);
    }
    const rowSpans = (n: number, cls: string): Element[] =>
      [...(rows[n] as Element).querySelectorAll(`.${cls}`)];
    expect(rowSpans(0, "tk-fence").map((s) => s.textContent)).toEqual(["---"]);
    expect(rowSpans(1, "tk-key").map((s) => s.textContent)).toEqual(["name"]);
    expect(rowSpans(2, "tk-comment").map((s) => s.textContent)).toEqual(["# gather context"]);
    expect(rowSpans(3, "tk-key").map((s) => s.textContent)).toEqual(["whitelist-tools"]);
    expect(rowSpans(4, "tk-boolean").map((s) => s.textContent)).toEqual(["true"]);
    expect(rowSpans(5, "tk-fence").map((s) => s.textContent)).toEqual(["---"]);
    expect(rowSpans(6, "tk-heading").map((s) => s.textContent)).toEqual(["# Your job: codebase explorer"]);
    expect(rowSpans(7, "tk-strong").map((s) => s.textContent)).toEqual(["**everything**"]);
    expect(rowSpans(8, "tk-marker").map((s) => s.textContent)).toEqual(["---"]); // body hr, not frontmatter
  });

  it("prescan false (no closer on the loaded page): line-1 `---` stays an hr", () => {
    const host = renderView({
      path: "/rootA/NOTES.md",
      view: { status: "ready", lines: ["---", "just a leading rule", "text"], truncated: false },
    });
    const rows = host.querySelectorAll(".file-line");
    expect((rows[0] as Element).querySelectorAll(".tk-fence").length).toBe(0);
    expect([...(rows[0] as Element).querySelectorAll(".tk-marker")].map((s) => s.textContent)).toEqual(["---"]);
  });

  it("tokenizeFileLines: fence state carries across rows; other langs stay per-line", () => {
    const lines = ["para **a**", "```", "**literal**", "```", "after **b**"];
    const rows = tokenizeFileLines(lines, "markdown");
    expect(rows.map((r) => r.map((x) => x.text).join(""))).toEqual(lines);
    expect(rows[0]!.some((r) => r.type === "strong")).toBe(true);
    expect(rows[2]!.map((r) => r.type)).toEqual(["code_block"]); // inert inside the fence
    expect(rows[4]!.some((r) => r.type === "strong")).toBe(true);
    // Non-markdown langs keep the registry contract, one row per line.
    expect(tokenizeFileLines(["a: 1"], "yaml")[0]![0]).toEqual({ type: "key", text: "a" });
    expect(tokenizeFileLines(['{"k": 1}'], "json")[0]!.some((r) => r.type === "key")).toBe(true);
    expect(tokenizeFileLines(["x"], undefined)).toEqual([[{ type: "default", text: "x" }]]);
    expect(tokenizeFileLines([], "markdown")).toEqual([]);
  });
});

// ── Editor foot bar syntax chooser ──────────────────────────────────────────
// The paint override must live in BOTH bars: when the
// editor took over editable files the chooser vanished with the read-only
// bar. These pins keep the editor bar from silently dropping the
// affordance: same choices, same marks, same store seam as the viewer.

describe("editor foot bar syntax chooser", () => {
  const session = (): EditorSession => ({
    path: PATH,
    buffer: bufferFromContent("echo one"),
    baseMtimeMs: 1,
    saving: false,
  });

  function renderEditor(props: {
    lang: string | undefined;
    guessed: string | undefined;
    override?: string;
    onLang?: (p: string, lang: string | null) => void;
  }): HTMLElement {
    const host = document.createElement("div");
    current = mount(
      <FileEditor
        path={PATH}
        session={session()}
        lang={props.lang}
        guessed={props.guessed}
        override={props.override}
        onLang={props.onLang ?? noop}
        showWs={false}
        onCommit={noop}
        onSave={noop}
        onReload={noop}
        onToggleWs={noop}
      />,
      host as unknown as DomNode,
    );
    return host.querySelector(".editor") as unknown as HTMLElement;
  }

  it("the bar carries the chooser: Auto leads and is selected, the guess is marked, tokens prove the lang", () => {
    const auto = renderEditor({ lang: "shell", guessed: "shell" });
    const sel = auto.querySelector(".editor-bar .file-view-lang");
    expect(sel).not.toBeNull();
    expect(sel!.getAttribute("aria-label")).toBe("Syntax highlighting language");
    const opts = Array.from(sel!.querySelectorAll("option"));
    const marked = opts.filter((o) => o.hasAttribute("selected"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute("value")).toBe("");
    expect(text(marked[0]!)).toContain("Auto (Shell)");
    expect(text(opts.find((o) => o.getAttribute("value") === "shell")!)).toContain("(auto)");
    // The paint lang folds into the line layer through the shared tokenizer.
    expect(text(auto.querySelector(".editor-line .tk-command")!)).toBe("echo");
  });

  it("an override repaints and rides the accent; a choice equal to the guess does not flag", () => {
    const plain = renderEditor({ lang: "plain", guessed: "shell", override: "plain" });
    expect(plain.querySelector(".editor-line .tk-command")).toBeNull();
    expect(plain.querySelector(".file-view-lang")!.classList.contains("is-overridden")).toBe(true);
    const same = renderEditor({ lang: "shell", guessed: "shell", override: "shell" });
    expect(same.querySelector(".file-view-lang")!.classList.contains("is-overridden")).toBe(false);
  });

  it("chooser changes route to the shared seam: named lang, and the empty value hands back the guess", () => {
    const asked: [string, string | null][] = [];
    const root = renderEditor({
      lang: "shell",
      guessed: "shell",
      onLang: (p, lang) => {
        asked.push([p, lang]);
      },
    });
    const sel = root.querySelector(".file-view-lang")!;
    (sel as unknown as { value: string }).value = "python";
    sel.dispatchEvent({ type: "change", currentTarget: sel } as unknown as Event);
    (sel as unknown as { value: string }).value = "";
    sel.dispatchEvent({ type: "change", currentTarget: sel } as unknown as Event);
    expect(asked).toEqual([
      [PATH, "python"],
      [PATH, null],
    ]);
  });
});

// ── Per-line run cache (the tokenize seam) ──────────────────────────────────
// The cache keys on TOKENIZER IDENTITY and line text: repeated renders
// (every keystroke, every scroll frame, every app tick) reuse unchanged
// lines by reference, which is what makes the row vnode caches bail out.
// The pins: incremental output is byte-identical to full tokenization,
// unchanged lines are identity-stable, and a re-registered scanner can
// never read stale runs.

describe("tokenize run cache", () => {
  it("re-tokenized windows return identity-stable runs; incremental output equals the full pass", () => {
    const lines = ["const a = 1;", "// comment line", "if (x) {", "", "return a;"];
    const full = tokenizeFileLines(lines, "typescript");
    const again = tokenizeFileLines(lines, "typescript");
    for (let i = 0; i < lines.length; i++) expect(again[i]).toBe(full[i]);
    // A typed keystroke re-tokenizes only the visible window; the runs must
    // be the SAME arrays the full pass produced (identity) and must still
    // concatenate back to the line bytes exactly.
    const win = tokenizeFileLines(lines.slice(1, 4), "typescript");
    expect(win.map((r) => r.map((run) => run.text).join(""))).toEqual(lines.slice(1, 4));
    for (let i = 0; i < win.length; i++) expect(win[i]).toBe(full[i + 1]);
  });

  it("the no-tokenizer path caches plain runs by text too (identity-stable, lossless)", () => {
    const a = tokenizeLine("just text", undefined);
    expect(tokenizeLine("just text", undefined)).toBe(a);
    expect(a).toEqual([{ type: "default", text: "just text" }]);
  });

  it("the cache keys on tokenizer identity: a re-registered scanner never reads stale runs", () => {
    const orig = getTokenizer("shell");
    expect(orig).toBeDefined();
    const before = tokenizeLine("echo one", "shell");
    registerTokenizer("shell", (t) => [{ type: "swapped", text: t }]);
    expect(tokenizeLine("echo one", "shell")).toEqual([{ type: "swapped", text: "echo one" }]);
    registerTokenizer("shell", orig!); // restore the exact function identity
    expect(tokenizeLine("echo one", "shell")).toBe(before);
  });

  it("markdown keeps its doc-stateful pass (content-equal across calls, cache is not its path)", () => {
    const doc = ["---", "title: x", "---", "body"];
    const first = tokenizeFileLines(doc, "markdown");
    const second = tokenizeFileLines(doc, "markdown");
    expect(second.map((r) => r.map((run) => run.text).join(""))).toEqual(doc);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ── Viewer row vnode cache ───────────────────────────────────────────────────
// The viewer re-renders with the whole App (stream frames, the 1 s ticker).
// Unchanged rows must reuse their vnode (the diff bails out of the subtree),
// the DOM must stay byte-identical to a fresh full mount, and a changed
// line must rebuild exactly its own row.

describe("viewer row vnode cache", () => {
  const page = (content: string) => {
    const { state } = openFileView(emptyFileViews(), PATH);
    return applyReadFile(state, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      offset: 0,
      content,
    }).views[PATH];
  };

  it("re-render reuses unchanged row nodes and equals a fresh mount; a changed line rebuilds its row only", () => {
    const content = "echo one\necho two\necho three\n\nlast\n";
    const view = page(content);
    const host = document.createElement("div");
    current = mount(
      <FileView path={PATH} view={view} onReload={noop} onMore={noop} />,
      host as unknown as DomNode,
    );
    const rowOf = (n: number) => host.querySelector(`.file-line[data-line="${n}"]`);
    const row2 = rowOf(2);
    const row4 = rowOf(4);
    expect(row2).not.toBeNull();
    // Same view entry, fresh props object: every row must survive untouched.
    current.render(<FileView path={PATH} view={view} onReload={noop} onMore={noop} />);
    expect(rowOf(2)).toBe(row2);
    expect(rowOf(4)).toBe(row4);

    // Change line 4 (was the empty one): the result must match a
    // from-scratch mount of the new content exactly.
    const view2 = page("echo one\necho two\necho three\nfilled in\nlast\n");
    current.render(<FileView path={PATH} view={view2} onReload={noop} onMore={noop} />);
    expect(rowOf(2)).toBe(row2);
    expect(text(rowOf(4)!)).toContain("filled in");

    const refHost = document.createElement("div");
    const refMount = mount(
      <FileView path={PATH} view={view2} onReload={noop} onMore={noop} />,
      refHost as unknown as DomNode,
    );
    expect(host.innerHTML).toBe(refHost.innerHTML);
    refMount.unmount();
  });
});

  it("large unique files keep cache identity past the old 4096 overflow zone (whole-array memo)", () => {
    // The 1 s ticker re-renders the SAME lines array: even with more unique
    // lines than any per-line cap, a repeat pass must return the SAME runs
    // arrays (a wholesale cache clear made this re-tokenize every line and
    // rebuilt every row -- slower than the cache-less baseline).
    const lines = Array.from({ length: 9000 }, (_, i) => "const v" + i + " = f(" + i + ");");
    const first = tokenizeFileLines(lines, "typescript");
    const second = tokenizeFileLines(lines, "typescript");
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]); // evicted deep in the first pass, still stable
    expect(second[8999]).toBe(first[8999]);
  });

  it("per-line cache overflow evicts ONE entry (FIFO), never the working set, and stays lossless", () => {
    const lines = Array.from({ length: 8200 }, (_, i) => "plain " + i);
    for (const line of lines) tokenizeLine(line, undefined);
    // Past the cap the oldest entry may be gone, but every line re-tokens
    // to the contract-identical runs (content equality, losslessness).
    for (const line of lines) {
      expect(tokenizeLine(line, undefined)).toEqual([{ type: "default", text: line }]);
    }
  });

  it("viewer re-render of a 4500-line UNIQUE file preserves row nodes (ticker scenario past the old cap)", () => {
    const content = Array.from({ length: 4500 }, (_, i) => "echo " + i + " // unique").join(String.fromCharCode(10)) + String.fromCharCode(10);
    const { state } = openFileView(emptyFileViews(), PATH);
    const view = applyReadFile(state, 1, {
      type: "readFileResult",
      requestId: 1,
      path: PATH,
      offset: 0,
      content,
    }).views[PATH];
    const host = document.createElement("div");
    current = mount(<FileView path={PATH} view={view} onReload={noop} onMore={noop} />, host as unknown as DomNode);
    const row4200 = host.querySelector(`.file-line[data-line="4200"]`);
    const last = host.querySelector(`.file-line[data-line="4500"]`);
    expect(row4200).not.toBeNull();
    current.render(<FileView path={PATH} view={view} onReload={noop} onMore={noop} />);
    expect(host.querySelector(`.file-line[data-line="4200"]`)).toBe(row4200);
    expect(host.querySelector(`.file-line[data-line="4500"]`)).toBe(last);
  });
