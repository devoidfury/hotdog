/// <reference lib="dom" />
// DOM pins for the editor's render caches (row vnodes, live slots, memoized
// bracket match): unchanged rows keep their DOM node across commits, the
// cached path renders the SAME structure as a from-scratch mount, a cached
// row's handlers act on the CURRENT buffer (no stale rollback), and the
// scroll poke commits the session object unchanged (the app's view-only
// route depends on it). Typing/multi-caret/find/hot-exit SEMANTICS stay
// pinned where they always lived (editor-buffer/find/stash/app suites) --
// this file only pins that the cache layer cannot desync from them.

import { describe, it, expect, afterEach } from "bun:test";
import { FileEditor } from "@extensions/webui/ui/editor.tsx";
import {
  bufferFromContent,
  insertText,
  selectRange,
  setCaret,
  typeChar,
  type EditorSession,
  type TextBuffer,
} from "@extensions/webui/ui/editor-buffer.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

let current: Mounted | null = null;
let refMount: Mounted | null = null;

afterEach(() => {
  current?.unmount();
  current = null;
  refMount?.unmount();
  refMount = null;
});

let paths = 0;
const nextPath = (): string => `/rootA/ecache/f${paths++}.ts`;

const sess = (path: string, buffer: TextBuffer): EditorSession => ({ path, buffer, baseMtimeMs: 1, saving: false });

const editorProps = (
  path: string,
  session: EditorSession,
  commit: (p: string, next: EditorSession) => void,
  showWs: boolean,
) => (
  <FileEditor
    path={path}
    session={session}
    lang="typescript"
    guessed="typescript"
    showWs={showWs}
    onCommit={commit}
    onSave={noop}
    onReload={noop}
    onToggleWs={noop}
  />
);

function mountEditor(path: string, session: EditorSession, showWs = false): {
  host: HTMLElement;
  commits: Array<[string, EditorSession]>;
  commit: (p: string, next: EditorSession) => void;
} {
  const commits: Array<[string, EditorSession]> = [];
  const commit = (p: string, next: EditorSession): void => {
    commits.push([p, next]);
  };
  const host = document.createElement("div");
  current = mount(editorProps(path, session, commit, showWs), host as unknown as DomNode);
  return { host: host as unknown as HTMLElement, commits, commit };
}

/** Re-render the mounted editor with new props (the app's commit path,
 *  rendered straight through the mount). */
function rerender(path: string, session: EditorSession, commit: (p: string, next: EditorSession) => void, showWs = false): void {
  current!.render(editorProps(path, session, commit, showWs));
}

const editorEl = (host: HTMLElement) => host.querySelector(".editor") as Element;
const rowEl = (host: HTMLElement, line1: number) => host.querySelector(`.editor-line[data-line="${line1}"]`);
const text = (el: Element | null): string => el?.textContent ?? "";

/** innerHTML with the path normalized: the aria-labels carry it, and the
 *  reference mount deliberately uses its OWN path (a fresh view state, an
 *  independent build -- sharing the path would let the caches leak). */
const stripPath = (host: HTMLElement, path: string): string =>
  (editorEl(host) as Element).innerHTML.split(path).join("@@PATH@@");

function refStructure(session: EditorSession, showWs = false): string {
  const refPath = nextPath();
  const refHost = document.createElement("div");
  refMount = mount(editorProps(refPath, session, noop, showWs), refHost as unknown as DomNode);
  return ((refHost.querySelector(".editor") as Element).innerHTML).split(refPath).join("@@PATH@@");
}

describe("editor row vnode cache", () => {
  it("typing repaints the line; untouched rows keep their DOM node; structure equals a fresh mount", () => {
    const path = nextPath();
    let buf = bufferFromContent("alpha\nbravo\ncharlie\ndelta\necho one\n");
    const { host, commit } = mountEditor(path, sess(path, buf));
    const row2 = rowEl(host, 2);
    const row5 = rowEl(host, 5);
    expect(row2).not.toBeNull();
    expect(row5).not.toBeNull();

    buf = typeChar(buf, "x", 1000); // caret (0,0): line 0 grows
    rerender(path, sess(path, buf), commit);
    expect(text(host.querySelector('.editor-line[data-line="1"] .editor-code')!).startsWith("xalpha")).toBe(true);
    expect(rowEl(host, 2)).toBe(row2); // untouched rows: SAME nodes (subtree bailout)
    expect(rowEl(host, 5)).toBe(row5);
    expect(stripPath(host, path)).toBe(refStructure(sess(path, buf)));
  });

  it("a multi-line selection paints its rows and only its rows", () => {
    const path = nextPath();
    let buf = bufferFromContent("aaa\nbbb\nccc\nddd\neee");
    const { host, commit } = mountEditor(path, sess(path, buf));
    buf = selectRange(buf, { line: 1, col: 1 }, { line: 3, col: 2 }); // rows 2..4 (1-based)
    rerender(path, sess(path, buf), commit);
    expect(host.querySelector('.editor-line[data-line="2"] .editor-sel')).not.toBeNull();
    expect(host.querySelector('.editor-line[data-line="4"] .editor-sel')).not.toBeNull();
    expect(host.querySelector('.editor-line[data-line="5"] .editor-sel')).toBeNull();
    expect(stripPath(host, path)).toBe(refStructure(sess(path, buf)));
  });

  it("a cached row's mousedown commits against the CURRENT buffer -- no stale rollback", () => {
    const path = nextPath();
    let buf = bufferFromContent("aaa\nbbb\nccc");
    const { host, commits, commit } = mountEditor(path, sess(path, buf));
    // Type at the END of line 2 (0-based): row 1 stays untouched/cached.
    buf = setCaret(buf, { line: 2, col: 3 });
    buf = insertText(buf, "ZZZZ", { kind: "block", time: 2000 });
    rerender(path, sess(path, buf), commit);
    const row1 = rowEl(host, 1);
    expect(row1).not.toBeNull();
    // Click row 1 at x=24 (fallback cell width 8 -> column 3). The
    // dom-helper DEvent's own preventDefault marks the press handled, so
    // the viewport background gate ignores the bubbling click (browser parity).
    row1!.dispatchEvent({
      type: "mousedown",
      currentTarget: row1,
      clientX: 24,
      shiftKey: false,
      altKey: false,
    } as unknown as Event);
    expect(commits).toHaveLength(1);
    const [committedPath, next] = commits[0]!;
    expect(committedPath).toBe(path);
    // The committed buffer is derived from the LATEST render -- the typed
    // tail survived (a stale closure would ship a session whose lines lack
    // ZZZZ and the app would revert the edit).
    expect(next.buffer.lines.join("\n")).toBe("aaa\nbbb\ncccZZZZ");
    expect(next.buffer.sels[next.buffer.primary]!.head).toEqual({ line: 0, col: 3 });
  });

  it("scroll commits the SAME session object (the view-only poke contract) and windows the rows", () => {
    const path = nextPath();
    const buf = bufferFromContent(`${Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")}\n`);
    const session = sess(path, buf);
    const { host, commits, commit } = mountEditor(path, session);
    const vp = host.querySelector(".editor-viewport") as Element;
    const row21 = rowEl(host, 21); // inside BOTH windows -- must survive
    vp.dispatchEvent({ type: "scroll", currentTarget: { scrollTop: 400, clientHeight: 400 } } as unknown as Event);
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]).toBe(session); // view-only poke: the session object rides unchanged
    rerender(path, session, commit);
    expect(rowEl(host, 21)).toBe(row21); // the shared row rode the window unchanged
  });

  it("bracket match paints, survives a view-only re-render (memo hit), and tracks edits (memo miss)", () => {
    const path = nextPath();
    let buf = setCaret(bufferFromContent("const a = f(1);"), { line: 0, col: 11 }); // right ON the '('
    const { host, commit } = mountEditor(path, sess(path, buf));
    expect(host.querySelectorAll(".editor-match")).toHaveLength(2);
    // Same session, fresh props: memo hit -- highlights still there, row node reused.
    const r1 = rowEl(host, 1);
    rerender(path, sess(path, buf), commit);
    expect(rowEl(host, 1)).toBe(r1);
    expect(host.querySelectorAll(".editor-match")).toHaveLength(2);
    // Edit + move: the pair context is gone -- no highlights left.
    buf = setCaret(buf, { line: 0, col: 0 });
    buf = typeChar(buf, "x", 3000);
    rerender(path, sess(path, buf), commit);
    expect(host.querySelectorAll(".editor-match")).toHaveLength(0);
    expect(stripPath(host, path)).toBe(refStructure(sess(path, buf)));
  });

  it("the whitespace pref paints marks and renders byte-identical to a fresh ws-on mount", () => {
    const path = nextPath();
    const buf = bufferFromContent("let a\t= 1  ");
    const { host, commit } = mountEditor(path, sess(path, buf));
    expect(host.querySelector(".ws-glyph")).toBeNull();
    rerender(path, sess(path, buf), commit, true);
    expect(host.querySelector(".ws-glyph")).not.toBeNull();
    expect(stripPath(host, path)).toBe(refStructure(sess(path, buf), true));
  });
});
