/// <reference lib="dom" />
// The workspace FILE TREE: the workbench's "files" tab body. Read-only
// listing of the server's workspace roots (C2S listDir, see
// ../websocket/handlers-files.ts for the confinement rules -- the server
// answers with honest one-line strings for every rejection class; this file
// renders them VERBATIM, never re-derived).
//
// State doctrine (settings-view.tsx precedent, all of it PURE so the DOM is
// a dumb projection):
// - One monotonic sequence; every open/refresh issues fresh request ids and
//   REPLACES the pending map, so a late reply for a superseded id finds no
//   entry and drops (applyListDir returns the same state object).
// - Lazy expansion: a dir fetches on FIRST expand; while expanded its
//   listing is cached (re-expanding after a collapse serves the cache --
//   only refresh re-requests, and only an errored entry re-fetches).
// - Tree open/refresh re-requests the roots AND every currently-expanded
//   directory ("re-request on every tree open").
// - The ops return { state, fetches } -- the APP dispatches the fetches over
//   the socket (this module never touches chat), which keeps correlation
//   honest: the id is minted here, recorded in `pending`, and the reply is
//   matched there or dropped.

import type { DirEntryWire, FileRootWire, ListDirResultWire } from "@extensions/websocket/protocol.ts";
import type { WorkbenchTab } from "./workbench-state.ts";

/** The tree tab's stable id (openTab reuses it; the tab keys the root list). */
export const FILES_TAB_ID = "files";

/** The tree tab descriptor -- producers open() this to dock the file tree. */
export function filesTab(): WorkbenchTab {
  return { id: FILES_TAB_ID, kind: "files", label: "Files", dirty: false };
}

export interface FileTreeDirState {
  status: "loading" | "ok" | "error";
  entries: DirEntryWire[];
  /** The server's honest one-line rejection (rendered verbatim). */
  error?: string;
  /** The server cut the listing at MAX_LIST_DIR_ENTRIES. */
  truncated?: boolean;
}

/** The roots listing keeps its own row shape (name + absolute path, no
 *  stat fields -- the no-path reply never touched the filesystem). */
export interface FileTreeRootsState {
  status: "loading" | "ok" | "error";
  entries: FileRootWire[];
  error?: string;
}

export interface FileTreeState {
  /** The roots listing; null until the first request. Error rides here too
   *  (the roots reply can fail -- e.g. a daemon predating the wire types). */
  roots: FileTreeRootsState | null;
  /** Cache + live state per expanded-or-expanding directory (absolute path). */
  dirs: Record<string, FileTreeDirState>;
  expanded: Record<string, boolean>;
  /** Monotonic request sequence. */
  seq: number;
  /** requestId (string-keyed, JSON-safe) -> the dir it asked for ("" = roots). */
  pending: Record<string, string>;
}

/** One listDir request an op wants the app to dispatch. */
export interface TreeFetch {
  requestId: number;
  /** Omitted on the roots request. */
  path?: string;
}

export function emptyFileTree(): FileTreeState {
  return { roots: null, dirs: {}, expanded: {}, seq: 0, pending: {} };
}

/**
 * Tree open / refresh: re-request the roots and every expanded directory.
 * The fresh pending map invalidates anything in flight (stale drops).
 * Expanded dirs go back to loading; collapsed caches survive until their
 * next expand... which does NOT happen without a click, and refresh only
 * re-requests what is expanded -- the honest cost of "re-request on open".
 */
export function openFileTree(s: FileTreeState): { state: FileTreeState; fetches: TreeFetch[] } {
  const fetches: TreeFetch[] = [];
  const pending: Record<string, string> = {};
  let seq = s.seq;
  const mint = (key: string, path?: string): void => {
    seq++;
    pending[String(seq)] = key;
    fetches.push(path !== undefined ? { requestId: seq, path } : { requestId: seq });
  };
  mint("");
  for (const dir of Object.keys(s.expanded)) {
    if (s.expanded[dir]) mint(dir, dir);
  }
  const dirs: Record<string, FileTreeDirState> = {};
  for (const key of Object.keys(s.dirs)) dirs[key] = s.dirs[key]!;
  for (const dir of Object.keys(s.expanded)) {
    if (s.expanded[dir]) dirs[dir] = { status: "loading", entries: [] };
  }
  return {
    state: { roots: { status: "loading", entries: [] }, dirs, expanded: s.expanded, seq, pending },
    fetches,
  };
}

/**
 * Expand or collapse a directory. Expansion fetches on FIRST expand only:
 * a cached ok listing serves from the cache, a cached error re-fetches
 * (the tree must not stick on a stale refusal), and a still-pending
 * expansion just reuses the request in flight. Collapse keeps the cache.
 */
export function toggleDir(s: FileTreeState, path: string): { state: FileTreeState; fetch: TreeFetch | null } {
  if (s.expanded[path]) {
    const expanded = { ...s.expanded };
    delete expanded[path];
    return { state: { ...s, expanded }, fetch: null };
  }
  const cached = s.dirs[path];
  if (cached && cached.status !== "error") {
    return { state: { ...s, expanded: { ...s.expanded, [path]: true } }, fetch: null };
  }
  const seq = s.seq + 1;
  const state: FileTreeState = {
    ...s,
    seq,
    dirs: { ...s.dirs, [path]: { status: "loading", entries: [] } },
    expanded: { ...s.expanded, [path]: true },
    pending: { ...s.pending, [String(seq)]: path },
  };
  return { state, fetch: { requestId: seq, path } };
}

/** Server reply. Unknown/superseded ids drop here (pending map empty for
 *  them): refresh mints new ids and replaces the map. */
export function applyListDir(
  s: FileTreeState,
  requestId: number | undefined,
  result: ListDirResultWire,
): FileTreeState {
  const key = requestId !== undefined ? s.pending[String(requestId)] : undefined;
  if (key === undefined) return s; // stale: superseded or unknown
  const pending = { ...s.pending };
  delete pending[String(requestId)];
  if (key === "") {
    const roots: FileTreeRootsState = result.error
      ? { status: "error", entries: [], error: result.error }
      : { status: "ok", entries: result.roots ?? [] };
    return { ...s, pending, roots };
  }
  const dir: FileTreeDirState = result.error
    ? { status: "error", entries: [], error: result.error }
    : {
        status: "ok",
        entries: result.entries ?? [],
        ...(result.truncated ? { truncated: true } : {}),
      };
  return { ...s, pending, dirs: { ...s.dirs, [key]: dir } };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface FileTreeProps {
  tree: FileTreeState;
  /** Expand/collapse click (the app runs toggleDir and dispatches the fetch). */
  onToggleDir: (path: string) => void;
  /** File click: the app opens a "file" tab (id = path) and reveals the pane. */
  onOpenFile: (path: string) => void;
  /** Re-request the roots + expanded dirs (fresh ids invalidate in-flight). */
  onRefresh: () => void;
  /** Right-click (and Menu/Shift+F10) on any row: the app arms the ContextMenu
   *  (Copy path; focus-return lives with the app's menu machinery). */
  onContextMenu: (e: MouseEvent | KeyboardEvent, path: string, rowEl: HTMLElement) => void;
}

/** Row-level keyboard/contextmenu wiring shared by every row kind (the
 *  sessions.tsx row idiom: Menu key or Shift+F10 fires the menu too). */
function rowEvents(path: string, onContextMenu: FileTreeProps["onContextMenu"]) {
  return {
    onContextmenu: (e: MouseEvent) => {
      e.preventDefault();
      onContextMenu(e, path, e.currentTarget as unknown as HTMLElement);
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        onContextMenu(e, path, e.currentTarget as unknown as HTMLElement);
      }
    },
  };
}

function DirChildren({ tree, path, depth, onToggleDir, onOpenFile, onContextMenu }: {
  tree: FileTreeState;
  path: string;
  depth: number;
  onToggleDir: (p: string) => void;
  onOpenFile: (p: string) => void;
  onContextMenu: FileTreeProps["onContextMenu"];
}) {
  const state = tree.dirs[path];
  if (!state || state.status === "loading") {
    return <div className="ft-note ft-loading">Listing...</div>;
  }
  if (state.status === "error") {
    // The server's honest one-liner, verbatim (never reworded, never hidden).
    return <div className="ft-note ft-error" role="status">{state.error}</div>;
  }
  return (
    <div className="ft-children">
      {state.entries.map((entry) => (
        <TreeRow
          key={entry.path}
          tree={tree}
          entry={entry}
          depth={depth}
          onToggleDir={onToggleDir}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
      {state.truncated ? (
        <div className="ft-note" role="status">
          Listing truncated by the server -- too many entries to show.
        </div>
      ) : null}
    </div>
  );
}

function TreeRow({ tree, entry, depth, onToggleDir, onOpenFile, onContextMenu }: {
  tree: FileTreeState;
  entry: DirEntryWire;
  depth: number;
  onToggleDir: (p: string) => void;
  onOpenFile: (p: string) => void;
  onContextMenu: FileTreeProps["onContextMenu"];
}) {
  const expanded = entry.isDir === true && tree.expanded[entry.path] === true;
  const open = (): void => (entry.isDir ? onToggleDir(entry.path) : onOpenFile(entry.path));
  const title = entry.isSymlink
    ? `${entry.path} (symlink -- target not resolved)`
    : entry.size !== undefined
      ? `${entry.path} (${entry.size} bytes)`
      : entry.path;
  return (
    <div className={`ft-row${entry.isDir ? " ft-dir" : " ft-file"}`} data-path={entry.path} data-depth={depth}>
      <button
        type="button"
        className="ft-row-btn"
        title={title}
        aria-expanded={entry.isDir ? (expanded ? "true" : "false") : undefined}
        onClick={open}
        {...rowEvents(entry.path, onContextMenu)}
      >
        <span className="ft-caret" aria-hidden="true">
          {entry.isDir ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span className="ft-name">{entry.name}</span>
        {entry.isSymlink ? <span className="ft-symlink" title="Symbolic link">↗</span> : null}
      </button>
      {expanded ? (
        <DirChildren
          tree={tree}
          path={entry.path}
          depth={depth + 1}
          onToggleDir={onToggleDir}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ) : null}
    </div>
  );
}

export function FileTree(p: FileTreeProps) {
  const roots = p.tree.roots;
  return (
    <div className="file-tree" role="tree" aria-label="Workspace files">
      <div className="ft-header">
        <span className="ft-header-label">Workspace</span>
        <button
          type="button"
          className="ft-btn"
          title="Re-list the roots and every expanded directory"
          onClick={p.onRefresh}
        >
          Refresh
        </button>
      </div>
      {!roots || roots.status === "loading" ? (
        <div className="ft-note ft-loading">Listing workspace...</div>
      ) : null}
      {roots && roots.status === "error" ? (
        <div className="ft-note ft-error" role="status">
          {roots.error ?? "The server did not answer the roots listing."}
        </div>
      ) : null}
      {roots && roots.status === "ok"
        ? roots.entries.map((root) => {
            const expanded = p.tree.expanded[root.path] === true;
            return (
              <div className="ft-row ft-root" data-path={root.path} data-depth={0} key={root.path}>
                <button
                  type="button"
                  className="ft-row-btn"
                  title={root.path}
                  aria-expanded={expanded ? "true" : "false"}
                  onClick={() => p.onToggleDir(root.path)}
                  {...rowEvents(root.path, p.onContextMenu)}
                >
                  <span className="ft-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                  <span className="ft-name">{root.name}</span>
                </button>
                {expanded ? (
                  <DirChildren
                    tree={p.tree}
                    path={root.path}
                    depth={1}
                    onToggleDir={p.onToggleDir}
                    onOpenFile={p.onOpenFile}
                    onContextMenu={p.onContextMenu}
                  />
                ) : null}
              </div>
            );
          })
        : null}
      {roots && roots.status === "ok" && roots.entries.length === 0 ? (
        <div className="ft-note">No configured workspace roots.</div>
      ) : null}
    </div>
  );
}
