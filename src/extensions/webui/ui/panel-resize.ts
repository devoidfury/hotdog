/// <reference lib="dom" />
// One seam for every client-side panel the user drags to a size, collapses,
// and expects to find as they left it: the sidebar's width (x axis) and the
// Recent Logs list height (y axis). Nothing here knows what a sidebar is --
// callers bring the axis, the clamps, the storage keys, the keyboard steps,
// the body class held during a drag, and a paint hook. No dependencies, no
// server coupling, no re-render on pointermove (paint is imperative).
//
// Storage doctrine (draft.ts / thinking-pref.ts): every ambient access is
// swallowed at this boundary. A blocked or throwing localStorage
// (private-mode Safari) costs the reload, never the interaction -- dragging,
// collapsing and the keyboard all keep working for the session.

import type { DraftStorage } from "./draft.ts";

export type PanelAxis = "x" | "y";

// ── Structural DOM surfaces ────────────────────────────────────────────────
// Handlers are typed against the smallest slice of the DOM they touch, so a
// real PointerEvent/KeyboardEvent satisfies them (the fields below are all
// `unknown`-compatible) and a test can hand-build one instead of mocking.

/** The handle element: focus, capture, aria, and the visibility probe. */
export interface PanelHandle {
  /** null means the handle is CSS-hidden (the closed mobile drawer): its size
   *  belongs to CSS, so a drag must not start. */
  readonly offsetParent: unknown;
  focus(): void;
  setPointerCapture(pointerId: number): void;
  setAttribute(name: string, value: string): void;
}

export interface PanelPointerEvent {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: unknown;
}

export interface PanelKeyboardEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly currentTarget: unknown;
  preventDefault(): void;
}

export interface PanelMouseEvent {
  readonly currentTarget: unknown;
}

export interface PanelBody {
  classList: { add(name: string): void; remove(name: string): void };
}

/** Ambient browser bits. Injected so tests drive the whole drag lifecycle with
 *  fakes; the default is the browser, resolved lazily and defensively. */
export interface PanelEnv {
  storage(): DraftStorage | null;
  body(): PanelBody | null;
}

export function browserEnv(): PanelEnv {
  return {
    storage() {
      try {
        return window.localStorage ?? null;
      } catch {
        return null; // accessing localStorage itself can throw
      }
    },
    body() {
      try {
        return document.body ?? null;
      } catch {
        return null;
      }
    },
  };
}

// ── Clamp math ─────────────────────────────────────────────────────────────

/**
 * Ceiling after the viewport shrinks it: min(max, viewportMax), with min
 * winning on degenerate viewports (a sub-400px window still gets min width).
 * An unmeasurable viewportMax (non-finite) means "no shrink" rather than
 * poisoning the panel with NaN.
 */
export function panelMaxSize(min: number, max: number, viewportMax?: () => number): number {
  const view = viewportMax?.() ?? Infinity;
  return Math.max(min, Math.min(max, Number.isFinite(view) ? view : Infinity));
}

/** Both bounds inclusive; min wins when max was clamped below it. */
export function clampPanelSize(size: number, min: number, max: number): number {
  return Math.min(Math.max(size, min), Math.max(min, max));
}

/** The coordinate the pointer travels along: x reads clientX, y clientY. */
export function panelCross(axis: PanelAxis, e: { clientX: number; clientY: number }): number {
  return axis === "x" ? e.clientX : e.clientY;
}

/**
 * The sign a drag moves the size by. A FAR-edge handle (the sidebar's right
 * border) rides away from its region, so the pointer and the size move the
 * same way: drag right, the sidebar widens. A NEAR-edge handle (the Recent
 * Logs titlebar, which sits above the list it sizes) rides INTO it, so the
 * pointer and the size move opposite ways: drag the titlebar up, the list
 * grows.
 */
export function panelDragSign(nearEdge?: boolean): 1 | -1 {
  return nearEdge ? -1 : 1;
}

/** Size after a drag: the cross-axis offset, signed by the handle's edge. */
export function panelDragSize(
  axis: PanelAxis,
  e: { clientX: number; clientY: number },
  startCross: number,
  startSize: number,
  nearEdge?: boolean,
): number {
  return startSize + panelDragSign(nearEdge) * (panelCross(axis, e) - startCross);
}

export interface PanelSteps {
  axis: PanelAxis;
  min: number;
  max: number;
  /** Arrow step, and the Shift step. */
  step: number;
  coarseStep: number;
  /** Must match the drag config: a near-edge handle grows on the other arrow. */
  nearEdge?: boolean;
}

/**
 * Arrow/Home/End on the handle -> the next size (raw, before the viewport
 * clamp; Home/End name the static limits, the standard slider semantics).
 * Home/End are absolute limits so they do not flip with the handle's edge --
 * only the arrows do. null means the key belongs to somebody else, so the
 * caller must not preventDefault it.
 */
export function panelSizeForKey(
  o: PanelSteps,
  e: { key: string; shiftKey: boolean },
  size: number,
): number | null {
  const delta = e.shiftKey ? o.coarseStep : o.step;
  // Growing is "right/down" for a far-edge handle and "left/up" for a
  // near-edge one, so the arrow keeps matching what the drag does.
  const growKey = o.axis === "x" ? (o.nearEdge ? "ArrowLeft" : "ArrowRight") : o.nearEdge ? "ArrowUp" : "ArrowDown";
  const shrinkKey = o.axis === "x" ? (o.nearEdge ? "ArrowRight" : "ArrowLeft") : o.nearEdge ? "ArrowDown" : "ArrowUp";
  if (e.key === growKey) return size + delta;
  if (e.key === shrinkKey) return size - delta;
  if (e.key === "Home") return o.min;
  if (e.key === "End") return o.max;
  return null;
}

// ── Persistence codec ──────────────────────────────────────────────────────

/** A size is stored as the plain decimal the pre-seam sidebar wrote. */
export function encodePanelSize(size: number): string {
  return String(size);
}

/** Missing or garbage -> null (keep the default). */
export function decodePanelSize(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const size = Number(raw);
  return Number.isFinite(size) ? size : null;
}

/** Collapsed rides "1"/"0"; anything else (missing, garbage) is expanded. */
export function encodeCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

export function decodeCollapsed(raw: string | null | undefined): boolean {
  return raw === "1";
}

// ── The panel ──────────────────────────────────────────────────────────────

export interface PanelResizeOptions {
  /** x drags a width, y drags a height. */
  axis: PanelAxis;
  /** localStorage key for the size. */
  sizeKey: string;
  /** localStorage key for the collapsed flag. Omit it for a panel the seam
   *  never collapses (the sidebar -- its chat-header disclosure is a plain
   *  view setting, see app.tsx sidebarCollapsedAtom): then collapsed() is
   *  always false and toggle() is a no-op. */
  collapsedKey?: string;
  /** What a reset (double-click) restores, and what a fresh visitor gets. */
  defaultSize: number;
  min: number;
  max: number;
  /** Viewport shrink of the ceiling, e.g. () => window.innerWidth / 2. */
  viewportMax?: () => number;
  step: number;
  coarseStep: number;
  /** The handle rides the region's near edge (a titlebar above the list it
   *  sizes), so dragging it up/left GROWS the region and the arrows follow.
   *  Default false: the sidebar's right-border handle grows with the pointer. */
  nearEdge?: boolean;
  /** Body class added for the duration of a drag (cursor + selection kill). */
  bodyClass: string;
  /** Render the clamped size -- CSS var plus the handle's aria-valuenow. el is
   *  the handle, or null when the change came from off-gesture (restore). */
  paint: (size: number, el: PanelHandle | null) => void;
  /** Gate the resize gestures: a collapsed region has no size to drag. */
  enabled?: () => boolean;
  /** Fires after a collapse flip so the caller can re-render. */
  onCollapseChange?: (collapsed: boolean) => void;
}

export interface PanelResize {
  /** Last clamped size -- the number aria-valuenow carries. */
  size(): number;
  /** Ceiling after the viewport shrink (for aria-valuemax). */
  maxSize(): number;
  collapsed(): boolean;
  /** Hydrate the stored size and collapsed flag. Missing, garbage or
   *  unreadable storage leaves the defaults untouched. The size is clamped
   *  against the CURRENT viewport, not the one it was saved on. */
  restore(): void;
  /** Flip and persist the collapsed flag; returns the new state. */
  toggle(): boolean;
  // Bind these straight onto the handle: pointerdown / pointermove /
  // pointerup + pointercancel / keydown / dblclick.
  onPointerDown(e: PanelPointerEvent): void;
  onPointerMove(e: PanelPointerEvent): void;
  onPointerUp(e: PanelPointerEvent): void;
  onKeyDown(e: PanelKeyboardEvent): void;
  onDoubleClick(e: PanelMouseEvent): void;
}

export function createPanelResize(o: PanelResizeOptions, env: PanelEnv = browserEnv()): PanelResize {
  let current = o.defaultSize;
  let collapsedFlag = false;
  let drag: { pointerId: number; startCross: number; startSize: number } | null = null;

  const maxSize = (): number => panelMaxSize(o.min, o.max, o.viewportMax);

  function apply(size: number, el: PanelHandle | null): void {
    current = clampPanelSize(size, o.min, maxSize());
    o.paint(current, el);
  }

  const resizable = (): boolean => o.enabled?.() ?? true;

  /** Best-effort write: blocked storage or a quota hit costs the reload only. */
  function write(key: string, value: string): void {
    try {
      env.storage()?.setItem(key, value);
    } catch {
      // ignore
    }
  }

  function forget(key: string): void {
    try {
      env.storage()?.removeItem(key);
    } catch {
      // ignore
    }
  }

  /** A throwing read reads as absent: either way there is nothing to apply. */
  function read(key: string): string | null {
    try {
      return env.storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  return {
    size: () => current,
    maxSize,
    collapsed: () => collapsedFlag,

    restore() {
      if (o.collapsedKey) {
        const stored = decodeCollapsed(read(o.collapsedKey));
        if (stored !== collapsedFlag) {
          collapsedFlag = stored;
          o.onCollapseChange?.(stored);
        }
      }
      const saved = decodePanelSize(read(o.sizeKey));
      if (saved === null) return;
      apply(saved, null);
    },

    toggle() {
      if (!o.collapsedKey) return collapsedFlag;
      collapsedFlag = !collapsedFlag;
      write(o.collapsedKey, encodeCollapsed(collapsedFlag));
      o.onCollapseChange?.(collapsedFlag);
      return collapsedFlag;
    },

    onPointerDown(e) {
      if (!resizable()) return;
      const el = e.currentTarget as PanelHandle | null;
      if (!el || el.offsetParent === null) return; // CSS-hidden: width/height is CSS-only
      el.focus();
      drag = { pointerId: e.pointerId, startCross: panelCross(o.axis, e), startSize: current };
      el.setPointerCapture(e.pointerId);
      env.body()?.classList.add(o.bodyClass);
    },

    onPointerMove(e) {
      // A drag belongs to the pointer that started it; any other id is noise.
      if (!drag || e.pointerId !== drag.pointerId) return;
      apply(panelDragSize(o.axis, e, drag.startCross, drag.startSize, o.nearEdge), e.currentTarget as PanelHandle | null);
    },

    onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag = null;
      env.body()?.classList.remove(o.bodyClass);
      // Persist on release only: a drag writes once, not per move.
      write(o.sizeKey, encodePanelSize(current));
    },

    onKeyDown(e) {
      if (!resizable()) return;
      const next = panelSizeForKey(o, e, current);
      if (next === null) return;
      e.preventDefault();
      apply(next, e.currentTarget as PanelHandle | null);
      write(o.sizeKey, encodePanelSize(current));
    },

    onDoubleClick(e) {
      if (!resizable()) return;
      // Double-click: back to the default and forget the stored preference.
      apply(o.defaultSize, e.currentTarget as PanelHandle | null);
      forget(o.sizeKey);
    },
  };
}
