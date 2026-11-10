/// <reference lib="dom" />
// DOM tests for the workspace file tree (file-tree.tsx) on the dom-helper:
// the pure op doctrine (lazy expand fetches once then serves the cache,
// open/refresh re-requests, stale requestIds drop as the SAME state object),
// verbatim rendering of the server's honest error text, symlink rows, and
// the row events (click opens / right-click hands the path to the app's
// ContextMenu). Plus the tab-level pins: the "file" tab id IS the path, so
// opening the same path twice yields ONE tab (openTab idempotence), and the
// workbench body switch paints the two new kinds.

import { describe, it, expect, afterEach } from "bun:test";
import {
  FileTree,
  emptyFileTree,
  openFileTree,
  toggleDir,
  applyListDir,
  filesTab,
  FILES_TAB_ID,
  type FileTreeState,
} from "@extensions/webui/ui/file-tree.tsx";
import { WorkbenchPanel } from "@extensions/webui/ui/workbench.tsx";
import { createWorkbenchStore } from "@extensions/webui/ui/workbench-state.ts";
import type { DirEntryWire, ListDirResultWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

let current: Mounted | null = null;

function entry(name: string, isDir = false, extra: Partial<DirEntryWire> = {}): DirEntryWire {
  return { name, path: `/rootA/${name}`, isDir, ...extra };
}

function treeWith(over: Partial<FileTreeState> = {}): FileTreeState {
  return { ...emptyFileTree(), ...over };
}

function renderTree(props: Partial<Parameters<typeof FileTree>[0]> = {}): HTMLElement {
  const host = document.createElement("div");
  current = mount(
    <FileTree
      tree={props.tree ?? emptyFileTree()}
      onToggleDir={props.onToggleDir ?? noop}
      onOpenFile={props.onOpenFile ?? noop}
      onRefresh={props.onRefresh ?? noop}
      onContextMenu={props.onContextMenu ?? noop}
    />,
    host as unknown as DomNode,
  );
  return host.querySelector(".file-tree") as unknown as HTMLElement;
}

afterEach(() => {
  current?.unmount();
  current = null;
});

const text = (el: Element | null): string => el?.textContent ?? "";
const click = (el: Element | null): void => (el as unknown as HTMLElement).click();
const contextEvent = (el: Element, type = "contextmenu", key?: string): boolean =>
  // No preventDefault on the payload: dom-helper's Object.assign would shadow
  // DEvent.preventDefault and the "was it prevented?" return flips to a lie.
  (el as unknown as HTMLElement).dispatchEvent({
    type,
    key,
    currentTarget: el,
    clientX: 10,
    clientY: 10,
  } as unknown as Event);

// ── Pure ops: laziness, cache, re-request, stale drop ───────────────────────

describe("file tree state ops", () => {
  it("open requests the roots with no path; refresh bumps ids and replaces the pending map", () => {
    const { state, fetches } = openFileTree(emptyFileTree());
    expect(fetches).toEqual([{ requestId: 1 }]);
    expect(state.roots?.status).toBe("loading");
    expect(state.pending).toEqual({ "1": "" });
    const again = openFileTree(state);
    expect(again.fetches).toEqual([{ requestId: 2 }]);
    // The previous in-flight id is GONE from pending: its reply is stale.
    expect(again.state.pending["1"]).toBeUndefined();
  });

  it("open re-requests every EXPANDED dir and re-arms them as loading", () => {
    let s = treeWith({
      expanded: { "/rootA/sub": true, "/rootA/docs": true },
      dirs: { "/rootA/sub": { status: "ok", entries: [entry("x.txt")] } },
    });
    const { state, fetches } = openFileTree(s);
    expect(fetches).toEqual([
      { requestId: 1 },
      { requestId: 2, path: "/rootA/sub" },
      { requestId: 3, path: "/rootA/docs" },
    ]);
    expect(state.dirs["/rootA/sub"]?.status).toBe("loading");
  });

  it("lazy expansion: the FIRST expand fetches, the reply caches, re-expanding serves the cache", () => {
    const s0 = treeWith({ roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }] } });
    const { state: s1, fetch } = toggleDir(s0, "/rootA");
    expect(fetch).toEqual({ requestId: 1, path: "/rootA" });
    // A second click while the request is in flight fetches nothing new
    // (it just collapses; the pending request stays in the map and its
    // reply will land in the cache anyway).
    const { state: s1b, fetch: fetchAgain } = toggleDir(s1, "/rootA");
    expect(fetchAgain).toBeNull();
    expect(s1b.expanded["/rootA"]).toBeUndefined(); // collapse drops the key
    // The reply lands; collapse then re-expand serves the cache (no fetch).
    const replied = applyListDir(s1, 1, {
      type: "listDirResult",
      requestId: 1,
      path: "/rootA",
      entries: [entry("sub", true)],
    });
    const { state: s2 } = toggleDir(replied, "/rootA"); // collapse
    const { state: s3, fetch: fetch3 } = toggleDir(s2, "/rootA"); // expand again
    expect(fetch3).toBeNull();
    expect(s3.dirs["/rootA"]?.entries.map((e) => e.name)).toEqual(["sub"]);
  });

  it("an ERRORED dir re-fetches on the next expand (the tree must not stick on a stale refusal)", () => {
    const s0 = treeWith({
      dirs: { "/rootA": { status: "error", entries: [], error: "permission denied: /rootA" } },
    });
    const { state, fetch } = toggleDir(s0, "/rootA");
    expect(fetch).toEqual({ requestId: 1, path: "/rootA" });
    expect(state.dirs["/rootA"]?.status).toBe("loading");
    expect(state.expanded["/rootA"]).toBe(true);
  });

  it("stale requestIds drop: unknown ids and undefined return the SAME state object", () => {
    const { state } = openFileTree(emptyFileTree());
    const canned: ListDirResultWire = { type: "listDirResult", requestId: 1, roots: [] };
    expect(applyListDir(state, undefined, canned)).toBe(state);
    expect(applyListDir(state, 999, canned)).toBe(state);
    const applied = applyListDir(state, 1, { type: "listDirResult", requestId: 1, roots: [{ name: "rootA", path: "/rootA" }] });
    expect(applied.roots?.status).toBe("ok");
    // The consumed id is out of pending: a redelivered reply cannot rewrite.
    expect(applyListDir(applied, 1, canned)).toBe(applied);
  });

  it("the error reply rides the dir slot verbatim; the truncated flag rides", () => {
    const s0 = treeWith();
    const { state } = toggleDir(s0, "/rootA");
    const errored = applyListDir(state, 1, {
      type: "listDirResult",
      requestId: 1,
      path: "/rootA",
      error: "Symlink escape rejected: link-etc",
    });
    expect(errored.dirs["/rootA"]).toEqual({
      status: "error",
      entries: [],
      error: "Symlink escape rejected: link-etc",
    });
    const capped = applyListDir(state, 1, {
      type: "listDirResult",
      requestId: 1,
      path: "/rootA",
      entries: [entry("a")],
      truncated: true,
    });
    expect(capped.dirs["/rootA"]?.truncated).toBe(true);
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe("file tree rendering", () => {
  it("roots render as top rows; clicking a root toggles by its ABSOLUTE path", () => {
    let toggled = "";
    const root = renderTree({
      tree: treeWith({
        roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }, { name: "rootB", path: "/rootB" }] },
      }),
      onToggleDir: (p) => {
        toggled = p;
      },
    });
    const rows = Array.from(root.querySelectorAll(".ft-root")) as unknown as HTMLElement[];
    expect(rows.map((r) => text(r.querySelector(".ft-name")))).toEqual(["rootA", "rootB"]);
    click(rows[0]!.querySelector(".ft-row-btn"));
    expect(toggled).toBe("/rootA");
  });

  it("empty roots answer honestly; loading states render", () => {
    const root = renderTree({ tree: treeWith({ roots: { status: "ok", entries: [] } }) });
    expect(text(root.querySelector(".ft-note"))).toContain("No configured workspace roots");
    const loading = renderTree({ tree: treeWith({ roots: { status: "loading", entries: [] } }) });
    expect(text(loading.querySelector(".ft-loading"))).toContain("Listing");
  });

  it("expanded dir states: loading line, server error VERBATIM, entries + truncated note", () => {
    const mk = (dir: FileTreeState["dirs"][string]): HTMLElement =>
      renderTree({
        tree: treeWith({
          roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }] },
          expanded: { "/rootA": true },
          dirs: { "/rootA": dir },
        }),
      });
    expect(text(mk({ status: "loading", entries: [] }).querySelector(".ft-loading"))).toContain("Listing");
    const errored = mk({ status: "error", entries: [], error: "not found: /gone" });
    expect(text(errored.querySelector(".ft-error"))).toBe("not found: /gone");
    const capped = mk({ status: "ok", entries: [entry("a.txt")], truncated: true });
    expect(text(capped.querySelector(".ft-note"))).toContain("truncated");
  });

  it("clicking a FILE row opens the path; dir rows toggle; symlink rows flag themselves", () => {
    let opened = "";
    let toggled = "";
    const root = renderTree({
      tree: treeWith({
        roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }] },
        expanded: { "/rootA": true },
        dirs: {
          "/rootA": {
            status: "ok",
            entries: [entry("sub", true), entry("secret.txt"), entry("link-etc", false, { isSymlink: true })],
          },
        },
      }),
      onOpenFile: (p) => {
        opened = p;
      },
      onToggleDir: (p) => {
        toggled = p;
      },
    });
    const rows = Array.from(root.querySelectorAll(".ft-file")) as unknown as HTMLElement[];
    expect(rows).toHaveLength(2); // a plain file and a symlink row (links are not dirs)
    click(rows[0]!.querySelector(".ft-row-btn"));
    expect(opened).toBe("/rootA/secret.txt");
    click(root.querySelector(".ft-dir .ft-row-btn"));
    expect(toggled).toBe("/rootA/sub");
    const link = root.querySelector('[data-path="/rootA/link-etc"]')!;
    expect(link.querySelector(".ft-symlink")).toBeTruthy();
    expect(link.querySelector(".ft-row-btn")!.getAttribute("title")).toContain("target not resolved");
  });

  it("right-click and Menu/Shift+F10 hand (event, path, rowEl) to the app's menu", () => {
    const seen: string[] = [];
    const root = renderTree({
      tree: treeWith({
        roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }] },
      }),
      onContextMenu: (e, path) => {
        seen.push(`${e.type}:${path}`);
      },
    });
    const rowBtn = root.querySelector(".ft-root .ft-row-btn")!;
    expect(contextEvent(rowBtn)).toBe(false); // prevented
    contextEvent(rowBtn, "keydown", "ContextMenu");
    contextEvent(rowBtn, "keydown", "x"); // strangers pass
    expect(seen).toEqual(["contextmenu:/rootA", "keydown:/rootA"]);
  });

  it("Refresh re-issues", () => {
    let refreshes = 0;
    const root = renderTree({ onRefresh: () => refreshes++ });
    click(root.querySelector(".ft-btn"));
    expect(refreshes).toBe(1);
  });
});

// ── Tab identity + the workbench body switch ─────────────────────────────────

describe("file tabs on the workbench", () => {
  it('the "files" tab id keys the root list; a "file" tab id IS its path, so opening the same path twice yields ONE tab', () => {
    const store = createWorkbenchStore();
    store.open(filesTab());
    store.open(filesTab());
    expect(store.get().tabs).toHaveLength(1);
    expect(store.get().tabs[0]!.id).toBe(FILES_TAB_ID);
    expect(store.get().tabs[0]!.kind).toBe("files");

    store.open({ id: "/rootA/a.txt", kind: "file", label: "a.txt", dirty: false });
    store.open({ id: "/rootA/a.txt", kind: "file", label: "a.txt", dirty: false });
    expect(store.get().tabs).toHaveLength(2); // files + a.txt, never a dup
    expect(store.get().activeId).toBe("/rootA/a.txt");
  });

  const panelHarness = (store: ReturnType<typeof createWorkbenchStore>) => {
    const host = document.createElement("div");
    const wire = {
      tree: treeWith({ roots: { status: "ok", entries: [{ name: "rootA", path: "/rootA" }] } }),
      onToggleDir: noop,
      onOpenFile: noop,
      onRefresh: noop,
      onContextMenu: noop,
    };
    const mounted = mount(
      <WorkbenchPanel
        collapsed={false}
        width={420}
        min={320}
        max={900}
        state={store.get()}
        onActivate={(id) => store.activate(id)}
        onCloseTab={(id) => store.close(id)}
        onResizeStart={noop as never}
        onResizeMove={noop as never}
        onResizeEnd={noop as never}
        onResizeKey={noop as never}
        onResizeReset={noop as never}
        fileTree={wire}
        fileViews={{ views: {}, onReload: noop, onMore: noop }}
        onOpenFiles={() => store.open(filesTab())}
      />,
      host as unknown as DomNode,
    );
    current?.unmount();
    current = mounted;
    return host;
  };

  it("zero tabs: the honest line AND the file-tree entry button", () => {
    const store = createWorkbenchStore();
    const host = panelHarness(store);
    expect(text(host.querySelector("#workbench-empty"))).toBe("Files will open here");
    click(host.querySelector("#workbench-open-files"));
    expect(store.get().tabs.map((t) => t.id)).toEqual([FILES_TAB_ID]);
  });

  it("kind dispatch: files -> the tree, file -> the viewer or its pending body, placeholder -> the untouched line", () => {
    const store = createWorkbenchStore();
    store.open(filesTab());
    store.open({ id: "/rootA/a.txt", kind: "file", label: "a.txt", dirty: false });
    store.open({ id: "old", kind: "placeholder", label: "old", dirty: false });
    const host = panelHarness(store);
    // Active is the LAST opened (placeholder) -- its body is byte-identical.
    expect(text(host.querySelector(".workbench-placeholder"))).toContain("placeholder body");
    store.activate(FILES_TAB_ID);
    const host2 = panelHarness(store);
    expect(host2.querySelector(".file-tree")).toBeTruthy();
    store.activate("/rootA/a.txt");
    const host3 = panelHarness(store);
    expect(host3.querySelector(".file-view")).toBeTruthy();
  });
});
