/// <reference lib="dom" />
// The workbench: a right-docked, resizable, collapsible pane that lives
// beside the chat column. The shell (this file) rides the panel-resize seam
// (axis x, nearEdge: its handle is on the panel's left edge, so dragging
// left GROWS it) and the WAI tab strip; the real kinds "files" (workspace
// tree) and "file" (read-only viewer) are wired by app.tsx through the
// optional wire props. The placeholder kind stays byte-identical for
// anything else.
//
// - ZERO TABS HIDES THE STRIP: with nothing to select or close, a tablist
//   would be an empty widget; the body shows one muted line instead (plus
//   the file-tree entry-point button when the app wires one).
// - COLLAPSED UNMOUNTS the panel (returns null): a default-closed pane
//   costs nothing at rest, and a detached handle cannot be dragged anyway
//   (the seam's enabled() gate is the second lock).
// - DRAG-REORDER deferred: the pointer machinery would fight tab-switching
//   for the same gesture.
// - MOBILE (max-width 768px): the open panel becomes a full-width overlay
//   and the handle hides -- CSS owns the width there, nothing to drag (the
//   seam's offsetParent guard agrees); the header toggle is the only entry
//   point. The pinned tree column STACKS above the tab column there (the
//   overlay's width is the viewport; two side-by-side columns would lie).
// - TREE DOCK PIN (file-tree header, beside Refresh): while pinned the
//   "files" tab leaves the strip and its body becomes a fixed left column
//   beside strip+viewer -- the sessions-sidebar/chat shape mirrored into
//   the dock. PURE PROJECTION: the store never learns about it (open/
//   close/activate/persistence untouched); releasing the pin restores every
//   tab to its seat. The width gate lives in app.tsx.
//
// Storage doctrine rides the seam (panel-resize.ts): blocked storage costs
// the reload, never the interaction.

import {
  createWorkbenchStore,
  type WorkbenchStore,
  type WorkbenchTab,
  type WorkbenchTabState,
} from "./workbench-state.ts";
import { FileTree, type FileTreePin, type FileTreeState } from "./file-tree.tsx";
import { FileView, type FileViewEntry } from "./file-view.tsx";

/** Body wiring for the two real tab kinds; app.tsx owns the state and the
 *  socket, the bodies are dumb projections. Optional: without wiring the
 *  kinds fall through to the placeholder (tests drive the shell alone). */
export interface WorkbenchFileTreeWire {
  tree: FileTreeState;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onContextMenu: (e: MouseEvent | KeyboardEvent, path: string, rowEl: HTMLElement) => void;
}

export interface WorkbenchFileViewsWire {
  views: Record<string, FileViewEntry>;
  onReload: (path: string) => void;
  onMore: (path: string) => void;
}

/** The app's tab store. Tab producers (the phases that open files, settings,
 *  diffs) import this and call open(); app.tsx subscribes render() to it. */
export const workbenchStore = createWorkbenchStore();

// ── Tab persistence (sessionStorage, per tab) ──────────────────────────────
// WHICH tabs were open (ids + labels + kinds) and WHICH was active survives
// an in-tab reload. sessionStorage, never localStorage: localStorage is
// shared across browser tabs, so tab B's pane would inherit (and clobber)
// tab A's tabs. Every storage op is swallowed at the boundary: blocked or
// quota'd storage costs the reload, never the pane. The pane's collapsed
// state + width stay on the panel-resize seam's own localStorage keys --
// a browser-wide view preference, a different question.
//
// Record: {"tabs":[{id,kind,label}],"activeId":...}. Only the real kinds
// ("files", "file") persist -- placeholders are demo content (an active
// placeholder falls back to the first persisted tab, so the record never
// names a tab the decoder would reject). `dirty` is not stored (display-
// only, no writer). An empty list persists AS empty: close the last tab,
// reload, see none. Anything failing validation decodes to null and boots
// zero tabs, silently: garbage JSON, a non-object record, unknown kinds,
// empty or duplicate ids, or an activeId violating the state invariant
// (non-null exactly when non-empty, always naming a live tab). A half-open
// tab set is worse than none: ids double as paths and DOM ids.

export const WORKBENCH_TABS_KEY = "hotdog.workbenchTabs";

/** Resolved per call, never cached: tests install and tear down window
 *  storage between tests. */
function tabsStorage(): Storage | null {
  return typeof window !== "undefined" && "sessionStorage" in window
    ? (window as unknown as { sessionStorage: Storage }).sessionStorage
    : null;
}

function isStoredTab(v: unknown): v is WorkbenchTab {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id !== "" &&
    typeof t.label === "string" &&
    (t.kind === "files" || t.kind === "file")
  );
}

/** The stored tab set; null for a missing key, throwing storage, or anything
 *  failing validation (start from zero, never half-load). */
export function loadStoredWorkbenchTabs(): WorkbenchTabState | null {
  const storage = tabsStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(WORKBENCH_TABS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { tabs, activeId } = parsed as Record<string, unknown>;
    if (!Array.isArray(tabs)) return null;
    const stored: WorkbenchTab[] = [];
    for (const entry of tabs) {
      if (!isStoredTab(entry)) return null;
      stored.push({ id: entry.id, kind: entry.kind, label: entry.label, dirty: false });
    }
    const ids = new Set(stored.map((t) => t.id));
    if (ids.size !== stored.length) return null;
    if (stored.length === 0) return activeId === null ? { tabs: [], activeId: null } : null;
    if (typeof activeId !== "string" || !ids.has(activeId)) return null;
    return { tabs: stored, activeId };
  } catch {
    return null;
  }
}

/** Write the current tab set (app.tsx subscribes this to the store: every
 *  open/close/activate lands here). Storage failures keep the pane true in
 *  memory. */
export function persistWorkbenchTabs(state: WorkbenchTabState): void {
  const storage = tabsStorage();
  if (!storage) return;
  const tabs = state.tabs
    .filter((t) => t.kind === "files" || t.kind === "file")
    .map((t) => ({ id: t.id, kind: t.kind, label: t.label }));
  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : tabs[0]?.id ?? null;
  try {
    storage.setItem(WORKBENCH_TABS_KEY, JSON.stringify({ tabs, activeId }));
  } catch {
    // Swallowed at the boundary.
  }
}

/** Boot seed (app.tsx init() -- call BEFORE the render/persist
 *  subscriptions): re-dock the stored tabs in order and land on the stored
 *  active tab through the store's own open/activate, so idempotence and the
 *  neighbor rules stay in one place. Absent/garbage record: the store keeps
 *  what it has (a real boot: zero tabs). */
export function seedWorkbenchStoreFromStorage(target: WorkbenchStore = workbenchStore): void {
  const stored = loadStoredWorkbenchTabs();
  if (!stored) return;
  for (const tab of stored.tabs) target.open(tab);
  if (stored.activeId !== null) target.activate(stored.activeId);
}

interface WorkbenchPanelProps {
  /** Collapsed = unmounted. Mirrors the seam's flag via app.tsx's atom. */
  collapsed: boolean;
  /** Current width and the aria clamps -- one source with the seam's own
   *  clamps (size()/maxSize() are fed straight from the panel object). */
  width: number;
  min: number;
  max: number;
  state: WorkbenchTabState;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  // The five seam gestures, bound straight to the left-edge handle (same
  // markup idiom as #sidebar-resize: focusable separator, arrow steps,
  // double-click reset).
  onResizeStart: (e: PointerEvent) => void;
  onResizeMove: (e: PointerEvent) => void;
  onResizeEnd: (e: PointerEvent) => void;
  onResizeKey: (e: KeyboardEvent) => void;
  onResizeReset: (e: MouseEvent) => void;
  /** Kind "files": the workspace tree body (see file-tree.tsx). */
  fileTree?: WorkbenchFileTreeWire;
  /** Kind "file": the read-only viewer bodies, keyed by path (= tab id). */
  fileViews?: WorkbenchFileViewsWire;
  /** Zero-tabs affordance: dock the "files" tab (the app opens it and
   *  re-requests the roots). Absent = no button (shell-only tests). */
  onOpenFiles?: () => void;
  /** Tree dock pin wiring (see the header and file-tree.tsx FileTreePin).
   *  Only meaningful with the fileTree wire: a pin with no tree to dock
   *  docks nothing, so the panel ignores it. */
  treePin?: FileTreePin;
}

/**
 * Manual-activation tab grammar: arrows (and Home/End) move FOCUS among the
 * tab buttons -- roving tabindex travels with it -- and Enter or a click
 * activates. The close buttons are plain tab stops outside that ring.
 */
function onTabKeydown(e: KeyboardEvent, tabs: WorkbenchTab[], index: number, activate: (id: string) => void): void {
  const btn = e.currentTarget as HTMLElement | null;
  // button -> .workbench-tab wrapper -> #workbench-tabs tablist. children is
  // elements-only in both the browser and the test DOM, so wrappers index
  // exactly like the tab array.
  const tablist = btn?.parentElement?.parentElement ?? null;
  if (!tablist) return;

  let target = -1;
  if (e.key === "ArrowRight") target = (index + 1) % tabs.length;
  else if (e.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
  else if (e.key === "Home") target = 0;
  else if (e.key === "End") target = tabs.length - 1;
  else if (e.key === "Enter") {
    // Real browsers also synthesize a click for Enter on a <button>;
    // activation is idempotent, so double delivery is harmless.
    e.preventDefault();
    activate(tabs[index]!.id);
    return;
  } else return;

  e.preventDefault();
  const next = (tablist.children[target] as HTMLElement | undefined)?.children[0] as HTMLElement | undefined;
  if (!next || next === btn) return;
  btn!.setAttribute("tabindex", "-1");
  next.setAttribute("tabindex", "0");
  next.focus();
}

export function WorkbenchPanel(p: WorkbenchPanelProps) {
  // Collapsed: nothing mounts -- not a hidden node, no DOM at all. See the
  // header for why, and app.tsx for the default-collapsed seed.
  if (p.collapsed) return null;

  const tabs = p.state.tabs;
  const active = tabs.find((t) => t.id === p.state.activeId) ?? null;
  // Dock-pin projection (see the header): a pin without a wired tree docks
  // nothing, so the wire decides whether the state exists at all. While
  // pinned the "files" tab IS the fixed column: it leaves the strip, and
  // its hidden body must not keep the body column occupied either. The
  // store never sees any of this -- pure projection.
  const treePin = p.treePin && p.fileTree ? p.treePin : undefined;
  const pinned = treePin?.pinned === true;
  const stripTabs = pinned ? tabs.filter((t) => t.kind !== "files") : tabs;
  const bodyTab = pinned && active?.kind === "files" ? null : active;

  return (
    <aside id="workbench-panel" aria-label="Workbench" className={pinned ? "workbench-tree-pinned" : undefined}>
      {/* Left-edge handle straddling the border with the chat column.
          nearEdge (see app.tsx workbenchPanel): drag LEFT to grow. */}
      <div
        id="workbench-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench width"
        aria-valuenow={p.width}
        aria-valuemin={p.min}
        aria-valuemax={p.max}
        tabindex="0"
        onPointerdown={p.onResizeStart}
        onPointermove={p.onResizeMove}
        onPointerup={p.onResizeEnd}
        onPointercancel={p.onResizeEnd}
        onKeydown={p.onResizeKey}
        onDblclick={p.onResizeReset}
      />
      {pinned ? (
        // The docked tree: full panel height, its own scroll (CSS owns the
        // column), header and all -- the pin button rides along in it.
        <div className="workbench-tree-col">
          <FileTree
            tree={p.fileTree!.tree}
            onToggleDir={p.fileTree!.onToggleDir}
            onOpenFile={p.fileTree!.onOpenFile}
            onRefresh={p.fileTree!.onRefresh}
            onContextMenu={p.fileTree!.onContextMenu}
            pin={treePin}
          />
        </div>
      ) : null}
      {/* Flat, this wrapper is display:contents (pixel-identical to the old
          flat panel); pinned, it is the flex sibling right of the column. */}
      <div className="workbench-main-col">
      {stripTabs.length > 0 ? (
        // The strip exists only when there are tabs to operate on (decision:
        // zero tabs -> strip hidden, the empty line speaks). Drag-reorder
        // deferred -- see the header.
        <div id="workbench-tabs" role="tablist" aria-label="Workbench tabs" aria-orientation="horizontal">
          {stripTabs.map((t, i) => (
            <div key={t.id} className={`workbench-tab${t.id === p.state.activeId ? " active" : ""}`}>
              <button
                type="button"
                role="tab"
                className="workbench-tab-label"
                // tab <-> panel wiring: the tab id is the identity root for
                // both DOM ids (openTab uniqueness keeps them collision-free;
                // producers keep ids DOM-safe).
                id={`wtab-${t.id}`}
                aria-controls={`wpanel-${t.id}`}
                aria-selected={t.id === p.state.activeId ? "true" : "false"}
                tabindex={t.id === p.state.activeId ? "0" : "-1"}
                title={t.label}
                onClick={() => p.onActivate(t.id)}
                onKeydown={(e: KeyboardEvent) => onTabKeydown(e, stripTabs, i, p.onActivate)}
              >
                {t.label}
                {/* Visual dirty marker; the meaning arrives with real tabs
                    (writers: setTabDirty). Decorative for readers for now. */}
                {t.dirty ? (
                  <span className="workbench-dirty" aria-hidden="true" title="Unsaved changes">
                    •
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="workbench-tab-close"
                aria-label="Close tab"
                title={`Close ${t.label}`}
                onClick={() => p.onCloseTab(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div id="workbench-body">
        {bodyTab ? (
          // Keyed by tab id: switching tabs remounts the body instead of
          // patching one placeholder into another. Bodies stay placeholders
          // until real tab kinds land. tabindex="0" per the WAI pattern: the
          // panel body is empty of widgets today, so Tab must be able to
          // reach the content the tab points at.
          <div
            key={bodyTab.id}
            id={`wpanel-${bodyTab.id}`}
            className="workbench-tab-body"
            role="tabpanel"
            aria-labelledby={`wtab-${bodyTab.id}`}
            tabindex="0"
          >
            {bodyTab.kind === "files" && p.fileTree ? (
              <FileTree
                tree={p.fileTree.tree}
                onToggleDir={p.fileTree.onToggleDir}
                onOpenFile={p.fileTree.onOpenFile}
                onRefresh={p.fileTree.onRefresh}
                onContextMenu={p.fileTree.onContextMenu}
                pin={treePin}
              />
            ) : bodyTab.kind === "file" && p.fileViews ? (
              <FileView
                path={bodyTab.id}
                view={p.fileViews.views[bodyTab.id]}
                onReload={p.fileViews.onReload}
                onMore={p.fileViews.onMore}
              />
            ) : (
              <p className="workbench-placeholder">
                {bodyTab.label} -- placeholder body; real tab content ships with the tab kinds.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Pinned, the tree is already docked right beside this line --
                the entry button would re-activate a tab that has no seat,
                so it speaks only in tab mode. */}
            <p id="workbench-empty" className="workbench-empty">
              Files will open here
            </p>
            {p.onOpenFiles && !pinned ? (
              // Entry point for the first real tab kind: docks the "files"
              // tab (the app opens it and re-requests the roots).
              <button type="button" id="workbench-open-files" className="workbench-empty-btn" onClick={p.onOpenFiles}>
                Open the workspace file tree
              </button>
            ) : null}
          </>
        )}
      </div>
      </div>
    </aside>
  );
}
