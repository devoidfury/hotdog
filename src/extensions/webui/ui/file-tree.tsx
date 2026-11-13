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
// - ONE side channel breaks the purity on purpose: the expanded-path set
//   persists to sessionStorage (see "Expansion memory" below). emptyFileTree
//   seeds from it, so restoration rides the re-request machinery above with
//   no new fetch path and no app.tsx wiring; toggleDir writes it back on
//   every expand/collapse.

import type { DirEntryWire, FileRootWire, ListDirResultWire } from "@extensions/websocket/protocol.ts";
import { IconReload } from "./icons.tsx";
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
  /**
   * The revealed path (revealDir): the row matching it renders selected
   * until the next reveal or refresh. Pure display state -- no storage, no
   * fetch consequence; null = nothing revealed.
   */
  selected: string | null;
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

// ── Expansion memory (sessionStorage) ───────────────────────────────────────
// WHICH paths are expanded survives a reload, per TAB. sessionStorage, never
// localStorage: the localStorage half of the webui doctrine (drafts, prefs)
// is deliberately shared across tabs, and every tab would otherwise inherit
// (and overwrite) every other tab's tree. Same guard shape as chat.ts's
// reconnect identity. Only the expanded-true path set rides, sorted, under
// one key. Restoration seeds `expanded`; the open/refresh machinery then
// re-requests the roots AND every expanded dir exactly as it does for a
// tree the user opened by hand. Honest failures: a stored path that no
// longer lists answers with the server's one-liner (error row, collapsible,
// pending drains -- never a hang), and the roots reply prunes expansions
// that live under no current root, so the next persist drops them quietly.

export const FILE_TREE_EXPANDED_STORAGE_KEY = "hotdog-webui-file-tree-expanded";

/** Resolved per call (chat.ts:781-789 guard, re-read rather than cached:
 *  the dom-helper installs and tears down window storage per test). */
function expandedStorage(): Storage | null {
  return typeof window !== "undefined" && "sessionStorage" in window
    ? (window as unknown as { sessionStorage: Storage }).sessionStorage
    : null;
}

/** The stored expanded set. Missing key, throwing storage, or corrupt /
 *  non-string-array JSON all mean the same honest thing: start flat. */
function storedExpanded(): string[] {
  const storage = expandedStorage();
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(FILE_TREE_EXPANDED_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** Called from toggleDir on every expand/collapse. An empty set removes the
 *  key outright (that is also how a fully-collapsed tree forgets vanished
 *  roots). Storage failures (quota, blocked) keep the tree in memory. */
function persistExpanded(expanded: Record<string, boolean>): void {
  const storage = expandedStorage();
  if (!storage) return;
  const paths = Object.keys(expanded).filter((p) => expanded[p]).sort();
  try {
    if (paths.length === 0) storage.removeItem(FILE_TREE_EXPANDED_STORAGE_KEY);
    else storage.setItem(FILE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // The tree stays true in memory; nothing to retry, nothing to announce.
  }
}

/** A path is live only under a current root (the server's confinement says
 *  the same thing: listDir refuses everything else). Trailing separators on
 *  a root path do not double up; both separators count for Windows roots. */
function underAnyRoot(path: string, roots: FileRootWire[]): boolean {
  return roots.some((r) => {
    const base = r.path.replace(/[/\\]+$/, "");
    return path === r.path || path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
  });
}

/** Seed the map from storage: the restored tree re-requests itself the
 *  moment it opens (see the header doctrine); no key -> flat. */
export function emptyFileTree(): FileTreeState {
  const expanded: Record<string, boolean> = {};
  for (const path of storedExpanded()) expanded[path] = true;
  return { roots: null, dirs: {}, expanded, selected: null, seq: 0, pending: {} };
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
    state: { roots: { status: "loading", entries: [] }, dirs, expanded: s.expanded, selected: s.selected, seq, pending },
    fetches,
  };
}

/**
 * REVEAL a path (the subagent row menu's "Reveal run directory"): expand
 * every ancestor plus the path itself, mark it selected, then run the tree
 * through the EXISTING open machinery (roots re-request + every expanded dir
 * re-request -- the doctrine's "re-request on every tree open", so reveal
 * adds zero new fetch logic). Honest degradation for free: the roots reply
 * already prunes expansions that live under no current root, so a run dir
 * outside the workspace roots self-clears and simply renders no row; a dir
 * that lists-error keeps the server's verbatim one-liner on its row. Paths
 * are absolute POSIX (the server's join() built them); relative input
 * expands nothing new and only re-selects.
 */
export function revealDir(s: FileTreeState, path: string): { state: FileTreeState; fetches: TreeFetch[] } {
  const expanded = { ...s.expanded };
  // Absolute paths only: a relative one has no meaningful ancestor chain in
  // the tree's coordinate space (rows live under absolute roots), so it just
  // selects -- and no row can match it anyway. Run dirs are absolute by
  // construction (the engine's join of an absolute runs root).
  if (path.startsWith("/")) {
    let cur = "";
    for (const seg of path.split("/")) {
      if (!seg) continue; // absolute leading "" and any doubled slashes
      cur = `${cur}/${seg}`;
      expanded[cur] = true;
    }
  }
  persistExpanded(expanded);
  return openFileTree({ ...s, expanded, selected: path });
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
    persistExpanded(expanded);
    return { state: { ...s, expanded }, fetch: null };
  }
  const cached = s.dirs[path];
  if (cached && cached.status !== "error") {
    const expanded = { ...s.expanded, [path]: true };
    persistExpanded(expanded);
    return { state: { ...s, expanded }, fetch: null };
  }
  const seq = s.seq + 1;
  const expanded = { ...s.expanded, [path]: true };
  persistExpanded(expanded);
  const state: FileTreeState = {
    ...s,
    seq,
    dirs: { ...s.dirs, [path]: { status: "loading", entries: [] } },
    expanded,
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
    if (result.error) {
      // Roots unknown: nothing is pruned (an error must not collapse the tree).
      return { ...s, pending, roots: { status: "error", entries: [], error: result.error } };
    }
    const roots = result.roots ?? [];
    // The roots reply is the authority on what exists. An expansion living
    // under no current root (a vanished workspace) can never render -- its
    // row is gone -- so it leaves the state here and the next expand/collapse
    // persist drops it from the store quietly. Errored listings of paths that
    // DO live under a root keep their expanded posture: the machinery renders
    // the server's line as a collapsible error row.
    let expanded = s.expanded;
    const dead = Object.keys(s.expanded).filter((p) => s.expanded[p] && !underAnyRoot(p, roots));
    if (dead.length > 0) {
      expanded = { ...s.expanded };
      for (const p of dead) delete expanded[p];
    }
    return { ...s, pending, expanded, roots: { status: "ok", entries: roots } };
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
  const selected = tree.selected === entry.path;
  const open = (): void => (entry.isDir ? onToggleDir(entry.path) : onOpenFile(entry.path));
  const title = entry.isSymlink
    ? `${entry.path} (symlink -- target not resolved)`
    : entry.size !== undefined
      ? `${entry.path} (${entry.size} bytes)`
      : entry.path;
  return (
    <div
      className={`ft-row${entry.isDir ? " ft-dir" : " ft-file"}${selected ? " ft-selected" : ""}`}
      data-path={entry.path}
      data-depth={depth}
      aria-current={selected ? "true" : undefined}
    >
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
          className="file-reload-btn"
          title="Re-list the roots and every expanded directory"
          aria-label="Refresh"
          onClick={p.onRefresh}
        >
          <IconReload className="file-reload-glyph" />
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
            const selected = p.tree.selected === root.path;
            return (
              <div
                className={`ft-row ft-root${selected ? " ft-selected" : ""}`}
                data-path={root.path}
                data-depth={0}
                key={root.path}
                aria-current={selected ? "true" : undefined}
              >
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
