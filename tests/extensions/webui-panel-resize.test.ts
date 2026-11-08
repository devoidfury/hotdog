// The panel-resize seam (ui/panel-resize.ts): clamp math, the persistence
// codec, and the whole drag/keyboard/reset/collapse lifecycle driven with
// fake envs -- no browser, no mock.module.
//
// The sidebar half of these pins is the migration parity proof: every case is
// the pre-seam behaviour restated (clamp table, "330" bytes on release, Home
// jumping to the static 200 rather than the viewport-tight value, reset
// forgetting the key, the CSS-hidden handle staying inert).

import { describe, it, expect } from "bun:test";
import {
  clampPanelSize,
  createPanelResize,
  decodeCollapsed,
  decodePanelSize,
  encodeCollapsed,
  encodePanelSize,
  panelCross,
  panelDragSign,
  panelDragSize,
  panelMaxSize,
  panelSizeForKey,
  type PanelEnv,
  type PanelResizeOptions,
} from "@extensions/webui/ui/panel-resize.ts";
import {
  LOGS_DEFAULT_HEIGHT,
  LOGS_MAX_HEIGHT,
  LOGS_MIN_HEIGHT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@extensions/webui/ui/utils.ts";

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeStorage {
  readonly map = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Private-mode Safari: every access throws. Extends the fake so the harness
 *  keeps one storage type (and its map stays empty, which is the assertion). */
class ThrowingStorage extends FakeStorage {
  override getItem(): string {
    throw new Error("SecurityError: storage access denied");
  }
  override setItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
  override removeItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
}

class FakeBody {
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string): void => void this.classes.add(name),
    remove: (name: string): void => void this.classes.delete(name),
  };
}

class FakeHandle {
  // Non-null by default: an offsetParent of null is the seam's "CSS-hidden"
  // probe, the same one the mobile drawer trips.
  offsetParent: unknown = {};
  focuses = 0;
  readonly captures: number[] = [];
  readonly attrs = new Map<string, string>();

  focus(): void {
    this.focuses++;
  }
  setPointerCapture(pointerId: number): void {
    this.captures.push(pointerId);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
}

interface Harness {
  panel: ReturnType<typeof createPanelResize>;
  storage: FakeStorage;
  body: FakeBody;
  handle: FakeHandle;
  /** Every paint, as "size@el?" -- the seam paints, it never re-renders. */
  painted: string[];
  collapsedFlips: boolean[];
}

function harness(over: Partial<PanelResizeOptions> = {}, storage?: FakeStorage): Harness {
  const store = storage ?? new FakeStorage();
  const body = new FakeBody();
  const handle = new FakeHandle();
  const painted: string[] = [];
  const collapsedFlips: boolean[] = [];
  const env: PanelEnv = { storage: () => store, body: () => body };
  const panel = createPanelResize(
    {
      axis: "x",
      sizeKey: "hotdog.sidebarWidth",
      defaultSize: SIDEBAR_DEFAULT_WIDTH,
      min: SIDEBAR_MIN_WIDTH,
      max: SIDEBAR_MAX_WIDTH,
      viewportMax: () => 1200 / 2,
      step: 16,
      coarseStep: 48,
      bodyClass: "resizing",
      paint: (size, el) => {
        painted.push(el ? `${size}@el` : `${size}`);
        el?.setAttribute("aria-valuenow", String(size));
      },
      onCollapseChange: (collapsed) => collapsedFlips.push(collapsed),
      ...over,
    },
    env,
  );
  return { panel, storage: store, body, handle, painted, collapsedFlips };
}

/** The seam's handlers take structural events; hand-build one. */
const pointer = (over: Partial<{ pointerId: number; clientX: number; clientY: number; currentTarget: unknown }>) => ({
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  currentTarget: undefined,
  ...over,
});
const keyboard = (over: Partial<{ key: string; shiftKey: boolean; currentTarget: unknown }>) => {
  const event = { key: "", shiftKey: false, currentTarget: undefined, prevented: false, ...over } as {
    key: string;
    shiftKey: boolean;
    currentTarget: unknown;
    prevented: boolean;
  };
  return {
    event,
    asArg: { ...event, preventDefault: () => void (event.prevented = true) },
  };
};

// ── Clamp math ──────────────────────────────────────────────────────────────

describe("clampPanelSize / panelMaxSize", () => {
  it("keeps in-range values and clamps both ends", () => {
    expect(clampPanelSize(300, 200, 520)).toBe(300);
    expect(clampPanelSize(50, 200, 520)).toBe(200);
    expect(clampPanelSize(800, 200, 520)).toBe(520);
  });

  it("lets min win when the ceiling fell below it", () => {
    expect(clampPanelSize(900, 200, 120)).toBe(200);
  });

  it("shrinks the ceiling to the viewport, and keeps min on degenerate viewports", () => {
    expect(panelMaxSize(200, 520, () => 450)).toBe(450);
    expect(panelMaxSize(200, 520, () => 100)).toBe(200);
    expect(panelMaxSize(200, 520)).toBe(520);
  });

  it("treats an unmeasurable viewport as no shrink rather than NaN", () => {
    // A host without window.innerHeight would otherwise poison every clamp --
    // and the CSS var with it.
    expect(panelMaxSize(96, 480, () => Number.NaN)).toBe(480);
    expect(clampPanelSize(300, 96, panelMaxSize(96, 480, () => undefined as unknown as number))).toBe(300);
  });

  it("reproduces the pre-seam sidebar clamp table exactly", () => {
    // Old: min(max(width, 200), max(200, min(520, vw/2)))
    const sidebar = (width: number, viewportWidth: number): number =>
      clampPanelSize(width, SIDEBAR_MIN_WIDTH, panelMaxSize(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, () => viewportWidth / 2));
    expect(sidebar(300, 1200)).toBe(300);
    expect(sidebar(50, 1200)).toBe(200);
    expect(sidebar(800, 1200)).toBe(520);
    expect(sidebar(500, 900)).toBe(450);
    expect(sidebar(100, 300)).toBe(200);
    expect(sidebar(0, 4000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebar(9999, 4000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebar(SIDEBAR_DEFAULT_WIDTH, 1200)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

// ── Axis math ───────────────────────────────────────────────────────────────

describe("axis math", () => {
  it("reads the axis the pointer travels along", () => {
    const e = { clientX: 40, clientY: 900 };
    expect(panelCross("x", e)).toBe(40);
    expect(panelCross("y", e)).toBe(900);
  });

  it("a far-edge handle grows with the pointer", () => {
    expect(panelDragSign()).toBe(1);
    expect(panelDragSize("x", { clientX: 330, clientY: 0 }, 300, 300)).toBe(330);
    expect(panelDragSize("x", { clientX: 280, clientY: 0 }, 300, 300)).toBe(280);
  });

  it("a near-edge handle grows against it: the titlebar drags UP to grow", () => {
    expect(panelDragSign(true)).toBe(-1);
    // The Recent Logs titlebar sits above the list: pointer up = taller list.
    expect(panelDragSize("y", { clientX: 0, clientY: 210 }, 240, 240, true)).toBe(270);
    expect(panelDragSize("y", { clientX: 0, clientY: 300 }, 240, 240, true)).toBe(180);
  });
});

// ── Keyboard math ───────────────────────────────────────────────────────────

describe("panelSizeForKey", () => {
  const x = { axis: "x" as const, min: 200, max: 520, step: 16, coarseStep: 48 };
  const y = { axis: "y" as const, min: LOGS_MIN_HEIGHT, max: LOGS_MAX_HEIGHT, step: 16, coarseStep: 48 };
  const yNear = { ...y, nearEdge: true };

  it("x: right grows, left shrinks, Shift is the coarse step", () => {
    expect(panelSizeForKey(x, { key: "ArrowRight", shiftKey: false }, 300)).toBe(316);
    expect(panelSizeForKey(x, { key: "ArrowLeft", shiftKey: false }, 300)).toBe(284);
    expect(panelSizeForKey(x, { key: "ArrowRight", shiftKey: true }, 300)).toBe(348);
    expect(panelSizeForKey(x, { key: "ArrowLeft", shiftKey: true }, 300)).toBe(252);
  });

  it("x: the vertical arrows are not ours (pre-seam parity)", () => {
    expect(panelSizeForKey(x, { key: "ArrowDown", shiftKey: false }, 300)).toBeNull();
    expect(panelSizeForKey(x, { key: "ArrowUp", shiftKey: false }, 300)).toBeNull();
    expect(panelSizeForKey(x, { key: "a", shiftKey: false }, 300)).toBeNull();
  });

  it("y near-edge: up grows, down shrinks", () => {
    expect(panelSizeForKey(yNear, { key: "ArrowUp", shiftKey: false }, 240)).toBe(256);
    expect(panelSizeForKey(yNear, { key: "ArrowDown", shiftKey: false }, 240)).toBe(224);
    expect(panelSizeForKey(yNear, { key: "ArrowUp", shiftKey: true }, 240)).toBe(288);
    expect(panelSizeForKey(y, { key: "ArrowDown", shiftKey: false }, 240)).toBe(256);
  });

  it("Home/End name the static limits on both axes and do not flip", () => {
    expect(panelSizeForKey(x, { key: "Home", shiftKey: false }, 300)).toBe(200);
    expect(panelSizeForKey(x, { key: "End", shiftKey: false }, 300)).toBe(520);
    expect(panelSizeForKey(yNear, { key: "Home", shiftKey: false }, 240)).toBe(LOGS_MIN_HEIGHT);
    expect(panelSizeForKey(yNear, { key: "End", shiftKey: false }, 240)).toBe(LOGS_MAX_HEIGHT);
  });
});

// ── Persistence codec ───────────────────────────────────────────────────────

describe("persistence codec", () => {
  it("writes the plain decimal the pre-seam sidebar wrote", () => {
    expect(encodePanelSize(330)).toBe("330");
    expect(decodePanelSize("330")).toBe(330);
  });

  it("reads back exactly what it wrote", () => {
    for (const size of [96, 240, 520]) expect(decodePanelSize(encodePanelSize(size))).toBe(size);
  });

  it("missing and garbage read as null; whitespace and empty keep Number()'s answer", () => {
    // Parity with the pre-seam restore: it ran Number(raw) and only trusted
    // finiteness, so "" was 0 (clamped up to min) and " " likewise.
    expect(decodePanelSize(null)).toBeNull();
    expect(decodePanelSize(undefined)).toBeNull();
    expect(decodePanelSize("wide")).toBeNull();
    expect(decodePanelSize("Infinity")).toBeNull();
    expect(decodePanelSize("")).toBe(0);
    expect(decodePanelSize(" 240 ")).toBe(240);
  });

  it("collapsed rides 1/0 and garbage means expanded", () => {
    expect(encodeCollapsed(true)).toBe("1");
    expect(encodeCollapsed(false)).toBe("0");
    expect(decodeCollapsed("1")).toBe(true);
    for (const raw of ["0", "", "yes", null, undefined]) expect(decodeCollapsed(raw)).toBe(false);
  });
});

// ── Drag lifecycle ──────────────────────────────────────────────────────────

describe("drag lifecycle", () => {
  it("start captures the pointer, holds the body class, and persists nothing", () => {
    const h = harness();
    h.panel.onPointerDown(pointer({ pointerId: 7, clientX: 300, currentTarget: h.handle }));
    expect(h.handle.focuses).toBe(1);
    expect(h.handle.captures).toEqual([7]);
    expect(h.body.classes.has("resizing")).toBe(true);
    expect(h.painted).toEqual([]);
    expect(h.storage.map.size).toBe(0);
  });

  it("move paints live (handle aria included), release persists once", () => {
    const h = harness();
    h.panel.onPointerDown(pointer({ pointerId: 7, clientX: 300, currentTarget: h.handle }));
    h.panel.onPointerMove(pointer({ pointerId: 7, clientX: 330, currentTarget: h.handle }));
    expect(h.painted).toEqual(["330@el"]);
    expect(h.handle.attrs.get("aria-valuenow")).toBe("330");
    expect(h.panel.size()).toBe(330);
    expect(h.storage.map.size).toBe(0); // nothing written mid-drag
    h.panel.onPointerUp(pointer({ pointerId: 7, clientX: 330, currentTarget: h.handle }));
    expect(h.body.classes.has("resizing")).toBe(false);
    // The exact bytes the pre-seam code stored.
    expect(h.storage.map.get("hotdog.sidebarWidth")).toBe("330");
  });

  it("moves and ends from a foreign pointer are noise", () => {
    const h = harness();
    h.panel.onPointerDown(pointer({ pointerId: 7, clientX: 300, currentTarget: h.handle }));
    h.panel.onPointerMove(pointer({ pointerId: 99, clientX: 500, currentTarget: h.handle }));
    h.panel.onPointerUp(pointer({ pointerId: 99, clientX: 500, currentTarget: h.handle }));
    expect(h.painted).toEqual([]);
    expect(h.storage.map.size).toBe(0);
    // The real drag survives and still lands.
    h.panel.onPointerMove(pointer({ pointerId: 7, clientX: 320, currentTarget: h.handle }));
    expect(h.panel.size()).toBe(320);
  });

  it("clamps mid-drag without a clamp-shaped stutter at the limit", () => {
    const h = harness();
    h.panel.onPointerDown(pointer({ pointerId: 1, clientX: 300, currentTarget: h.handle }));
    for (const x of [700, 900, 1100]) {
      h.panel.onPointerMove(pointer({ pointerId: 1, clientX: x, currentTarget: h.handle }));
    }
    expect(h.panel.size()).toBe(520); // viewport ceiling here is 600, static 520 wins
    expect(h.painted).toEqual(["520@el", "520@el", "520@el"]);
    h.panel.onPointerUp(pointer({ pointerId: 1, clientX: 1100, currentTarget: h.handle }));
    expect(h.storage.map.get("hotdog.sidebarWidth")).toBe("520");
  });

  it("a CSS-hidden handle is inert (mobile drawer)", () => {
    const h = harness();
    h.handle.offsetParent = null;
    h.panel.onPointerDown(pointer({ pointerId: 3, clientX: 300, currentTarget: h.handle }));
    expect(h.handle.focuses).toBe(0);
    expect(h.handle.captures).toEqual([]);
    expect(h.body.classes.has("resizing")).toBe(false);
    // ...and no stray drag was armed for a later move to use.
    h.panel.onPointerMove(pointer({ pointerId: 3, clientX: 480, currentTarget: h.handle }));
    expect(h.panel.size()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("a missing currentTarget is dropped, not thrown on", () => {
    const h = harness();
    h.panel.onPointerDown(pointer({ pointerId: 3, clientX: 300, currentTarget: null }));
    expect(h.body.classes.has("resizing")).toBe(false);
  });

  it("blocked storage costs the reload, not the interaction", () => {
    const h = harness({}, new ThrowingStorage());
    h.panel.onPointerDown(pointer({ pointerId: 1, clientX: 300, currentTarget: h.handle }));
    h.panel.onPointerMove(pointer({ pointerId: 1, clientX: 355, currentTarget: h.handle }));
    h.panel.onPointerUp(pointer({ pointerId: 1, clientX: 355, currentTarget: h.handle }));
    expect(h.panel.size()).toBe(355);
    expect(h.body.classes.has("resizing")).toBe(false);
    expect(() => h.panel.restore()).not.toThrow();
  });
});

// ── Restore, keyboard persist, reset ────────────────────────────────────────

describe("restore / keyboard / reset", () => {
  it("restore applies the stored size clamped to the CURRENT viewport", () => {
    const store = new FakeStorage();
    store.map.set("hotdog.sidebarWidth", "900");
    const h = harness({}, store);
    h.panel.restore();
    expect(h.panel.size()).toBe(520);
    expect(h.painted).toEqual(["520"]); // el null: no aria write off-gesture
    expect(h.handle.attrs.size).toBe(0);
  });

  it("restore leaves the default on missing, garbage, or unreadable storage", () => {
    expect(harness().panel.size()).toBe(SIDEBAR_DEFAULT_WIDTH);
    const garbage = new FakeStorage();
    garbage.map.set("hotdog.sidebarWidth", "wide");
    expect(harness({}, garbage).panel.size()).toBe(SIDEBAR_DEFAULT_WIDTH);
    const blocked = harness({}, new ThrowingStorage());
    blocked.panel.restore();
    expect(blocked.panel.size()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("keyboard steps paint and persist, and Home keeps the static min", () => {
    // Pre-seam parity: Home names 200 even when the viewport ceiling is lower.
    const h = harness({ viewportMax: () => 350 });
    const k1 = keyboard({ key: "ArrowRight", currentTarget: h.handle });
    h.panel.onKeyDown(k1.asArg);
    expect(h.panel.size()).toBe(316);
    expect(h.storage.map.get("hotdog.sidebarWidth")).toBe("316");
    const k2 = keyboard({ key: "Home", currentTarget: h.handle });
    h.panel.onKeyDown(k2.asArg);
    expect(h.panel.size()).toBe(200);
    expect(h.storage.map.get("hotdog.sidebarWidth")).toBe("200");
  });

  it("an unclaimed key is neither prevented nor written", () => {
    const h = harness();
    const k = keyboard({ key: "Tab", currentTarget: h.handle });
    h.panel.onKeyDown(k.asArg);
    expect(k.event.prevented).toBe(false);
    expect(h.storage.map.size).toBe(0);
  });

  it("double-click resets to the default and forgets the preference", () => {
    const h = harness();
    h.storage.map.set("hotdog.sidebarWidth", "480");
    h.panel.restore();
    h.panel.onDoubleClick({ currentTarget: h.handle });
    expect(h.panel.size()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(h.storage.map.has("hotdog.sidebarWidth")).toBe(false);
    expect(h.handle.attrs.get("aria-valuenow")).toBe("300");
  });
});

// ── Collapse ────────────────────────────────────────────────────────────────

describe("collapse", () => {
  const logs = (over: Partial<PanelResizeOptions> = {}, storage?: FakeStorage): Harness =>
    harness(
      {
        axis: "y",
        sizeKey: "hotdog.logsHeight",
        collapsedKey: "hotdog.logsCollapsed",
        defaultSize: LOGS_DEFAULT_HEIGHT,
        min: LOGS_MIN_HEIGHT,
        max: LOGS_MAX_HEIGHT,
        viewportMax: () => 900 / 2,
        nearEdge: true,
        bodyClass: "logs-resizing",
        ...over,
      },
      storage,
    );

  it("starts expanded with no stored flag, and a flip persists + notifies", () => {
    const h = logs();
    expect(h.panel.collapsed()).toBe(false);
    expect(h.panel.toggle()).toBe(true);
    expect(h.panel.collapsed()).toBe(true);
    expect(h.storage.map.get("hotdog.logsCollapsed")).toBe("1");
    expect(h.collapsedFlips).toEqual([true]);
    expect(h.panel.toggle()).toBe(false);
    expect(h.storage.map.get("hotdog.logsCollapsed")).toBe("0");
    expect(h.collapsedFlips).toEqual([true, false]);
  });

  it("restore hydrates the flag, and only a real change notifies", () => {
    const store = new FakeStorage();
    store.map.set("hotdog.logsCollapsed", "1");
    store.map.set("hotdog.logsHeight", "300");
    const h = logs({}, store);
    h.panel.restore();
    expect(h.panel.collapsed()).toBe(true);
    expect(h.collapsedFlips).toEqual([true]);
    h.panel.restore(); // same stored value: no second notification
    expect(h.collapsedFlips).toEqual([true]);
  });

  it("a collapsed section that expands keeps the height the user left", () => {
    const h = logs();
    h.panel.onPointerDown(pointer({ pointerId: 1, clientY: 240, currentTarget: h.handle }));
    h.panel.onPointerMove(pointer({ pointerId: 1, clientY: 200, currentTarget: h.handle })); // up = taller
    h.panel.onPointerUp(pointer({ pointerId: 1, clientY: 200, currentTarget: h.handle }));
    expect(h.panel.size()).toBe(280);
    expect(h.storage.map.get("hotdog.logsHeight")).toBe("280");
    h.panel.toggle();
    expect(h.panel.size()).toBe(280); // collapse never touches the height
    expect(h.storage.map.get("hotdog.logsHeight")).toBe("280");
    h.panel.toggle();
    expect(h.panel.size()).toBe(280);
  });

  it("collapsed gates the resize gestures but never the toggle", () => {
    let collapsed = false;
    const h = logs({ enabled: () => !collapsed, onCollapseChange: () => void (collapsed = !collapsed) });
    h.panel.toggle(); // collapse
    h.panel.onPointerDown(pointer({ pointerId: 1, clientY: 240, currentTarget: h.handle }));
    h.panel.onPointerMove(pointer({ pointerId: 1, clientY: 100, currentTarget: h.handle }));
    h.panel.onPointerUp(pointer({ pointerId: 1, clientY: 100, currentTarget: h.handle }));
    const k = keyboard({ key: "ArrowUp", currentTarget: h.handle });
    h.panel.onKeyDown(k.asArg);
    h.panel.onDoubleClick({ currentTarget: h.handle });
    expect(h.panel.size()).toBe(LOGS_DEFAULT_HEIGHT);
    expect(h.body.classes.has("logs-resizing")).toBe(false);
    expect(k.event.prevented).toBe(false);
    expect(h.storage.map.has("hotdog.logsHeight")).toBe(false); // no reset, so no delete either
    expect(h.panel.toggle()).toBe(false); // expanding stays available
  });

  it("a panel without a collapsed key never collapses", () => {
    const h = harness();
    expect(h.panel.toggle()).toBe(false);
    expect(h.collapsedFlips).toEqual([]);
    expect(h.storage.map.size).toBe(0);
  });

  it("collapse survives a throwing store as a session-only flip", () => {
    const h = logs({}, new ThrowingStorage());
    expect(() => h.panel.toggle()).not.toThrow();
    expect(h.panel.collapsed()).toBe(true);
    expect(h.collapsedFlips).toEqual([true]);
  });
});
