/// <reference lib="dom" />
// Theme EDITOR dialog (the header palette button opens it). Layout, top to
// bottom: a strip of small live swatch previews (built-in + saved custom
// themes; click applies), a grid of color inputs editing the palette on the
// fly (every pick re-writes <html> inline custom properties through
// theme-pref's writeInlineTheme, so the whole app previews live), and a
// footer that RIDES THE DRAFT: while the theme is unmodified there is no
// footer at all; the first change brings it up -- "Save New" (a normal
// button with accent text; clicking it opens the name field + Save beside
// it), the accented primary Update "name" on a custom base (writes the
// draft onto that same theme; built-ins ship in styles.css and are never
// overwritten), and Revert.
// Rows whose draft value differs from the base palette carry a "*".
// Custom swatches carry a two-step delete (arm, then confirm; Escape or
// clicking elsewhere disarms -- the provider-Remove doctrine).
//
// Doctrine: themes are per-browser view state (theme-pref.ts) -- zero wire.
// The dialog never mutates the theme it opened on: edits live in the draft
// over the base palette; Escape closes in stages (disarm -> collapse the
// name entry -> revert the draft -> close), applying another theme re-seeds
// the draft. Unsaved edits are discarded on close and on switching themes.
//
// The pure state helpers below are exported for tests; every one of them
// returns the same object when nothing would change, so a garbage color
// input never repaints nor touches <html>.

import type { Ref } from "@utils/jsx";
import {
  EDITABLE_TOKENS,
  THEME_REGISTRY,
  isThemeHex,
  inkForAccent,
  labelForTheme,
  paletteOf,
  type ThemeColors,
  type ThemeTokenDef,
  type WebUITheme,
} from "./theme-pref.ts";

// ── Pure editor state (see the app's themeEditorAtom) ──────────────────────

export interface ThemeEditorState {
  open: boolean;
  /** The theme the dialog is editing ON TOP of: seed of the draft and what
   *  Revert / close / Escape step back to. */
  baseId: string;
  /** The working palette (complete over EDITABLE_TOKENS, lowercase hex). */
  draft: ThemeColors;
  /** The "save as new theme" name field. */
  name: string;
  /** Whether the save-as-new NAME ENTRY (input + Save button) is open. */
  nameOpen: boolean;
  /** The custom theme whose delete is armed (two-step confirm), or null. */
  confirmDeleteId: string | null;
}

export const initialThemeEditorState: ThemeEditorState = {
  open: false,
  // The registry head IS the default (no DEFAULT_* import; house lint).
  baseId: THEME_REGISTRY[0]!.id,
  draft: { ...THEME_REGISTRY[0]!.colors },
  name: "",
  nameOpen: false,
  confirmDeleteId: null,
};

/** Open on the active theme: the draft seeds from its palette. A previously
 *  left-behind armed delete never survives the close. */
export function openThemeEditor(activeId: string): ThemeEditorState {
  return {
    open: true,
    baseId: activeId,
    draft: { ...paletteOf(activeId) },
    name: "",
    nameOpen: false,
    confirmDeleteId: null,
  };
}

export function closeThemeEditor(): ThemeEditorState {
  return { ...initialThemeEditorState, draft: { ...initialThemeEditorState.draft } };
}

/** Re-seed the draft onto another (or the same, post-revert) base: the
 *  delete arm is dropped and the name entry collapses with the draft. */
export function adoptThemeDraft(s: ThemeEditorState, baseId: string): ThemeEditorState {
  return { ...s, baseId, draft: { ...paletteOf(baseId) }, nameOpen: false, confirmDeleteId: null };
}

/** Paint one token into the draft. An accent pick also flips
 *  --accent-ink to readable ink (the CSS recipe's rule; the ink row is
 *  editable too, so the auto-suggestion is only ever a default). Garbage
 *  hex (should not happen from a color input) returns the state untouched. */
export function setThemeDraftColor(s: ThemeEditorState, token: string, hex: string): ThemeEditorState {
  if (!isThemeHex(hex) || !(token in s.draft)) return s;
  const value = hex.toLowerCase();
  const draft = { ...s.draft, [token]: value };
  if (token === "--accent") draft["--accent-ink"] = inkForAccent(value);
  return { ...s, draft };
}

export function setThemeName(s: ThemeEditorState, text: string): ThemeEditorState {
  if (text === s.name) return s;
  return { ...s, name: text };
}

/** The "Save New" entry click: opens the name field + Save. */
export function openThemeNameEntry(s: ThemeEditorState): ThemeEditorState {
  if (s.nameOpen) return s;
  return { ...s, nameOpen: true };
}

/** Collapse the name entry (Escape's step; the typed name survives the
 *  collapse -- reopening picks up where it left off). */
export function closeThemeNameEntry(s: ThemeEditorState): ThemeEditorState {
  if (!s.nameOpen) return s;
  return { ...s, nameOpen: false };
}

export function armThemeDelete(s: ThemeEditorState, id: string): ThemeEditorState {
  if (s.confirmDeleteId === id) return s;
  return { ...s, confirmDeleteId: id };
}

export function cancelThemeDelete(s: ThemeEditorState): ThemeEditorState {
  if (s.confirmDeleteId === null) return s;
  return { ...s, confirmDeleteId: null };
}

/** Draft vs the base palette's stored values: what the footer, the row
 *  stars and the staged Escape read. */
export function themeDraftDirty(s: ThemeEditorState): boolean {
  const base = paletteOf(s.baseId);
  return EDITABLE_TOKENS.some((t) => s.draft[t.name] !== base[t.name]);
}

// ── View ────────────────────────────────────────────────────────────────────

/** Group the token list once at module load; EDITABLE_TOKENS is static. */
const TOKEN_GROUPS: { title: string; tokens: ThemeTokenDef[] }[] = [];
for (const token of EDITABLE_TOKENS) {
  const last = TOKEN_GROUPS[TOKEN_GROUPS.length - 1];
  if (last && last.title === token.group) last.tokens.push(token);
  else TOKEN_GROUPS.push({ title: token.group, tokens: [token] });
}

/** Manual ancestor walk (the shared dom helper has no closest()) -- the
 *  same idiom as settings-view's insideProviderAffordance: the click-away
 *  cancel must not fire while pressing the delete affordance itself. */
function insideDeleteAffordance(node: unknown): boolean {
  let cur = node as { getAttribute?: (n: string) => string | null; parentNode?: unknown } | null | undefined;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if ((cur.getAttribute?.("class") ?? "").includes("theme-swatch-del")) return true;
    cur = cur.parentNode as typeof cur;
  }
  return false;
}

/** The mini palette sample: a tiny mock chat card painted with the theme's
 *  own tokens (inline styles -- the swatch shows the STORED palette, not
 *  what the page currently renders). */
function SwatchCard({ colors }: { colors: ThemeColors }) {
  const card = {
    background: colors["--bg-surface-1"],
    border: `1px solid ${colors["--border"]}`,
  };
  return (
    <span className="theme-swatch-card" style={card} aria-hidden="true">
      <span className="theme-swatch-top">
        <span className="theme-swatch-dot" style={{ background: colors["--accent"] }} />
        <span className="theme-swatch-line theme-swatch-line-title" style={{ background: colors["--text-primary"] }} />
      </span>
      <span className="theme-swatch-line" style={{ background: colors["--text-secondary"] }} />
      <span className="theme-swatch-line theme-swatch-line-short" style={{ background: colors["--text-muted"] }} />
      <span
        className="theme-swatch-pill"
        style={{ background: colors["--accent"], color: colors["--accent-ink"] }}
      >
        Aa
      </span>
    </span>
  );
}

export interface ThemeEditorProps {
  /** The applied theme id (what the swatch strip marks pressed). */
  activeId: string;
  /** Storage-truth customs, read once per open render by the app (an empty
   *  list while the dialog is closed; it is not mounted then). */
  customThemes: WebUITheme[];
  state: ThemeEditorState;
  dirty: boolean;
  /** Stable ref identity so the app can move focus in on open. */
  rootRef: Ref;
  onApply: (id: string) => void;
  onColor: (token: string, hex: string) => void;
  onName: (text: string) => void;
  /** The "Save New" entry click: opens the name field + Save. */
  onSaveNew: () => void;
  /** Collapse the name entry (Escape's step). */
  onCancelNew: () => void;
  /** Persist the draft under the entered name as a NEW theme. */
  onSave: () => void;
  /** Write the draft onto the custom base (in place, same id). */
  onUpdate: () => void;
  onRevert: () => void;
  onArmDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onClose: () => void;
}

export function ThemeEditor({
  activeId,
  customThemes,
  state,
  dirty,
  rootRef,
  onApply,
  onColor,
  onName,
  onSaveNew,
  onCancelNew,
  onSave,
  onUpdate,
  onRevert,
  onArmDelete,
  onConfirmDelete,
  onCancelDelete,
  onClose,
}: ThemeEditorProps) {
  const choices = [...THEME_REGISTRY, ...customThemes];
  const baseCustom = customThemes.some((t) => t.id === state.baseId);
  // The stars compare the draft against the base palette's STORED values
  // (for a custom base, whatever is saved -- not the live preview).
  const baseColors = paletteOf(state.baseId);
  return (
    <div
      id="theme-view"
      className="settings-view theme-view"
      role="dialog"
      aria-modal="true"
      aria-labelledby="theme-view-title"
      tabindex={-1}
      ref={rootRef}
      onKeydown={(e: KeyboardEvent) => {
        // Staged retreat (the settings dialog's ladder): a pending delete
        // disarms first, then an open save-as-new name entry collapses,
        // then unsaved draft edits revert to the base palette, and only a
        // clean dialog closes (the app hands focus back to the palette
        // button). Pure client state -- zero wire.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (state.confirmDeleteId !== null) onCancelDelete();
        else if (state.nameOpen) onCancelNew();
        else if (dirty) onRevert();
        else onClose();
      }}
      onMousedown={(e: MouseEvent) => {
        // Click-away disarms a pending delete -- but not while pressing the
        // affordance itself (arm -> confirm would never confirm).
        if (state.confirmDeleteId === null) return;
        if (insideDeleteAffordance((e as unknown as { target?: unknown }).target)) return;
        onCancelDelete();
      }}
    >
      <div className="settings-view-header">
        <h2 id="theme-view-title">Themes</h2>
        <button
          type="button"
          className="settings-btn settings-close"
          title="Close (Esc)"
          aria-label="Close theme editor"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="theme-swatches" role="group" aria-label="Saved themes">
        {choices.map((t) => {
          const armed = state.confirmDeleteId === t.id;
          return (
            <span className="theme-swatch-wrap" key={t.id}>
              <button
                type="button"
                className="theme-swatch"
                aria-pressed={t.id === activeId ? "true" : "false"}
                title={`Apply the ${t.label} theme`}
                onClick={() => onApply(t.id)}
              >
                <SwatchCard colors={t.colors} />
                <span className="theme-swatch-label">{t.label}</span>
              </button>
              {t.builtIn ? null : (
                <button
                  type="button"
                  className={`theme-swatch-del${armed ? " armed" : ""}`}
                  aria-label={armed ? `Confirm delete ${t.label}` : `Delete ${t.label}`}
                  title={armed ? "Click again to delete, Escape to cancel" : "Delete theme"}
                  onClick={() => (armed ? onConfirmDelete(t.id) : onArmDelete(t.id))}
                >
                  {armed ? "Sure?" : "✕"}
                </button>
              )}
            </span>
          );
        })}
      </div>
      <div className="theme-view-body">
        {TOKEN_GROUPS.map((g) => (
          <div className="theme-color-group" key={g.title}>
            <h3 className="theme-color-group-title">{g.title}</h3>
            <div className="theme-colors">
              {g.tokens.map((token) => {
                const value = state.draft[token.name];
                const changed = value !== baseColors[token.name];
                return (
                  <label className="theme-color-row" key={token.name}>
                    <span className="theme-color-label">
                      {token.label}
                      {changed ? (
                        <span className="theme-color-changed" title="Different from the saved theme">
                          *
                        </span>
                      ) : null}
                      {token.hint ? <span className="theme-color-hint">{token.hint}</span> : null}
                    </span>
                    <input
                      type="color"
                      data-token={token.name}
                      value={value ?? "#000000"}
                      title={token.name}
                      aria-label={token.hint ? `${token.label} (${token.hint})` : token.label}
                      onInput={(e: Event) => {
                        const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
                          | { value?: string }
                          | null;
                        const hex = src?.value ?? "";
                        if (isThemeHex(hex)) onColor(token.name, hex);
                      }}
                    />
                    <code className="theme-color-hex">{value}</code>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {dirty ? (
        <div className="theme-editor-foot">
          {state.nameOpen ? (
            <>
              <input
                className="theme-name"
                type="text"
                placeholder="New theme name"
                aria-label="New theme name"
                value={state.name}
                onInput={(e: Event) => {
                  const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
                    | { value?: string }
                    | null;
                  onName(src?.value ?? "");
                }}
                onKeydown={(e: KeyboardEvent) => {
                  // Enter saves the new theme (a no-op while the name is
                  // empty, same as the disabled button).
                  if (e.key !== "Enter") return;
                  e.preventDefault(); // never a form default; the dialog owns keys
                  onSave();
                }}
              />
              <button
                type="button"
                className="settings-btn theme-save"
                disabled={state.name.trim() === ""}
                title="Save the edited palette as a new theme"
                onClick={onSave}
              >
                Save
              </button>
            </>
          ) : (
            <button
              type="button"
              className="settings-btn theme-save-new"
              title="Save the edited palette as a new theme"
              onClick={onSaveNew}
            >
              Save New
            </button>
          )}
          {baseCustom ? (
            <button
              type="button"
              className="settings-btn theme-update"
              title={`Save these colors onto ${labelForTheme(state.baseId)} (same theme, same swatch)`}
              onClick={onUpdate}
            >
              Update "{labelForTheme(state.baseId)}"
            </button>
          ) : null}
          <button type="button" className="settings-btn theme-revert" onClick={onRevert}>
            Revert changes
          </button>
        </div>
      ) : null}
    </div>
  );
}
