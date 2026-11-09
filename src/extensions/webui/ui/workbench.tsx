/// <reference lib="dom" />
// The workbench: a right-docked, resizable, collapsible pane that lives
// beside the chat column. This phase ships the SHELL -- the drag handle
// riding the panel-resize seam (axis x, nearEdge: its handle is on the
// panel's left edge, so dragging left GROWS it), the tab strip, and honest
// placeholders. No tab producers exist yet; the store and the ops live in
// workbench-state.ts.
//
// Documented decisions:
// - ZERO TABS HIDES THE STRIP: with nothing to select or close, a tablist
//   would be an empty widget; the body shows one muted line instead.
// - COLLAPSED UNMOUNTS the panel entirely (returns null): today's layout
//   renders exactly as before until the user opens the pane, and a detached
//   handle cannot be dragged by anything (the seam's enabled() gate is the
//   second lock).
// - DRAG-REORDER IS DEFERRED to the phase that ships real tabs (file tree /
//   settings viewer): reordering placeholder tabs exercises nothing, and the
//   pointer machinery would fight tab-switching for the same gesture.
// - MOBILE (max-width 768px): the open panel becomes a full-width overlay
//   and the handle hides -- like the sidebar drawer, CSS owns the width, so
//   there is nothing to drag (the seam's offsetParent guard agrees). The
//   header toggle stays the only entry point.
//
// Storage doctrine rides the seam (panel-resize.ts): blocked storage costs
// the reload, never the interaction.

import { createWorkbenchStore, type WorkbenchTab, type WorkbenchTabState } from "./workbench-state.ts";

/** The app's tab store. Tab producers (the phases that open files, settings,
 *  diffs) import this and call open(); app.tsx subscribes render() to it. */
export const workbenchStore = createWorkbenchStore();

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

  return (
    <aside id="workbench-panel" aria-label="Workbench">
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
      {tabs.length > 0 ? (
        // The strip exists only when there are tabs to operate on (decision:
        // zero tabs -> strip hidden, the empty line speaks). Drag-reorder
        // deferred -- see the header.
        <div id="workbench-tabs" role="tablist" aria-label="Workbench tabs" aria-orientation="horizontal">
          {tabs.map((t, i) => (
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
                onKeydown={(e: KeyboardEvent) => onTabKeydown(e, tabs, i, p.onActivate)}
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
        {active ? (
          // Keyed by tab id: switching tabs remounts the body instead of
          // patching one placeholder into another. Bodies stay placeholders
          // until real tab kinds land. tabindex="0" per the WAI pattern: the
          // panel body is empty of widgets today, so Tab must be able to
          // reach the content the tab points at.
          <div
            key={active.id}
            id={`wpanel-${active.id}`}
            className="workbench-tab-body"
            role="tabpanel"
            aria-labelledby={`wtab-${active.id}`}
            tabindex="0"
          >
            <p className="workbench-placeholder">
              {active.label} -- placeholder body; real tab content ships with the tab kinds.
            </p>
          </div>
        ) : (
          <p id="workbench-empty" className="workbench-empty">
            Files will open here
          </p>
        )}
      </div>
    </aside>
  );
}
