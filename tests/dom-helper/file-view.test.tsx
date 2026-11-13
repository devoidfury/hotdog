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
  guessLang,
  tokenizeLine,
  tokenizeFileLines,
  revealLine,
  type FileViewsState,
} from "@extensions/webui/ui/file-view.tsx";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

let current: Mounted | null = null;

const PATH = "/rootA/src/app.sh";


function renderView(props: {
  path?: string;
  view: FileViewsState["views"][string] | undefined;
  onReload?: (p: string) => void;
  onMore?: (p: string) => void;
}): HTMLElement {
  const host = document.createElement("div");
  current = mount(
    <FileView
      path={props.path ?? PATH}
      view={props.view}
      onReload={props.onReload ?? noop}
      onMore={props.onMore ?? noop}
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
    expect(guessLang("notes.txt")).toBeUndefined();
    expect(guessLang("LICENSE")).toBeUndefined();
    expect(guessLang(".bashrc")).toBeUndefined(); // dotfile, no stem => no guess
  });

  it("shell lines tokenize; unknown lang renders ONE plain run (the registry contract)", () => {
    const runs = tokenizeLine("ls -l | wc -l", "shell");
    expect(runs[0]).toEqual({ type: "command", text: "ls" });
    // Lossless: concatenating runs reproduces the line exactly.
    expect(runs.map((r) => r.text).join("")).toBe("ls -l | wc -l");
    expect(tokenizeLine("anything { 1", "python")).toEqual([{ type: "default", text: "anything { 1" }]);
    expect(tokenizeLine("anything", undefined)).toEqual([{ type: "default", text: "anything" }]);
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

  it("header states honestly: loaded line count, 'so far' while truncated, unread after a hard error", () => {
    const ready = renderView({ view: { status: "ready", lines: ["a", "b"], truncated: false } });
    expect(text(ready.querySelector(".file-view-status"))).toBe("2 lines");
    const part = renderView({ view: { status: "ready", lines: ["a"], truncated: true } });
    expect(text(part.querySelector(".file-view-status"))).toBe("1 line so far");
    const err = renderView({ view: { status: "error", lines: [], truncated: false, error: "x" } });
    expect(text(err.querySelector(".file-view-status"))).toBe("unread");
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
