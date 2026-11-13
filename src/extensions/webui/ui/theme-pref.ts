/// <reference lib="dom" />
// Color-theme preference: a per-BROWSER view setting. localStorage so it
// survives a reload; the CLI/server has no idea which palette this tab
// renders. Every storage access is swallowed at this boundary, so a blocked
// or throwing localStorage (private-mode Safari) can never break boot -- the
// default palette is all that is lost.
//
// The registry below is the single list the switcher cycles and the CSS
// mirrors: adding a theme is EXACTLY one :root[data-theme="<id>"] block in
// styles.css (recipe documented there) + one entry here. A stored id with no
// registry entry is garbage and falls back to the default, so a theme
// removed from the registry degrades instead of stranding the tab.

import type { DraftStorage } from "./draft.ts";

export interface WebUITheme {
  /** data-theme value on <html>; "" never occurs -- the DEFAULT palette
   *  renders from the bare :root (no attribute), so an unset attribute and
   *  the default id mean the same look. */
  id: string;
  /** Human name shown in the switcher's title/aria-label. */
  label: string;
}

/** Palette list. The FIRST entry is the default (the bare-:root look); the
 *  switcher cycles in this order. */
export const THEME_REGISTRY: WebUITheme[] = [
  { id: "hotdog", label: "Hotdog" },
  { id: "purple", label: "Purple" },
];

export const DEFAULT_THEME_ID = THEME_REGISTRY[0]!.id;

/** The stored value is the theme id ("hotdog", "purple"); garbage, unknown
 *  ids and missing keys all decode to the default. */
const THEME_STORAGE_KEY = "hotdog-webui-theme";
export { THEME_STORAGE_KEY };

function resolveStorage(storage?: DraftStorage): DraftStorage | null {
  if (storage) return storage;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

/** Read the preference; unreadable storage, no key, or an id no theme ships
 *  means the default palette. */
export function loadThemeId(storage?: DraftStorage): string {
  const s = resolveStorage(storage);
  if (!s) return DEFAULT_THEME_ID;
  try {
    const raw = s.getItem(THEME_STORAGE_KEY);
    return THEME_REGISTRY.some((t) => t.id === raw) ? (raw as string) : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Best-effort persist: a blocked or quota-full store only costs the reload. */
export function saveThemeId(id: string, storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // blocked storage / quota exceeded: the palette flips for this page
  }
}

/** Registry order is the cycle order; an id outside the registry (should not
 *  happen through loadThemeId) resumes at the default. */
export function nextThemeId(current: string): string {
  const i = THEME_REGISTRY.findIndex((t) => t.id === current);
  return THEME_REGISTRY[(i + 1) % THEME_REGISTRY.length]!.id;
}

/** Display name for a stored/atom id (the switcher's title). An id the
 *  registry no longer ships displays the default's name, matching what
 *  actually renders. */
export function labelForTheme(id: string): string {
  return (THEME_REGISTRY.find((t) => t.id === id) ?? THEME_REGISTRY[0]!).label;
}

/** The documentElement surface applyThemeId needs (structurally satisfiable
 *  by the dom-helper stub in tests). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Put a theme on the page. The default renders from the bare :root (which
 *  carries the hotdog palette), so it REMOVES the attribute; every other id
 *  sets data-theme to its registry id, matching its CSS block. */
export function applyThemeId(id: string, root: ThemeRoot = document.documentElement): void {
  if (id === DEFAULT_THEME_ID) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
}

/** The boot line: load the stored preference and put it on documentElement.
 *  index.html carries a tiny inline mirror of this in <head> so the FIRST
 *  paint already shows the stored palette (no hotdog-then-purple flash);
 *  this call is the same value re-applied once the module is up, so the two
 *  never disagree. Returns the applied id for the app's atom. */
export function applyStoredTheme(storage?: DraftStorage, root?: ThemeRoot): string {
  const id = loadThemeId(storage);
  applyThemeId(id, root ?? document.documentElement);
  return id;
}
