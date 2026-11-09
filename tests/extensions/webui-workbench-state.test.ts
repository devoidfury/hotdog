// Unit tests for the workbench tab-state module (workbench-state.ts): pure
// operations (open idempotency, neighbour activation on close, close-all ->
// zero) plus the store shell (change-only notify). No DOM is imported here.

import { describe, it, expect } from "bun:test";
import {
  createWorkbenchStore,
  emptyWorkbenchState,
  openTab,
  closeTab,
  activateTab,
  setTabLabel,
  setTabDirty,
  type WorkbenchTab,
  type WorkbenchTabState,
} from "@extensions/webui/ui/workbench-state.ts";

const tab = (id: string, over: Partial<WorkbenchTab> = {}): WorkbenchTab => ({
  id,
  kind: "placeholder",
  label: id,
  dirty: false,
  ...over,
});

/** Open a,b,c in order: active is always the last opened. */
function state3(): WorkbenchTabState {
  return openTab(openTab(openTab(emptyWorkbenchState(), tab("a")), tab("b")), tab("c"));
}

describe("openTab", () => {
  it("appends and activates", () => {
    const s = openTab(emptyWorkbenchState(), tab("a"));
    expect(s.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(s.activeId).toBe("a");
    const s2 = openTab(s, tab("b"));
    expect(s2.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s2.activeId).toBe("b");
  });

  it("is idempotent by id: reopen activates without duplicating or clobbering", () => {
    const s = openTab(openTab(openTab(emptyWorkbenchState(), tab("a")), tab("b")), tab("a"));
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s.activeId).toBe("a");
    // The stored tab keeps its own label/dirty -- reopen carries no writes.
    let s2 = openTab(emptyWorkbenchState(), tab("a", { label: "keep.txt", dirty: true }));
    s2 = openTab(s2, tab("b"));
    s2 = openTab(s2, tab("a", { label: "fresh.txt", dirty: false }));
    expect(s2.tabs).toHaveLength(2);
    expect(s2.activeId).toBe("a");
    expect(s2.tabs[0]).toEqual({ id: "a", kind: "placeholder", label: "keep.txt", dirty: true });
  });

  it("keeps ids unique under repeated opens", () => {
    let s = emptyWorkbenchState();
    for (let i = 0; i < 5; i++) s = openTab(s, tab("dup"));
    expect(s.tabs.map((t) => t.id)).toEqual(["dup"]);
  });

  it("never mutates the state it was handed", () => {
    const before = emptyWorkbenchState();
    openTab(before, tab("a"));
    expect(before.tabs).toHaveLength(0);
  });
});

describe("closeTab", () => {
  it("closing the ACTIVE tab activates the right neighbour", () => {
    // state3() leaves "c" active, so activation is taken explicitly: this
    // must exercise the ACTIVE-close branch, not the untouched-id shortcut.
    // Regression guard: preferring the LEFT neighbour here (tabs[i - 1])
    // fails this test -- it would activate "a", not "c".
    const s = closeTab(activateTab(state3(), "b"), "b"); // a, [b], c -> c inherits the index
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "c"]);
    expect(s.activeId).toBe("c");
  });

  it("closing the active LAST tab falls back to the left neighbour", () => {
    const s = closeTab(state3(), "c");
    expect(s.activeId).toBe("b");
  });

  it("closing an inactive tab leaves the active one alone", () => {
    const s = closeTab(state3(), "a");
    expect(s.tabs.map((t) => t.id)).toEqual(["b", "c"]);
    expect(s.activeId).toBe("c");
  });

  it("closing the last tab leaves zero tabs and no active id", () => {
    const one = openTab(emptyWorkbenchState(), tab("only"));
    const s = closeTab(one, "only");
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
    // Closing from zero changes nothing.
    expect(closeTab(s, "ghost")).toBe(s);
  });

  it("an unknown id changes nothing", () => {
    const s = state3();
    expect(closeTab(s, "zzz")).toBe(s);
  });
});

describe("activateTab", () => {
  it("activates a known tab", () => {
    const s = activateTab(state3(), "a");
    expect(s.activeId).toBe("a");
    expect(s.tabs).toHaveLength(3);
  });

  it("unknown ids and re-activation return the same state", () => {
    const s = state3();
    expect(activateTab(s, "ghost")).toBe(s);
    expect(activateTab(s, "c")).toBe(s);
  });
});

describe("label/dirty writers (future phases)", () => {
  it("rename touches only the label", () => {
    const s = state3();
    const renamed = setTabLabel(s, "b", "notes.md");
    expect(renamed.tabs.find((t) => t.id === "b")?.label).toBe("notes.md");
    expect(renamed.tabs.find((t) => t.id === "a")).toEqual(tab("a"));
    expect(renamed.activeId).toBe(s.activeId);
    // Purity: the original state is untouched.
    expect(s.tabs.find((t) => t.id === "b")?.label).toBe("b");
  });

  it("dirty flips both ways and nothing else", () => {
    const s = setTabDirty(state3(), "a", true);
    expect(s.tabs.find((t) => t.id === "a")?.dirty).toBe(true);
    const back = setTabDirty(s, "a", false);
    expect(back.tabs.find((t) => t.id === "a")?.dirty).toBe(false);
  });

  it("writers on unknown ids are no-ops", () => {
    const s = state3();
    expect(setTabLabel(s, "ghost", "x")).toBe(s);
    expect(setTabDirty(s, "ghost", true)).toBe(s);
  });
});

describe("createWorkbenchStore", () => {
  it("opens, activates, and closes through the ops", () => {
    const store = createWorkbenchStore();
    store.open(tab("a"));
    store.open(tab("b"));
    expect(store.get().activeId).toBe("b");
    store.activate("a");
    expect(store.get().activeId).toBe("a");
    store.close("a");
    expect(store.get().activeId).toBe("b");
    store.close("b");
    expect(store.get()).toEqual({ tabs: [], activeId: null });
  });

  it("notifies subscribers only on actual change", () => {
    const store = createWorkbenchStore();
    let bumps = 0;
    const stop = store.subscribe(() => bumps++);
    store.open(tab("a"));
    expect(bumps).toBe(1);
    store.activate("a"); // already active: no-op, no notify
    store.close("ghost"); // unknown: no-op, no notify
    expect(bumps).toBe(1);
    store.close("a");
    expect(bumps).toBe(2);
    stop();
    store.open(tab("z"));
    expect(bumps).toBe(2);
  });

  it("start label/dirty through the store surface", () => {
    const store = createWorkbenchStore();
    store.open(tab("a"));
    store.setLabel("a", "renamed");
    store.setDirty("a", true);
    const t = store.get().tabs[0]!;
    expect(t.label).toBe("renamed");
    expect(t.dirty).toBe(true);
  });
});
