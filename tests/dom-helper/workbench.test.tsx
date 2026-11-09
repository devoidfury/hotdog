/// <reference lib="dom" />
// DOM tests for the workbench pane shell (workbench.tsx) on the dom-helper,
// driven through a REAL panel-resize seam instance wired exactly like
// app.tsx (axis x, nearEdge, the same two storage keys, enabled-gate,
// onCollapseChange -> rerender). Covers: collapsed default (chat area
// untouched), toggle open/close, the tab strip fed through the state module,
// close-button grammar, WAI tab keyboard, the handle's aria, the exact
// localStorage keys, and blocked-storage degradation keeping the interaction
// alive (seam doctrine).

import { describe, it, expect, afterEach } from "bun:test";
import { WorkbenchPanel } from "@extensions/webui/ui/workbench.tsx";
import { createWorkbenchStore, type WorkbenchStore } from "@extensions/webui/ui/workbench-state.ts";
import { createPanelResize, type PanelEnv, type PanelResize } from "@extensions/webui/ui/panel-resize.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

// ── Storage doubles (panel-resize.test.ts doctrine: swallow nothing here,
//    the seam swallows) ──────────────────────────────────────────────────────

class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStorage extends FakeStorage {
  override getItem(): never {
    throw new Error("SecurityError: storage access denied");
  }
  override setItem(): never {
    throw new Error("SecurityError: storage access denied");
  }
  override removeItem(): never {
    throw new Error("SecurityError: storage access denied");
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface H {
  panel: PanelResize;
  storage: FakeStorage;
  tabs: WorkbenchStore;
  q: (sel: string) => HTMLElement | null;
  destroy: () => void;
}

let current: H | null = null;

function harness(opts: { throwing?: boolean; seedCollapsed?: "0" | "1" } = {}): H {
  const storage = opts.throwing ? new ThrowingStorage() : new FakeStorage();
  // Pre-seeded visit: the stored choice lands BEFORE restore(), so the
  // seed-skip branch (app.tsx init()'s hasStoredWorkbenchCollapsed mirror)
  // is what decides the boot state -- an unconditional-seed regression
  // would overwrite "0" with "1" here and open-nothing on reload.
  if (opts.seedCollapsed !== undefined) storage.map.set("hotdog.workbenchCollapsed", opts.seedCollapsed);
  const tabs = createWorkbenchStore();
  let collapsed = true; // the app-level default (see init() seeding)

  const panel = createPanelResize(
    {
      axis: "x",
      sizeKey: "hotdog.workbenchWidth",
      collapsedKey: "hotdog.workbenchCollapsed",
      defaultSize: 420,
      min: 320,
      max: 900,
      viewportMax: () => 800, // the static 900 never binds here
      step: 16,
      coarseStep: 48,
      nearEdge: true,
      bodyClass: "workbench-resizing",
      enabled: () => !collapsed,
      paint: (width, el) => {
        document.documentElement.style.setProperty("--workbench-width", `${width}px`);
        el?.setAttribute("aria-valuenow", String(width));
      },
      onCollapseChange: (c) => {
        collapsed = c;
        renderAll();
      },
    },
    { storage: () => storage, body: () => document.body } as PanelEnv,
  );

  const container = document.createElement("div");
  document.body.appendChild(container);
  let app: Mounted | null = null;

  const tree = () => (
    <div id="main-ui">
      <main id="chat-area">
        <span id="chat-marker">chat</span>
      </main>
      <WorkbenchPanel
        collapsed={collapsed}
        width={panel.size()}
        min={320}
        max={panel.maxSize()}
        state={tabs.get()}
        onActivate={(id) => tabs.activate(id)}
        onCloseTab={(id) => tabs.close(id)}
        onResizeStart={panel.onPointerDown}
        onResizeMove={panel.onPointerMove}
        onResizeEnd={panel.onPointerUp}
        onResizeKey={panel.onKeyDown}
        onResizeReset={panel.onDoubleClick}
      />
    </div>
  );

  function renderAll(): void {
    app?.render(tree());
  }

  // Boot exactly like app.tsx init(): restore, seed first-run collapsed, mount.
  panel.restore();
  let storedCollapsed: string | null = null;
  try {
    storedCollapsed = storage.getItem("hotdog.workbenchCollapsed");
  } catch {
    storedCollapsed = null; // blocked storage reads as "no stored choice"
  }
  if (storedCollapsed === null) panel.toggle();
  collapsed = panel.collapsed();
  app = mount(tree(), container as unknown as DomNode);
  tabs.subscribe(renderAll);

  const h: H = {
    panel,
    storage,
    tabs,
    q: (sel) => container.querySelector(sel) as HTMLElement | null,
    destroy: () => {
      app?.unmount();
      container.remove();
    },
  };
  current?.destroy();
  current = h;
  return h;
}

afterEach(() => {
  current?.destroy();
  current = null;
});

// ── Event helpers (the app.test.tsx idioms) ────────────────────────────────

function liveHandle(): HTMLElement {
  const h = document.querySelector("#workbench-resize") as HTMLElement;
  const any = h as unknown as Record<string, unknown>;
  any.offsetParent ??= {};
  any.setPointerCapture ??= () => {};
  return h;
}

function pointer(el: HTMLElement, type: string, over: Record<string, unknown> = {}): void {
  el.dispatchEvent({ type, currentTarget: el, ...over } as unknown as Event);
}

function key(node: Element, k: string, over: Record<string, unknown> = {}): void {
  node.dispatchEvent({ type: "keydown", key: k, currentTarget: node, preventDefault: () => {}, ...over } as unknown as Event);
}

const widthVar = (): string =>
  (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style.getPropertyValue(
    "--workbench-width",
  );

const openTab = (id: string, over: Partial<{ label: string; dirty: boolean }> = {}): void => {
  const h = current!;
  h.tabs.open({ id, kind: "placeholder", label: over.label ?? id, dirty: over.dirty ?? false });
};

const tabButtons = (): HTMLElement[] =>
  Array.from(document.querySelectorAll("#workbench-tabs [role=tab]")) as HTMLElement[];

// ── Collapsed default + toggle ──────────────────────────────────────────────

describe("workbench default-collapsed mount", () => {
  it("renders the chat area unchanged and NO workbench DOM", () => {
    const h = harness();
    expect(h.q("#chat-area")).toBeTruthy();
    expect(h.q("#chat-marker")!.textContent).toBe("chat");
    expect(h.q("#workbench-panel")).toBeNull();
    expect(h.q("#workbench-resize")).toBeNull();
    expect(h.q("#workbench-tabs")).toBeNull();
  });

  it("the toggle opens the pane; toggling closed unmounts it again", () => {
    const h = harness();
    h.panel.toggle();
    expect(h.q("#workbench-panel")).toBeTruthy();
    expect(h.q("#workbench-resize")).toBeTruthy();
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("0");
    h.panel.toggle();
    expect(h.q("#workbench-panel")).toBeNull();
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("1");
  });

  it("a collapsed pane gates its gestures (no size to drag)", () => {
    const h = harness();
    h.panel.onPointerDown({ pointerId: 1, clientX: 100, clientY: 0, currentTarget: {} });
    expect(document.body.classList.contains("workbench-resizing")).toBe(false);
    expect(h.storage.map.has("hotdog.workbenchWidth")).toBe(false);
  });

  it("a stored '0' opens the pane on load and the seed is skipped (no overwrite)", () => {
    const h = harness({ seedCollapsed: "0" });
    expect(h.q("#workbench-panel")).toBeTruthy();
    expect(h.q("#workbench-resize")).toBeTruthy();
    // The reload round-trip: restore() alone decided this, never a seed
    // toggle -- an unconditional seed would have written "1" and closed it.
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("0");
  });

  it("a stored '1' stays closed on load and the first toggle persists '0'", () => {
    const h = harness({ seedCollapsed: "1" });
    expect(h.q("#workbench-panel")).toBeNull();
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("1"); // no seed churn
    h.panel.toggle();
    expect(h.q("#workbench-panel")).toBeTruthy();
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("0");
    h.panel.toggle();
    expect(h.storage.map.get("hotdog.workbenchCollapsed")).toBe("1");
  });
});

// ── The handle: aria + the seam's gestures ─────────────────────────────────

describe("workbench resize handle", () => {
  it("is a focusable vertical separator carrying the seam's numbers", () => {
    const h = harness();
    h.panel.toggle();
    const el = liveHandle();
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-label")).toBe("Resize workbench width");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-valuenow")).toBe("420");
    expect(el.getAttribute("aria-valuemin")).toBe("320");
    expect(el.getAttribute("aria-valuemax")).toBe("800"); // viewport clamp beats 900
  });

  it("nearEdge: dragging LEFT grows the pane, release persists; mid-drag writes nothing", () => {
    const h = harness();
    h.panel.toggle();
    pointer(liveHandle(), "pointerdown", { pointerId: 1, clientX: 600 });
    expect(document.body.classList.contains("workbench-resizing")).toBe(true);
    pointer(liveHandle(), "pointermove", { pointerId: 1, clientX: 560 }); // 40px left = +40px
    expect(widthVar()).toBe("460px");
    expect(liveHandle().getAttribute("aria-valuenow")).toBe("460");
    expect(h.storage.map.has("hotdog.workbenchWidth")).toBe(false);
    pointer(liveHandle(), "pointermove", { pointerId: 1, clientX: 1000 }); // hard right, clamps at min
    expect(widthVar()).toBe("320px");
    pointer(liveHandle(), "pointerup", { pointerId: 1, clientX: 1000 });
    expect(document.body.classList.contains("workbench-resizing")).toBe(false);
    expect(h.storage.map.get("hotdog.workbenchWidth")).toBe("320");
  });

  it("keyboard: ArrowLeft grows (nearEdge grammar), Home/End clamp, strangers pass", () => {
    const h = harness();
    h.panel.toggle();
    const el = liveHandle();
    key(el, "ArrowLeft");
    expect(el.getAttribute("aria-valuenow")).toBe("436");
    key(el, "ArrowRight", { shiftKey: true });
    expect(el.getAttribute("aria-valuenow")).toBe("388");
    key(el, "End");
    expect(el.getAttribute("aria-valuenow")).toBe("800");
    key(el, "Home");
    expect(el.getAttribute("aria-valuenow")).toBe("320");
    key(el, "a");
    expect(el.getAttribute("aria-valuenow")).toBe("320");
    expect(h.storage.map.get("hotdog.workbenchWidth")).toBe("320");
  });

  it("double-click resets to the default and forgets the stored width", () => {
    const h = harness();
    h.panel.toggle();
    const el = liveHandle();
    key(el, "ArrowLeft");
    expect(h.storage.map.has("hotdog.workbenchWidth")).toBe(true);
    el.dispatchEvent({ type: "dblclick", currentTarget: el } as unknown as Event);
    expect(widthVar()).toBe("420px");
    expect(h.storage.map.has("hotdog.workbenchWidth")).toBe(false);
  });

  it("localStorage keys are EXACTLY hotdog.workbenchWidth + hotdog.workbenchCollapsed", () => {
    const h = harness();
    h.panel.toggle();
    key(liveHandle(), "ArrowLeft");
    h.panel.toggle();
    h.panel.toggle();
    expect([...h.storage.map.keys()].sort()).toEqual(["hotdog.workbenchCollapsed", "hotdog.workbenchWidth"]);
  });
});

// ── Tab strip fed through the state module ─────────────────────────────────

describe("workbench tab strip", () => {
  it("zero tabs: strip hidden, one honest line", () => {
    const h = harness();
    h.panel.toggle();
    expect(h.q("#workbench-tabs")).toBeNull();
    expect(h.q("#workbench-empty")!.textContent).toBe("Files will open here");
  });

  it("tabs injected via the state module paint the strip; the body follows the active tab", () => {
    const h = harness();
    h.panel.toggle();
    openTab("a.txt");
    openTab("b.txt", { dirty: true });
    const tabs = tabButtons();
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true"); // last opened activates
    expect(document.querySelector(".workbench-tab.active")!.textContent).toContain("b.txt");
    expect(tabs[1]!.querySelector(".workbench-dirty")).toBeTruthy(); // dirty dot
    expect(tabs[0]!.querySelector(".workbench-dirty")).toBeNull();
    expect(h.q(".workbench-tab-body")!.textContent).toContain("b.txt");
    // The strip is a real tablist.
    expect(h.q("#workbench-tabs")!.getAttribute("role")).toBe("tablist");
    // Tab <-> panel wiring: ids cross-reference off the tab id and the
    // panel is focusable (WAI pattern), so AT can traverse tab -> panel.
    expect(tabs[1]!.getAttribute("id")).toBe("wtab-b.txt");
    expect(tabs[1]!.getAttribute("aria-controls")).toBe("wpanel-b.txt");
    const panel = h.q("[id=wpanel-b.txt]")!; // only the ACTIVE tab's panel exists
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("wtab-b.txt");
    expect(panel.getAttribute("tabindex")).toBe("0");
  });

  it("click activates; the empty state returns only when the LAST tab closes", () => {
    const h = harness();
    h.panel.toggle();
    openTab("a.txt");
    openTab("b.txt");
    tabButtons()[0]!.click();
    expect(tabButtons()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(h.q(".workbench-tab-body")!.textContent).toContain("a.txt");
    // Close the ACTIVE tab (a): the neighbour (b) inherits activation.
    const closeBtns = Array.from(document.querySelectorAll(".workbench-tab-close")) as HTMLElement[];
    expect(closeBtns).toHaveLength(2);
    expect(closeBtns[0]!.getAttribute("aria-label")).toBe("Close tab");
    expect(closeBtns[0]!.textContent).toBe("×");
    closeBtns[0]!.click();
    expect(tabButtons()).toHaveLength(1);
    expect(tabButtons()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabButtons()[0]!.textContent).toContain("b.txt");
    // Close the last one: strip gone, honest line back.
    (document.querySelector(".workbench-tab-close") as HTMLElement).click();
    expect(h.q("#workbench-tabs")).toBeNull();
    expect(h.q("#workbench-empty")).toBeTruthy();
  });

  it("keyboard: arrows rove focus and tabindex, Enter activates", () => {
    const h = harness();
    h.panel.toggle();
    openTab("a.txt");
    openTab("b.txt"); // active
    const tabs = tabButtons();
    // From the active (rightmost) tab ArrowRight wraps to the first.
    key(tabs[1]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[0] as unknown as Element);
    expect(tabs[0]!.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("-1");
    // Focus moved but selection did NOT (manual activation): b is still selected.
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    // Enter activates the focused tab.
    key(tabs[0]!, "Enter");
    expect(tabButtons()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(h.q(".workbench-tab-body")!.textContent).toContain("a.txt");
  });
});

// ── Storage doctrine ────────────────────────────────────────────────────────

describe("workbench with blocked storage", () => {
  it("boot, toggle, drag, and tab ops all keep working with nothing persisted", () => {
    const h = harness({ throwing: true });
    // Seed ran against a throwing getItem and did not take the session down.
    expect(h.q("#workbench-panel")).toBeNull();
    h.panel.toggle(); // open
    expect(h.q("#workbench-panel")).toBeTruthy();
    pointer(liveHandle(), "pointerdown", { pointerId: 3, clientX: 500 });
    pointer(liveHandle(), "pointermove", { pointerId: 3, clientX: 460 });
    expect(widthVar()).toBe("460px");
    expect(liveHandle().getAttribute("aria-valuenow")).toBe("460");
    pointer(liveHandle(), "pointerup", { pointerId: 3, clientX: 460 });
    expect(h.storage.map.size).toBe(0); // nothing ever persisted
    openTab("a.txt");
    expect(tabButtons()).toHaveLength(1);
    h.panel.toggle(); // close
    expect(h.q("#workbench-panel")).toBeNull();
  });
});
