// Workbench tab state: the pure half of the right-docked pane (workbench.tsx
// renders it, app.tsx wires it). Zero DOM, zero storage, zero dependencies --
// every operation is (state, args) -> new state, so a producer mutates by
// handing the current value to an operation and storing the result back.
//
// NO PERSISTENCE IN THIS PHASE, on purpose: no tab producers exist yet (the
// file tree / settings viewer are later phases), so tabs are born with the
// page and die with it. Persisting placeholder tabs across reloads would
// encode nothing true. When the first real tab kind lands, its open/close
// writes ride the same localStorage doctrine the panels already use.
//
// `kind` is deliberately a one-member union. Real kinds (file, settings,
// diff) widen it when they ship; consumers must not switch on it yet.

export type WorkbenchTabKind = "placeholder";

export interface WorkbenchTab {
  /** Stable identity: reopening the same target reuses the same id (openTab
   *  is idempotent by it, so ids double as the uniqueness guarantee). */
  id: string;
  kind: WorkbenchTabKind;
  label: string;
  /** Unsaved-changes flag; the strip shows the dot. Written by future
   *  phases (setTabDirty), display-only for now. */
  dirty: boolean;
}

export interface WorkbenchTabState {
  tabs: WorkbenchTab[];
  /** The selected tab. Non-null whenever tabs is non-empty; null only at zero. */
  activeId: string | null;
}

export function emptyWorkbenchState(): WorkbenchTabState {
  return { tabs: [], activeId: null };
}

/**
 * Open a tab and make it active. Idempotent by id: a tab that is already
 * open is only activated -- its existing label/dirty survive, because
 * "reopen" must not wipe the state a later phase hangs off the tab.
 */
export function openTab(state: WorkbenchTabState, tab: WorkbenchTab): WorkbenchTabState {
  if (state.tabs.some((t) => t.id === tab.id)) return activateTab(state, tab.id);
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Close a tab. Closing the ACTIVE one activates the nearest remaining
 * neighbour: the tab that inherited its index (its right side), falling
 * back to the left neighbour when it was the last one. Closing the last
 * tab leaves zero tabs and activeId null -- the honest empty state.
 * Unknown ids change nothing (a stale close click is not an event).
 */
export function closeTab(state: WorkbenchTabState, id: string): WorkbenchTabState {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const tabs = state.tabs.filter((_, j) => j !== i);
  const activeId = state.activeId === id ? tabs[Math.min(i, tabs.length - 1)]?.id ?? null : state.activeId;
  return { tabs, activeId };
}

/** Select a tab. Unknown id or already-active: same state back. */
export function activateTab(state: WorkbenchTabState, id: string): WorkbenchTabState {
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return state;
  return { tabs: state.tabs, activeId: id };
}

/** Rename a tab (writer reserved for the phases that own the content). */
export function setTabLabel(state: WorkbenchTabState, id: string, label: string): WorkbenchTabState {
  return mapTab(state, id, () => ({ label }));
}

/** Mark/unmark unsaved changes on a tab. */
export function setTabDirty(state: WorkbenchTabState, id: string, dirty: boolean): WorkbenchTabState {
  return mapTab(state, id, () => ({ dirty }));
}

function mapTab(
  state: WorkbenchTabState,
  id: string,
  patch: (t: WorkbenchTab) => Partial<WorkbenchTab>,
): WorkbenchTabState {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const tabs = [...state.tabs];
  tabs[i] = { ...tabs[i]!, ...patch(tabs[i]!) };
  return { tabs, activeId: state.activeId };
}

// ── Store ──────────────────────────────────────────────────────────────────
// The reactive shell the operations run inside. Listeners only (no DOM, no
// atom): app.tsx subscribes render(), a producer calls open()/close(). One
// notify per actual change -- a no-op operation never invalidates the tree.

export interface WorkbenchStore {
  get(): WorkbenchTabState;
  open(tab: WorkbenchTab): void;
  close(id: string): void;
  activate(id: string): void;
  setLabel(id: string, label: string): void;
  setDirty(id: string, dirty: boolean): void;
  /** Returns the unsubscribe. Listeners must throw nothing; they run inline. */
  subscribe(fn: () => void): () => void;
}

export function createWorkbenchStore(initial: WorkbenchTabState = emptyWorkbenchState()): WorkbenchStore {
  let state = initial;
  const listeners = new Set<() => void>();

  function apply(next: WorkbenchTabState): void {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) fn();
  }

  return {
    get: () => state,
    open: (tab) => apply(openTab(state, tab)),
    close: (id) => apply(closeTab(state, id)),
    activate: (id) => apply(activateTab(state, id)),
    setLabel: (id, label) => apply(setTabLabel(state, id, label)),
    setDirty: (id, dirty) => apply(setTabDirty(state, id, dirty)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
