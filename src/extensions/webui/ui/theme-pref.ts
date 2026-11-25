/// <reference lib="dom" />
// Color-theme preference + custom themes: a per-BROWSER view setting.
// localStorage so it survives a reload; the CLI/server has no idea which
// palette this tab renders. Every storage access is swallowed at this
// boundary, so a blocked or throwing localStorage (private-mode Safari) can
// never break boot -- custom themes are all that is lost.
//
// Two kinds of palette:
//  - BUILT-IN (THEME_REGISTRY): each is EXACTLY one :root[data-theme="<id>"]
//    block in styles.css (recipe documented there) plus one entry here whose
//    `colors` mirror feeds the editor's swatch previews; a sync test pins
//    the mirror against the CSS bytes.
//  - CUSTOM (THEME_CUSTOM_STORAGE_KEY): user-saved {id, label, colors} in
//    localStorage. Applying one = the data-theme tag PLUS the palette
//    written as inline custom properties on <html> (inline always beats the
//    stylesheet, so a custom look overrides without fighting the CSS).
//    The index.html pre-paint script mirrors this so the FIRST paint already
//    shows a stored custom palette.
//
// A stored id nothing resolves to is garbage and falls back to the default,
// so a deleted custom theme degrades instead of stranding the tab.

import type { DraftStorage } from "./draft.ts";

/** One of the per-theme color slots the editor exposes. `name` is the CSS
 *  custom property; a custom theme is a complete map over these (the four
 *  accent derivatives below are COMPUTED on apply, never stored). */
export interface ThemeTokenDef {
  name: string;
  label: string;
  group: string;
}

export const EDITABLE_TOKENS: readonly ThemeTokenDef[] = [
  { name: "--bg-base", label: "Base", group: "Backgrounds" },
  { name: "--bg-primary", label: "Panel", group: "Backgrounds" },
  { name: "--bg-secondary", label: "Dialog", group: "Backgrounds" },
  { name: "--bg-tertiary", label: "Raised", group: "Backgrounds" },
  { name: "--bg-elevated", label: "Elevated", group: "Backgrounds" },
  { name: "--bg-hover", label: "Hover fill", group: "Backgrounds" },
  { name: "--bg-active", label: "Active fill", group: "Backgrounds" },
  { name: "--text-primary", label: "Text", group: "Text" },
  { name: "--text-secondary", label: "Secondary text", group: "Text" },
  { name: "--text-muted", label: "Muted text", group: "Text" },
  { name: "--text-inverse", label: "Ink on accent", group: "Text" },
  { name: "--accent", label: "Accent", group: "Accent & borders" },
  { name: "--border", label: "Border", group: "Accent & borders" },
  { name: "--border-light", label: "Strong border", group: "Accent & borders" },
];

/** The accent slots every palette carries besides --accent itself: hover/
 *  active scale the base toward black (~0.86 / ~0.72, the CSS recipe's
 *  numbers), soft/glow are the fixed 0.12 / 0.25 alpha washes. Computed
 *  from --accent whenever a palette is written inline; the built-in CSS
 *  blocks spell the same numbers out as literals. */
const ACCENT_DERIVED: readonly string[] = ["--accent-hover", "--accent-active", "--accent-soft", "--accent-glow"];

/** Every custom property inline theme application touches (clear + write). */
export const THEME_VARS: readonly string[] = [...EDITABLE_TOKENS.map((t) => t.name), ...ACCENT_DERIVED];

export type ThemeColors = Record<string, string>;

export interface WebUITheme {
  /** data-theme value on <html>; "" never occurs -- the DEFAULT palette
   *  renders from the bare :root (no attribute), so an unset attribute and
   *  the default id mean the same look. */
  id: string;
  /** Human name shown in the editor's swatches and the switcher title. */
  label: string;
  /** The complete editable-token palette (the swatch source for built-ins;
   *  the applied map for customs). */
  colors: ThemeColors;
  /** Built-in palettes ship in styles.css; customs live in localStorage. */
  builtIn: boolean;
}

/** Built-in palettes. The FIRST entry is the default (the bare-:root look).
 *  `colors` mirrors the CSS blocks verbatim (pinned by the sync test) --
 *  rendering still rides the CSS; the mirror only feeds previews/seeds. */
export const THEME_REGISTRY: WebUITheme[] = [
  {
    id: "hotdog",
    label: "Hotdog",
    builtIn: true,
    colors: {
      "--bg-base": "#0f0e0d",
      "--bg-primary": "#161412",
      "--bg-secondary": "#1e1b18",
      "--bg-tertiary": "#26221e",
      "--bg-elevated": "#302b26",
      "--bg-hover": "#362f2a",
      "--bg-active": "#3f3832",
      "--text-primary": "#edeae8",
      "--text-secondary": "#d4cec9",
      "--text-muted": "#a9a9a9",
      "--text-inverse": "#161312",
      "--accent": "#e0a32e",
      "--border": "#38302a",
      "--border-light": "#4a3f36",
    },
  },
  {
    id: "purple",
    label: "Purple",
    builtIn: true,
    colors: {
      "--bg-base": "#0d0d0f",
      "--bg-primary": "#121216",
      "--bg-secondary": "#18181e",
      "--bg-tertiary": "#1e1e26",
      "--bg-elevated": "#262630",
      "--bg-hover": "#2a2a36",
      "--bg-active": "#32323f",
      "--text-primary": "#e8e8ed",
      "--text-secondary": "#9a9ab0",
      "--text-muted": "#a9a9a9",
      "--text-inverse": "#ffffff",
      "--accent": "#7c5cff",
      "--border": "#2a2a38",
      "--border-light": "#36364a",
    },
  },
];

export const DEFAULT_THEME_ID = THEME_REGISTRY[0]!.id;

/** The stored value is the theme id ("hotdog", "purple", a custom id);
 *  garbage, unknown ids and missing keys all decode to the default. */
const THEME_STORAGE_KEY = "hotdog-webui-theme";
export { THEME_STORAGE_KEY };

/** JSON array of custom {id, label, colors} entries, validated on read. */
const THEME_CUSTOM_STORAGE_KEY = "hotdog-webui-themes";
export { THEME_CUSTOM_STORAGE_KEY };

/** Custom ids ride a data-theme attribute and a localStorage id, so:
 *  lowercase slug, cannot collide with a built-in id (checked on save/read). */
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** Filled-accent ink choices: dark ink on a bright accent, white on a dark
 *  one (the CSS recipe's rule, decided by relative luminance). */
const DARK_INK = "#161312";
const LIGHT_INK = "#ffffff";
export { DARK_INK, LIGHT_INK };

function resolveStorage(storage?: DraftStorage): DraftStorage | null {
  if (storage) return storage;
  try {
    return window.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

export function isThemeHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/** One stored custom-theme entry, or null if it fails validation (a bad
 *  entry drops alone; the rest of the list survives). */
function decodeCustomTheme(raw: unknown, takenIds: Set<string>): WebUITheme | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as { id?: unknown; label?: unknown; colors?: unknown };
  if (typeof e.id !== "string" || !THEME_ID_RE.test(e.id)) return null;
  if (THEME_REGISTRY.some((t) => t.id === e.id) || takenIds.has(e.id)) return null;
  if (typeof e.label !== "string") return null;
  const label = e.label.trim().slice(0, 40);
  if (label === "") return null;
  if (typeof e.colors !== "object" || e.colors === null) return null;
  const colors = e.colors as Record<string, unknown>;
  const decoded: ThemeColors = {};
  for (const token of EDITABLE_TOKENS) {
    if (!isThemeHex(colors[token.name])) return null;
    decoded[token.name] = (colors[token.name] as string).toLowerCase();
  }
  return { id: e.id, label, colors: decoded, builtIn: false };
}

/** The saved custom palettes, storage order, validated entry by entry:
 *  unreadable storage or garbage JSON is the empty list, a bad entry drops
 *  alone, ids colliding with a built-in or an earlier entry drop. */
export function loadCustomThemes(storage?: DraftStorage): WebUITheme[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    const raw = s.getItem(THEME_CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: WebUITheme[] = [];
    const taken = new Set<string>();
    for (const entry of parsed) {
      const theme = decodeCustomTheme(entry, taken);
      if (theme) {
        out.push(theme);
        taken.add(theme.id);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort persist: a blocked or quota-full store only costs the reload. */
export function saveCustomThemes(themes: WebUITheme[], storage?: DraftStorage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(THEME_CUSTOM_STORAGE_KEY, JSON.stringify(themes));
  } catch {
    // blocked storage / quota exceeded: the themes are lost on reload only
  }
}

/** Everything the editor shows as a choice: built-ins first, customs in
 *  storage order. */
export function themeChoices(storage?: DraftStorage): WebUITheme[] {
  return [...THEME_REGISTRY, ...loadCustomThemes(storage)];
}

/** The palette a stored/active id resolves to (built-in or custom), or null
 *  for an id nothing ships (a custom theme deleted elsewhere). */
export function resolveTheme(id: string, storage?: DraftStorage): WebUITheme | null {
  const builtin = THEME_REGISTRY.find((t) => t.id === id);
  if (builtin) return builtin;
  return loadCustomThemes(storage).find((t) => t.id === id) ?? null;
}

/** The palette to seed an edit / swatch from: unresolvable ids fall back to
 *  the default, matching what applyThemeId renders. */
export function paletteOf(id: string, storage?: DraftStorage): ThemeColors {
  return (resolveTheme(id, storage) ?? THEME_REGISTRY[0]!).colors;
}

/** Read the preference; unreadable storage, no key, or an id no theme ships
 *  means the default palette. A stored CUSTOM id is valid only while its
 *  entry is still in storage (delete the theme and the id degrades). */
export function loadThemeId(storage?: DraftStorage): string {
  const s = resolveStorage(storage);
  if (!s) return DEFAULT_THEME_ID;
  try {
    const raw = s.getItem(THEME_STORAGE_KEY);
    return typeof raw === "string" && resolveTheme(raw, s) !== null ? raw : DEFAULT_THEME_ID;
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

/** Display name for a stored/active id (the switcher's title and the
 *  editor's highlight). An id nothing resolves to displays the default's
 *  name, matching what actually renders. */
export function labelForTheme(id: string, storage?: DraftStorage): string {
  return (resolveTheme(id, storage) ?? THEME_REGISTRY[0]!).label;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = HEX_RE.exec(hex);
  if (!m) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG relative luminance, for the ink-on-accent decision. */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** Readable ink for a filled --accent surface: dark ink on a bright accent,
 *  white on a dark one (unparseable accents are treated as dark -> white). */
export function inkForAccent(accent: string): string {
  return relativeLuminance(accent) > 0.4 ? DARK_INK : LIGHT_INK;
}

function scaleHex(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const ch = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
  return `#${((1 << 24) | (ch(rgb[0]) << 16) | (ch(rgb[1]) << 8) | ch(rgb[2])).toString(16).slice(1)}`;
}

/** The four derived accent slots for an accent (see ACCENT_DERIVED). A bad
 *  accent yields its own value repeated -- writePalette is then a no-op
 *  color-wise, never garbage. */
export function accentDerivedTokens(accent: string): ThemeColors {
  const rgb = hexToRgb(accent);
  if (!rgb) {
    return { "--accent-hover": accent, "--accent-active": accent, "--accent-soft": accent, "--accent-glow": accent };
  }
  const [r, g, b] = rgb;
  return {
    "--accent-hover": scaleHex(accent, 0.86),
    "--accent-active": scaleHex(accent, 0.72),
    "--accent-soft": `rgba(${r}, ${g}, ${b}, 0.12)`,
    "--accent-glow": `rgba(${r}, ${g}, ${b}, 0.25)`,
  };
}

/** Slug from a display label ("My Cool Theme!" -> "my-cool-theme"), then
 *  uniquified against the taken ids with -2, -3... suffixes. An all-punctuation
 *  label still yields a usable id. */
export function newThemeId(label: string, taken: Iterable<string>): string {
  let slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (slug === "" || !THEME_ID_RE.test(slug)) slug = "theme";
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug.slice(0, 29)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The documentElement surface theme application needs (structurally
 *  satisfiable by the dom-helper stub in tests). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

/** Lift the inline palette off <html> so the stylesheet renders again. */
export function clearInlineTheme(root: ThemeRoot): void {
  for (const name of THEME_VARS) root.style.removeProperty(name);
}

/** Write a palette as inline custom properties (the four accent derivatives
 *  computed from --accent). Unresolvable token values are skipped rather
 *  than written garbage. */
export function writeInlineTheme(colors: ThemeColors, root: ThemeRoot): void {
  for (const token of EDITABLE_TOKENS) {
    const value = colors[token.name];
    if (isThemeHex(value)) root.style.setProperty(token.name, value.toLowerCase());
  }
  const accent = colors["--accent"];
  if (isThemeHex(accent)) {
    for (const [name, value] of Object.entries(accentDerivedTokens(accent))) {
      root.style.setProperty(name, value);
    }
  }
}

/** Put a theme on the page. Built-ins render from the stylesheet: the
 *  default REMOVES the data-theme attribute (the bare :root carries the
 *  hotdog palette), any other built-in sets it. A CUSTOM theme sets its id
 *  as the attribute AND writes its palette inline (inline overrides beat
 *  every :root block). Unresolvable ids render the default. */
export function applyThemeId(id: string, root: ThemeRoot = document.documentElement): void {
  const theme = resolveTheme(id);
  clearInlineTheme(root);
  if (theme === null || theme.id === DEFAULT_THEME_ID) root.removeAttribute("data-theme");
  else {
    root.setAttribute("data-theme", theme.id);
    if (!theme.builtIn) writeInlineTheme(theme.colors, root);
  }
}

/** The boot line: load the stored preference and put it on documentElement.
 *  index.html carries a tiny inline mirror of this in <head> so the FIRST
 *  paint already shows the stored palette (no hotdog-then-custom flash);
 *  this call is the same value re-applied once the module is up, so the two
 *  never disagree. Returns the applied id for the app's atom. */
export function applyStoredTheme(storage?: DraftStorage, root?: ThemeRoot): string {
  const id = loadThemeId(storage);
  applyThemeId(id, root ?? document.documentElement);
  return id;
}
