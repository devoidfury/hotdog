/// <reference lib="dom" />
// Searchable combobox for the composer's profile/model pills: a borderless
// trigger chip (the pill's inner control stays borderless -- same idiom the
// native selects wore) opens a POPUP that rides the session context menu's
// overlay stack: position:fixed, z-index 9999, clampMenuAnchor correction,
// outside-mousedown dismissal, focus return to the trigger. The popup holds a
// text filter plus a live-filtered role=listbox; only plain case-insensitive
// substring matching, no fuzzy, no virtualization.
//
// One combobox is open at a time app-wide (the context menu's own doctrine).
// Open state (id, placement, query, highlight) lives in comboboxAtom; the
// control and the root-mounted popup are separate renders, joined through the
// module registry below: each mounted Combobox refreshes its options / current
// value / onSelect in the registry, so the popup always paints the CURRENT
// list (a profiles payload landing mid-open repaints it) without the trigger's
// props being duplicated anywhere.

import { reactiveState } from "./utils.ts";
import { clampMenuAnchor } from "./sessions.tsx";
import type { DomElement, JsxChild, Ref } from "@utils/jsx";

export interface ComboboxProps {
  /** Stable control id, kept on the trigger button (#profile-select,
   *  #model-select): CSS and tests address the control through it. */
  id: string;
  /** Accessible name of the control ("Profile"/"Model"); the filter input
   *  borrows it ("<label> filter"). */
  label: string;
  /** Current value: the trigger's display text and the same-value no-op
   *  reference. A value the options list does not carry displays blank, the
   *  way a native <select> displayed an unmatched forced value. */
  value: string;
  /** Option labels (value === label here: profiles and model ids are both
   *  their own display text). */
  options: string[];
  /** Locked posture (the selects-locked subagent view): refuses open and
   *  selection; closes an open popup when it lands. */
  disabled?: boolean;
  /** Fires ONLY on a real change -- picking the already-current value is a
   *  no-op, exactly like the native select's change event. */
  onSelect: (value: string) => void;
}

export type ComboboxOpen = {
  id: string;
  /** Placement in viewport coords (the popup is fixed-positioned and its
   *  style re-applies from this state on every render -- ContextMenu
   *  doctrine: the durable correction is the ATOM write). */
  x: number;
  y: number;
  /** The trigger's top captured at open; the post-render measurement flips
   *  the popup above it when the box would overflow the bottom. */
  anchorTop: number;
  query: string;
  /** Highlighted index into the FILTERED list. */
  highlight: number;
};

type ComboboxEntry = {
  trigger: HTMLElement | null;
  label: string;
  value: string;
  options: string[];
  disabled: boolean;
  onSelect: (value: string) => void;
};

// Exported for the app's render subscription: every open/close/keystroke
// repaint rides the existing coalesced render().
export const comboboxAtom = reactiveState<ComboboxOpen | null>(null);
const registry = new Map<string, ComboboxEntry>();

// The popup mounts once at a time, so one pair of module refs suffices; the
// identities are stable (an inline closure would churn the nodes every patch).
let popupEl: HTMLDivElement | null = null;
let filterInputEl: HTMLInputElement | null = null;
const popupRef = (el: DomElement | null): void => {
  popupEl = el as unknown as HTMLDivElement | null;
};
const filterRef = (el: DomElement | null): void => {
  filterInputEl = el as unknown as HTMLInputElement | null;
};

const triggerRefs = new Map<string, Ref>();
function triggerRefFor(id: string): Ref {
  let cb = triggerRefs.get(id);
  if (!cb) {
    cb = (el: DomElement | null) => {
      const entry = registry.get(id);
      if (entry) entry.trigger = el as unknown as HTMLElement | null;
      // Unmount (logout, pane swap) while open: the overlay leaves with the
      // control -- a still-armed open state must not re-pop the popup on the
      // next composer render.
      if (!el && comboboxAtom()?.id === id) comboboxAtom(null);
    };
    triggerRefs.set(id, cb);
  }
  return cb;
}

/** Plain case-insensitive substring filter on the label. Deliberately the
 *  whole matching story: no fuzzy scoring, no normalization beyond lowercase. */
function filterOptions(options: string[], query: string): string[] {
  const q = query.toLowerCase();
  return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
}

function openCombobox(id: string): void {
  const entry = registry.get(id);
  if (!entry || entry.disabled) return;
  const r = entry.trigger?.getBoundingClientRect?.();
  const x = r ? r.left : 0;
  const top = r ? r.top : 0;
  const bottom = r ? r.bottom : 0;
  comboboxAtom({
    id,
    x,
    y: bottom + 2,
    anchorTop: top,
    query: "",
    // The current value enters highlighted, so a bare Enter re-picks it (and
    // the same-value pick is the no-op) exactly like opening a native select.
    highlight: Math.max(0, entry.options.indexOf(entry.value)),
  });
  // The atom's coalesced render microtask was queued by the setter before
  // this one (armContextMenu's ordering), so the popup node exists here and
  // has real geometry: flip above when it cannot fit below (the composer sits
  // at the viewport bottom), clamp, then hand the caret to the filter. The
  // style write covers the first frame; the atom write is what survives every
  // later keystroke repaint. Zero rects (no layout, e.g. tests) fall through
  // to the clamp's documented pad placement, exactly like rowMenuPoint's.
  queueMicrotask(() => {
    const st = comboboxAtom();
    if (!st || st.id !== id || !popupEl) return;
    const pr = popupEl.getBoundingClientRect();
    let y = st.y;
    if (pr.height > 0 && pr.bottom > window.innerHeight - 8) {
      y = Math.max(8, st.anchorTop - pr.height - 2);
    }
    const c = clampMenuAnchor(st.x, y, pr.width, pr.height, window.innerWidth, window.innerHeight);
    if (c.left !== st.x || c.top !== st.y) {
      popupEl.style.left = `${c.left}px`;
      popupEl.style.top = `${c.top}px`;
      comboboxAtom({ ...st, x: c.left, y: c.top });
    }
    filterInputEl?.focus();
  });
}

/**
 * Close the open popup WITHOUT touching the value (Escape, outside mousedown,
 * Tab, the trigger toggle, and the pre-pick step of a selection all share it).
 * Focus returns to the trigger only while it is still ours (dismissContextMenu
 * doctrine: a mousedown-outside onto a focusable control keeps the browser's
 * own focus handling).
 */
function closeCombobox(): void {
  const st = comboboxAtom();
  if (!st) return;
  const trigger = registry.get(st.id)?.trigger ?? null;
  const popup = popupEl;
  comboboxAtom(null);
  if (
    trigger &&
    trigger.parentNode &&
    popup &&
    popup.contains(document.activeElement as unknown as Node)
  ) {
    trigger.focus();
  }
}

/** Land a pick: close first (the overlay's exit is the guaranteed response),
 *  then dispatch the control's handler ONLY on a real change. */
function pickCombobox(value: string): void {
  const st = comboboxAtom();
  if (!st) return;
  const entry = registry.get(st.id);
  closeCombobox();
  if (entry && value !== entry.value) entry.onSelect(value);
}

function onFilterInput(e: Event): void {
  const st = comboboxAtom();
  if (!st) return;
  comboboxAtom({ ...st, query: (e.currentTarget as HTMLInputElement).value, highlight: 0 });
}

function scrollActiveOptionIntoView(): void {
  // Same microtask ordering as openCombobox's: runs after the patch the atom
  // write just queued, so the .active class has landed.
  queueMicrotask(() => {
    const active = popupEl?.querySelector<HTMLElement>(".combobox-option.active");
    active?.scrollIntoView({ block: "nearest" });
  });
}

function onPopupKeydown(e: KeyboardEvent): void {
  const st = comboboxAtom();
  if (!st) return;
  const entry = registry.get(st.id);
  if (!entry) return;
  const filtered = filterOptions(entry.options, st.query);
  const n = filtered.length;
  const hi = n ? Math.min(st.highlight, n - 1) : -1;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    // Wrap, the completion menu's arrow grammar.
    const next = e.key === "ArrowDown" ? (hi + 1) % n : (hi - 1 + n) % n;
    comboboxAtom({ ...st, highlight: next });
    scrollActiveOptionIntoView();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (hi >= 0) pickCombobox(filtered[hi]!);
    return;
  }
  if (e.key === "Escape") {
    // Close WITHOUT changing the value: the filter text dies with the popup,
    // the control keeps showing what it showed before the popup ever opened.
    e.preventDefault();
    closeCombobox();
    return;
  }
  if (e.key === "Tab") {
    // The context menu's rule: dismiss and move on. Deliberately NOT
    // prevented -- traversal continues from wherever focus lands.
    closeCombobox();
  }
}

// Close on any mousedown outside the open popup, the context menu's sibling
// listener. The open control's TRIGGER is excluded: the mousedown that opens
// lands before the atom is set, and a mousedown while open belongs to the
// trigger's own toggle click.
document.addEventListener("mousedown", (e: MouseEvent) => {
  const st = comboboxAtom();
  if (!st) return;
  if (popupEl && popupEl.contains(e.target as unknown as Node)) return;
  const trigger = registry.get(st.id)?.trigger;
  if (trigger && trigger.contains(e.target as unknown as Node)) return;
  closeCombobox();
});

export function Combobox(props: ComboboxProps): JsxChild {
  const disabled = props.disabled ?? false;
  registry.set(props.id, {
    trigger: registry.get(props.id)?.trigger ?? null,
    label: props.label,
    value: props.value,
    options: props.options,
    disabled,
    onSelect: props.onSelect,
  });
  // A lock landing while this popup is open closes it here: the popup paints
  // from the same atom, and clearing it also keeps the trigger's
  // aria-expanded from lying about a mounted popup.
  const openState = comboboxAtom();
  if (disabled && openState && openState.id === props.id) comboboxAtom(null);
  const open = !disabled && comboboxAtom()?.id === props.id;
  return (
    <button
      type="button"
      id={props.id}
      className="combobox-trigger"
      aria-label={props.label}
      aria-haspopup="listbox"
      aria-expanded={open ? "true" : "false"}
      aria-controls={open ? `${props.id}-list` : undefined}
      disabled={disabled}
      ref={triggerRefFor(props.id)}
      onClick={() => {
        if (disabled) return;
        const cur = comboboxAtom();
        if (cur && cur.id === props.id) closeCombobox();
        else openCombobox(props.id);
      }}
      onKeydown={(e: KeyboardEvent) => {
        // Enter/Space open through the button's native activation (they fire
        // click, and the handler above opens); ArrowDown carries no native
        // binding, so it opens directly.
        if (disabled || e.key !== "ArrowDown") return;
        e.preventDefault();
        openCombobox(props.id);
      }}
    >
      <span className="combobox-value">
        {props.options.includes(props.value) ? props.value : ""}
      </span>
    </button>
  );
}

/**
 * The one popup, mounted ONCE by the app next to the context menu (the
 * overlay's root-mount sibling -- never inside the pill, so no ancestor's
 * box can clip or restack it). Renders nothing unless a combobox is open.
 */
export function ComboboxPopup(): JsxChild {
  const st = comboboxAtom();
  if (!st) return null;
  const entry = registry.get(st.id);
  // No live control (unmounted) or a lock landed since the atom was set: no
  // popup. The trigger re-reads the same atom for aria-expanded, so the two
  // views can never disagree.
  if (!entry || !entry.trigger || entry.disabled) return null;
  const filtered = filterOptions(entry.options, st.query);
  const hi = filtered.length ? Math.min(st.highlight, filtered.length - 1) : -1;
  return (
    <div
      className="combobox-popup"
      ref={popupRef}
      style={{ left: `${st.x}px`, top: `${st.y}px` }}
      onKeydown={onPopupKeydown}
    >
      <input
        type="text"
        className="combobox-filter"
        ref={filterRef}
        placeholder="Type to filter"
        aria-label={`${entry.label} filter`}
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={`${st.id}-list`}
        aria-activedescendant={hi >= 0 ? `${st.id}-opt-${hi}` : undefined}
        onInput={onFilterInput}
      />
      <div className="combobox-list" role="listbox" id={`${st.id}-list`}>
        {filtered.map((o, i) => (
          <div
            key={o}
            id={`${st.id}-opt-${i}`}
            role="option"
            aria-selected={o === entry.value ? "true" : "false"}
            className={`combobox-option${i === hi ? " active" : ""}`}
            // mousedown + preventDefault, the completion-menu idiom: pick
            // lands before the filter input could blur out from under the
            // press (a click-only handler would fight the browser's focus
            // step, and the options carry NO click listener to double-fire).
            onMousedown={(e: MouseEvent) => {
              e.preventDefault();
              pickCombobox(o);
            }}
          >
            {o}
          </div>
        ))}
        {filtered.length === 0 ? <div className="combobox-empty">No matches</div> : null}
      </div>
    </div>
  );
}
