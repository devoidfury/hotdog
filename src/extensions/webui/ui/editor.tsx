/// <reference lib="dom" />
// The workbench editor: a custom zero-dependency editor on the house JSX
// runtime, replacing the read-only viewer for files the read already caps.
//
// ── THE TEXTAREA / BUFFER / IME CONTRACT (the CM5 trick) ───────────────────
// A real (visually hidden) <textarea> holds FOCUS and owns only the
// in-flight composition text. Every editing key is intercepted in keydown
// BEFORE default and applied to the pure buffer (editor-buffer.ts); the
// visible layer renders the buffer's lines. So the textarea's invariant is
// "empty" -- except between compositionstart and compositionend, where the
// IME legitimately owns it. The sync rules:
//   - keydown returns early while composing (or e.isComposing / key
//     "Process"): the IME keeps its text and its keys;
//   - compositionend is the ONLY commit point: the committed text is
//     e.data, falling back to the textarea's value ONLY when e.data is
//     null/undefined (some UAs omit it); an EMPTY e.data means the
//     composition was canceled, so nothing commits -- the textarea is
//     cleared and the caret overlay reappears where it was. A canceled
//     composition (Escape mid-IME) hits that same "commit only on end,
//     empty means cancel" rule;
//   - every other path that could dirty the textarea (typing, paste after
//     reading clipboardData, a stray native copy over composition residue)
//     clears it in the same tick, so buffer and textarea cannot diverge
//     across any of them;
//   - clipboard copy/cut both write through copyText (utils.ts: the
//     clipboard API with the legacy execCommand fallback inside). The
//     selection text comes from the buffer's allSelText (multi-range
//     selections join with \n) and never transits the textarea; a cut
//     applies the deletion to the buffer through the undo seam itself.
// Soft keyboards without reliable keydown still land through compositionend
// (that is what the IME path is for); hardware-keyboard chords outside
// composition require the key events, the same ceiling CM5 lives with.
//
// ── RENDER / METRICS ───────────────────────────────────────────────────────
// Monospace metrics come from ONE shared cell width (a 100-glyph probe span;
// offsetWidth /100) with a deterministic fallback so tests hit-test without
// layout (dom-helper reports no geometry). The probe inherits the SAME computed
// font as the code spans (--font-mono, 14px, weight normal, no letter-spacing,
// NO ligatures -- see .editor/.editor-measure in styles.css); if it measured a
// different face the caret/hit cell would not match the rendered advance and
// the drift would grow with the column. Because the webfont finishes loading
// AFTER first paint, the probe is re-measured when document.fonts settles and
// every mounted editor repaints on the change. Column<->x goes through ONE
// mapping (editor-buffer xForCol/colForX) shared by the caret, the selection
// rects, and the click hit-test, so a click and the caret it lands on cannot
// diverge. Line height is CSS-owned at exactly EDIT_LINE_H px. Only a
// WINDOWED slice of lines renders: the canvas div is totalLines x EDIT_LINE_H
// tall and the rows ride an absolutely positioned window recomputed from the
// viewport's scroll offset, so a file at the cap costs ~viewport rows of DOM,
// not 260k. Tokenizer spans come from file-view's language mapping
// (tokenizeFileLines) and paint through the shared ws-render.tsx spans, so the
// editor and the read-only viewer color identically. (Markdown's doc-stateful
// pass sees the WINDOW, not the file -- fences opened far above the window
// repaint plain until they scroll in.)
//
// ── FULL-HEIGHT PANE ─────────────────────────────────────────────────────────
// The editor fills the workbench pane edge to edge and top to bottom: the
// :has(.editor) flex chain in styles.css makes the tab body a definite-height
// column, so .editor-viewport (flex:1) grows to the pane and --bg-base paints
// the sheet down to the foot bar on a three-line file (no --bg-secondary gap).
// Scrolling lives ONLY in the viewport; #workbench-body stops scrolling for a
// file tab (no double scrollbar). A click in the empty area BELOW the last
// line lands the caret at the buffer's END (never a phantom row): the viewport
// owns that click, since rows only cover total x EDIT_LINE_H -- see the
// viewport onMousedown. EDIT_LINE_H is unchanged and still the single source
// of row geometry.
//
// The undo seam, selection model, save/dirty machine: editor-buffer.ts.
// Whitespace visibility is a per-BROWSER view pref right here (theme-pref's
// localStorage pattern, throwing-access guard included) -- no server, no
// config key.

import type { JsxChild } from "@utils/jsx";
import { IconReload, IconWhitespace } from "./icons.tsx";
import { fileViewLangChoices, langLabel, tokenizeFileLines } from "./file-view.tsx";
import { codeSpans } from "./ws-render.tsx";
import { copyText } from "./utils.ts";
import {
  addCaretVertical,
  allSelText,
  altClickCaret,
  backspaceSmart,
  boxSelect,
  collapseSelections,
  colForX,
  dedentLines,
  deleteForward,
  docEnd,
  docStart,
  indentTab,
  insertText,
  matchBracket,
  moveHorizontal,
  moveVertical,
  pressEnterSmart,
  redo,
  selectAll,
  selectWordAt,
  setCaret,
  smartEnd,
  smartHome,
  typeChar,
  undo,
  xForCol,
  type EditorSession,
  type Pos,
  type TextBuffer,
} from "./editor-buffer.ts";

/** CSS-owned row height of the editor's line layer, in px. Hit-testing and
 *  the caret/selection overlay trust this constant; styles.css pins it. */
export const EDIT_LINE_H = 20;

/** Character width used whenever the probe cannot measure (no layout in the
 *  test DOM). The probe always wins in a real browser. */
const FALLBACK_CHAR_W = 8;

/** Rows rendered beyond the viewport in each direction (a wheel flick
 *  paints ahead instead of flashing empty). */
const OVERSCAN = 6;

// ── Whitespace visibility pref (localStorage, per browser) ─────────────────
// The theme-pref pattern verbatim: resolved per call, EVERY op swallowed --
// accessing localStorage itself can throw (private-mode Safari), and a
// blocked store only costs the reload. A view pref: no server, no config.

export const WS_STORAGE_KEY = "hotdog-webui-show-ws";

function wsStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadShowWs(): boolean {
  const s = wsStorage();
  if (!s) return false;
  try {
    return s.getItem(WS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowWs(on: boolean): void {
  const s = wsStorage();
  if (!s) return;
  try {
    if (on) s.setItem(WS_STORAGE_KEY, "1");
    else s.removeItem(WS_STORAGE_KEY);
  } catch {
    // blocked storage / quota: the marks flip for this page only
  }
}

// ── Per-path view state (module-level: components are stateless) ───────────

interface EditorView {
  scrollTop: number;
  viewportH: number;
  /** Viewport + code-anchor rects, refreshed from refs (0 in the test DOM,
   *  which is the documented zero-rect fallback). */
  vpTop: number;
  vpLeft: number;
  codeLeft: number;
  ta: HTMLTextAreaElement | null;
  composing: boolean;
  dragging: boolean;
  /** Alt+Shift+drag box anchor (the line + visual column where the box drag
   *  started). While set, drag moves apply boxSelect instead of extending
   *  the primary range. Cleared on mouseup/mousedown without alt+shift. */
  boxAnchor: { line: number; vcol: number } | null;
  /** The gutter width the caret X must clear: the painted caret resolves
   *  against position:relative `.editor-code` (which starts after the
   *  .file-ln gutter), while the hidden textarea is parked in the canvas.
   *  Measured from the same rects the hit-test already reads (0 in the test
   *  DOM = the documented zero-rect fallback), so the textarea lands in the
   *  code element's coordinate space instead of one gutter to the left. */
  gutterPx: number;
  /** Poke the app to re-render THIS mounted editor (set each render). The
   *  shared cell width changing (the webfont finishing) uses it to repaint
   *  every open editor onto the new advance. */
  repaint: (() => void) | null;
  /** The viewport node, so a goto jump can scroll the windowed slice. */
  vp: HTMLElement | null;
  /** The foot-bar jump box: open/closed (the one bit that renders) plus the
   *  input's text mirror (the DOM owns the caret; the mirror only re-seeds
   *  the box when a re-render re-patches it). Ephemeral by design: no
   *  config key, no localStorage. */
  gotoOpen: boolean;
  gotoText: string;
  gotoEl: HTMLInputElement | null;
}

const editorViews = new Map<string, EditorView>();

function viewOf(path: string): EditorView {
  let v = editorViews.get(path);
  if (!v) {
    v = { scrollTop: 0, viewportH: 0, vpTop: 0, vpLeft: 0, codeLeft: 0, gutterPx: 0, ta: null, composing: false, dragging: false, boxAnchor: null, repaint: null, vp: null, gotoOpen: false, gotoText: "", gotoEl: null };
    editorViews.set(path, v);
  }
  return v;
}

// ── Shared cell width (the advance the caret/hit/paint all trust) ───────────
// One page-wide number: every editor uses the same mono face, so ONE probe
// (a 100-glyph span's offsetWidth /100) owns it. The probe's CSS matches the
// code spans exactly (--font-mono / 14px / normal weight / no letter-spacing /
// ligatures off); a mismatched face would make the caret cell differ from the
// rendered glyph advance and the caret x would drift by (measured - real) x
// column -- webfonts load AFTER first paint, so the probe is
// re-measured when document.fonts settles; if the advance changed, every open
// editor repaints. `measuredCharW === 0` means "not yet measured" -> the
// deterministic fallback (dom-helper has no layout).
let measuredCharW = 0;
let probeNode: HTMLElement | null = null;
export const charWidth = (): number => (measuredCharW > 0 ? measuredCharW : FALLBACK_CHAR_W);

const repaintMountedEditors = (): void => {
  for (const v of editorViews.values()) v.repaint?.();
};

/** Read the probe's 100-glyph width and adopt it as the shared advance.
 *  `readWidth100` defaults to the live probe (its offsetWidth); tests inject a
 *  faked number (no layout in the test DOM). Returns true when the advance
 *  actually changed, in which case every mounted editor is repainted so the
 *  caret/selection/overlay re-place onto the new cell width. A non-positive
 *  read (zero layout, or fonts still pending) leaves the current value alone. */
export function remeasureCharWidth(readWidth100: () => number = () => probeNode?.offsetWidth ?? 0): boolean {
  const w = readWidth100();
  if (!(w > 0)) return false;
  const next = w / 100;
  if (Math.abs(next - measuredCharW) < 0.01) return false; // same face within sub-pixel
  measuredCharW = next;
  repaintMountedEditors();
  return true;
}

/** The exact faces the code spans render in (weight 400 + the semibold the
 *  tokenizer uses), so document.fonts.load forces THEM, not the UI face. */
const CODE_FONT_SPECS = ['400 14px "Reddit Mono"', '600 14px "Reddit Mono"'];
const PROBE_TEXT = "0".repeat(10);

interface FontFaceSetLike {
  ready?: Promise<unknown>;
  load?: (font: string, text: string) => Promise<unknown> | void;
}

/** Re-measure the shared cell width when the webfont finishes loading. Guarded
 *  for presence (older engines, and the test DOM, have no document.fonts) --
 *  with no FontFaceSet the one-shot probe measurement above is all we get. */
export function installFontRemeasure(
  fonts: FontFaceSetLike | undefined,
  readWidth100: () => number = () => probeNode?.offsetWidth ?? 0,
): void {
  if (!fonts) return;
  const run = (): void => {
    remeasureCharWidth(readWidth100);
  };
  // Kick the exact faces (some engines only load a face once it is requested),
  // then re-measure when the load AND the whole set settle.
  try {
    for (const spec of CODE_FONT_SPECS) {
      const r = fonts.load?.(spec, PROBE_TEXT) as Promise<unknown> | undefined;
      r?.then?.(run, () => {});
    }
  } catch {
    /* no FontFaceSet.load: rely on .ready below */
  }
  try {
    fonts.ready?.then?.(run, () => {});
  } catch {
    /* nothing to await; the initial probe measurement stands */
  }
}

// Re-measure the shared advance once the webfont settles (guarded -- no
// FontFaceSet, e.g. the test DOM, keeps the one-shot probe measurement).
if (typeof document !== "undefined") {
  installFontRemeasure((document as unknown as { fonts?: FontFaceSetLike }).fonts);
}


const clearInput = (v: EditorView): void => {
  const ta = v.ta;
  if (ta && ta.value !== "") {
    ta.value = "";
    ta.setSelectionRange(0, 0);
  }
};

/** The foot bar's jump grammar: `N` (line only, column kept) or `N:M`, both
 *  1-based with positive integers. Anything else is null (the caller refuses
 *  by keeping the box open); clamping to the buffer is setCaret's job. */
function parseGotoSpec(raw: string): { line: number; col?: number } | null {
  const m = /^(\d+)(?::(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const line = Number(m[1]);
  const col = m[2] === undefined ? undefined : Number(m[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  if (col !== undefined && (!Number.isInteger(col) || col < 1)) return null;
  return { line, col };
}

export interface FileEditorProps {
  path: string;
  session: EditorSession;
  /** Paint lang for the layer (the viewer's override already folded in). */
  lang: string | undefined;
  /** The foot bar's syntax chooser: the auto-detected lang, the in-force
   * paint override (undefined = Auto), and the setter routing to the
   * viewer's store seam so BOTH shapes share one override per path. */
  guessed: string | undefined;
  override?: string;
  onLang?: (path: string, lang: string | null) => void;
  showWs: boolean;
  /** Hand the next session state to the app (buffer, caret, scroll poke). */
  onCommit: (path: string, next: EditorSession) => void;
  /** Ctrl/Cmd+S: the app owns the wire (saveFile + the conflict dialog). */
  onSave: (path: string) => void;
  onReload: (path: string) => void;
  onToggleWs: () => void;
}

export function FileEditor(p: FileEditorProps): JsxChild {
  const buf = p.session.buffer;
  const v = viewOf(p.path);
  const cw = charWidth();
  const total = buf.lines.length;
  const start = Math.max(0, Math.floor(v.scrollTop / EDIT_LINE_H) - OVERSCAN);
  const windowRows = Math.ceil((v.viewportH || 30 * EDIT_LINE_H) / EDIT_LINE_H) + OVERSCAN * 2;
  const end = Math.min(total, start + windowRows);
  const slice = buf.lines.slice(start, end);
  const runs = tokenizeFileLines(slice, p.lang);

  // The poke the shared cell width uses to repaint this editor when the
  // webfont settles; refreshed every render so it captures the live props.
  v.repaint = () => p.onCommit(p.path, p.session);

  const act = (next: TextBuffer): void => {
    if (next === buf) return;
    clearInput(v);
    p.onCommit(p.path, { ...p.session, buffer: next });
  };
  // Click -> column: THE shared mapping (editor-buffer colForX), the exact
  // inverse of the caret's xForCol below, so they cannot diverge.
  const hitFromX = (x: number, line: number): Pos => {
    return { line, col: colForX(buf.lines[line] ?? "", x, cw) };
  };

  // Caret pixel position (visual column -> px), both for the overlay and
  // for parking the hidden textarea under it (the IME candidate window
  // follows the caret). Same xForCol the hit-test inverts.
  const head = buf.sels[buf.primary]?.head ?? { line: 0, col: 0 };
  const caretX = xForCol(buf.lines[head.line] ?? "", head.col, cw);
  // Matched-bracket highlight: the pair adjacent to the (primary) caret and
  // its mate, recomputed every render -- so it appears on adjacency and
  // vanishes on move for free, and never lags the buffer.
  const match = matchBracket(buf.lines, head);

  const statusText = p.session.saving ? "saving..." : buf.dirty ? "edited" : "saved";

  // ── row:col readout + jump ───────────────────────────────────────────────
  // The readout renders from the primary head, so every caret move repaints
  // it for free (onCommit owns the render). Clicking it swaps in a small
  // uncontrolled input (the settings-edit idiom): the DOM holds the bytes,
  // the view state keeps only the open bit plus a text mirror so a
  // re-render re-patching the input never wipes what was typed.
  const openGoto = (): void => {
    v.gotoOpen = true;
    v.gotoText = `${head.line + 1}:${head.col + 1}`;
    p.onCommit(p.path, p.session);
  };
  const closeGoto = (backToEditor: boolean): void => {
    v.gotoOpen = false;
    if (backToEditor) v.ta?.focus();
    p.onCommit(p.path, p.session);
  };
  const submitGoto = (): void => {
    const g = parseGotoSpec(v.gotoEl?.value ?? v.gotoText);
    // Honest refusal: a bad spec leaves the box OPEN for the fix -- no jump,
    // no close, no buffer touch.
    if (!g) return;
    const line = Math.min(g.line - 1, total - 1);
    const next = setCaret(buf, { line, col: g.col === undefined ? head.col : g.col - 1 });
    // Keyboard moves never scroll the viewport (the browser's own focus
    // scroll does that for the parked textarea), but a jump has no such
    // helper: carry the window so the caret row is inside the windowed
    // slice. Setting node.scrollTop re-enters onScroll with the same
    // number in a real browser (a no-op repaint); the view state here is
    // already correct, so commit once regardless.
    const vh = v.viewportH || 30 * EDIT_LINE_H;
    const rowTop = line * EDIT_LINE_H;
    if (rowTop < v.scrollTop) v.scrollTop = rowTop;
    else if (rowTop + EDIT_LINE_H > v.scrollTop + vh) v.scrollTop = rowTop + EDIT_LINE_H - vh;
    if (v.vp && v.vp.scrollTop !== v.scrollTop) v.vp.scrollTop = v.scrollTop;
    v.gotoOpen = false;
    v.ta?.focus();
    act(next); // setCaret: primary head at the target, list collapsed to one caret
  };

  return (
    <div className="editor" data-path={p.path}>
      <div
        className="editor-viewport"
        ref={(el) => {
          const node = el as unknown as HTMLElement | null;
          v.vp = node; // the jump path scrolls this node when the caret lands off-window
          if (!node) return;
          // The ref fires BEFORE the node joins the tree (the house JSX
          // create path), so every rect read here is zero; the same read
          // lands again in a microtask, once insertion + layout exist
          // (the probe's own deferral pattern). Without it the viewport
          // rode vpTop/gutterPx = 0 until the first re-render, and the
          // parked textarea sat a gutter left of the caret for the IME.
          const measure = (): void => {
            const r = node.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) return; // zero-rect fallback
            v.viewportH = node.clientHeight;
            v.vpTop = r.top;
            v.vpLeft = r.left;
            // The gutter offset: caretX lives in .editor-code space while
            // the parked textarea positions against .editor-canvas.
            const canvas = node.querySelector(".editor-canvas") as unknown as HTMLElement | null;
            const code = node.querySelector(".editor-code") as unknown as HTMLElement | null;
            if (canvas && code) {
              const g = code.getBoundingClientRect().left - canvas.getBoundingClientRect().left;
              if (g > 0) v.gutterPx = g;
            }
          };
          measure();
          queueMicrotask(() => {
            if ((node as unknown as { isConnected?: boolean }).isConnected !== false) measure();
          });
        }}
        onScroll={(e: Event) => {
          const node = e.currentTarget as unknown as HTMLElement;
          v.scrollTop = node.scrollTop;
          v.viewportH = node.clientHeight;
          // Scroll-only change: poke the app's render (same session, new
          // map) so the windowed slice re-computes.
          p.onCommit(p.path, p.session);
        }}
        onMousedown={(e: MouseEvent) => {
          // A row claims its own click (its handler preventDefaults, which
          // bubbles here); what reaches THIS handler is the empty area the
          // sheet paints BELOW the last line once the viewport fills the
          // full pane. VS Code lands the caret at the buffer's END there --
          // never a phantom row past the buffer -- and starting a drag
          // selects back up through the text (the move clamps to the last
          // line; EDIT_LINE_H still owns every row's math).
          if (e.defaultPrevented) return;
          // GENUINE background clicks only: a row claimed its press (the
          // defaultPrevented gate above), a scrollbar press arrives with an
          // offset past the client box, and any other non-row target (the
          // capture textarea is pointer-transparent in real browsers) must
          // never teleport the caret to buffer END.
          // currentTarget is absent in the raw-payload test DOM (dom-helper
          // does not stamp it), so the scoping applies only where a real
          // browser (or a pin that passes currentTarget explicitly) speaks.
          const bg = (e as unknown as { currentTarget?: HTMLElement }).currentTarget;
          if (bg) {
            const ox = (e as unknown as { offsetX?: number }).offsetX;
            const oy = (e as unknown as { offsetY?: number }).offsetY;
            if (ox !== undefined && ox >= bg.clientWidth) return;
            if (oy !== undefined && oy >= bg.clientHeight) return;
            const t = e.target as unknown as HTMLElement | null;
            if (t && t !== bg && !t.className?.includes?.("editor-canvas")) return;
          }
          e.preventDefault();
          v.ta?.focus();
          v.boxAnchor = null;
          v.dragging = true;
          act(docEnd(buf, e.shiftKey));
        }}
        onMousemove={(e: MouseEvent) => {
          if (!v.dragging || (e.buttons & 1) === 0) return;
          // The rects were measured at mount; a panel drag or a window
          // scroll since then makes them stale, so re-read the viewport's
          // box at the start of each drag move (the DOM the event rode on).
          const node = e.currentTarget as unknown as HTMLElement;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            v.vpTop = rect.top;
            v.vpLeft = rect.left;
            // The x origin rides the SAME live read, per move: every painted
            // row shares one code origin, so the first painted row's rect IS
            // the drag's origin -- through horizontal scroll included (a
            // value captured at press time goes stale the moment the wheel
            // turns).
            const code0 = node.querySelector(".editor-code") as unknown as HTMLElement | null;
            if (code0) {
              const cr = code0.getBoundingClientRect();
              if (cr.width > 0) v.codeLeft = cr.left;
            }
          }
          const y = e.clientY - v.vpTop + v.scrollTop;
          const line = Math.max(0, Math.min(total - 1, Math.floor(y / EDIT_LINE_H)));
          if (v.boxAnchor) {
            // Alt+Shift+drag: the box REBUILDS every move from the anchor
            // (a full boxSelect, never an incremental extend), clamped to
            // each line's own length -- short lines never gain padding.
            const vcol = Math.max(0, (e.clientX - v.codeLeft) / cw);
            act(boxSelect(buf, v.boxAnchor, { line, vcol }));
            return;
          }
          const pos = hitFromX(e.clientX - v.codeLeft, line);
          const cur = buf.sels[buf.primary] ?? buf.sels[0]!;
          act({ ...buf, sels: buf.sels.map((r, i) => (i === buf.primary ? { anchor: cur.anchor, head: pos } : r)) });
        }}
        onMouseup={() => {
          v.dragging = false;
          v.boxAnchor = null;
        }}
        onMouseleave={() => {
          v.dragging = false;
          v.boxAnchor = null;
        }}
      >
        {/* The scroll spacer: total file height; the rendered rows ride the
            absolutely positioned window, so a capped file costs viewport
            rows of DOM, not its whole line count. The hidden capture
            textarea lives INSIDE the canvas and parks under the caret --
            its coordinates never exceed the canvas the rows already size,
            so it adds no scroll area, and the IME candidate window follows
            the caret like every real editor's. */}
        <div className="editor-canvas" style={{ height: `${total * EDIT_LINE_H}px` }}>
          <textarea
            className="editor-input"
            aria-label={`Editing ${p.path}`}
            spellcheck="false"
            autocorrect="off"
            autocapitalize="off"
            wrap="off"
            style={{ left: `${caretX + v.gutterPx}px`, top: `${head.line * EDIT_LINE_H}px` }}
            ref={(el) => {
              v.ta = el as unknown as HTMLTextAreaElement | null;
            }}
            onKeydown={(e: KeyboardEvent) => onKeyDown(e, p, v, act)}
            onCompositionstart={() => {
              v.composing = true;
            }}
            onCompositionend={(e: CompositionEvent) => {
              v.composing = false;
              const text = e.data ?? v.ta?.value ?? "";
              clearInput(v);
              // Commit ONLY on end -- one block step, never per code unit.
              if (text !== "") act(insertText(buf, text, { kind: "block", time: Date.now() }));
            }}
            onPaste={(e: ClipboardEvent) => {
              e.preventDefault();
              const raw = e.clipboardData?.getData("text/plain") ?? v.ta?.value ?? "";
              clearInput(v);
              const text = raw.replace(/\r\n?/g, "\n");
              if (text !== "") act(insertText(buf, text, { kind: "block", time: Date.now() }));
            }}
            onCopy={() => {
              // Residue cleaner only: the copy is written through copyText,
              // but a stray native copy must not leave the textarea dirty.
              clearInput(v);
            }}
          />
          <div className="editor-window" style={{ top: `${start * EDIT_LINE_H}px` }}>
            {slice.map((line, i) => {
              const n = start + i;
              return (
                <div
                  key={n}
                  className="editor-line"
                  data-line={n + 1}
                  onMousedown={(e: MouseEvent) => {
                    e.preventDefault();
                    v.ta?.focus();
                    const codeEl = (e.currentTarget as unknown as HTMLElement).querySelector(".editor-code");
                    const left = codeEl ? codeEl.getBoundingClientRect().left : v.codeLeft;
                    v.codeLeft = left || v.codeLeft;
                    const pos = hitFromX(e.clientX - left, n);
                    if (e.altKey && e.shiftKey) {
                      // Box drag: anchor = line + VISUAL column (the drag's
                      // x / cell width), then every move rebuilds the whole
                      // box from the anchor (never incremental).
                      v.boxAnchor = { line: n, vcol: Math.max(0, (e.clientX - left) / cw) };
                      v.dragging = true;
                      act(boxSelect(buf, v.boxAnchor, v.boxAnchor));
                      return;
                    }
                    v.boxAnchor = null;
                    if (e.altKey) {
                      // Alt+click: discrete caret add/remove at the CLICK
                      // POINT (the shipped rule -- not VS Code's
                      // selection-end remap). Discrete on purpose: no drag
                      // starts, so the next plain drag still extends the
                      // primary range normally.
                      act(altClickCaret(buf, pos));
                      return;
                    }
                    v.dragging = true;
                    act(e.shiftKey ? extendSelTo(buf, pos) : setCaret(buf, pos));
                  }}
                  onDblclick={(e: MouseEvent) => {
                    e.preventDefault();
                    const codeEl = (e.currentTarget as unknown as HTMLElement).querySelector(".editor-code");
                    const left = codeEl ? codeEl.getBoundingClientRect().left : v.codeLeft;
                    act(selectWordAt(buf, hitFromX(e.clientX - left, n)));
                  }}
                >
                  <span className="file-ln" aria-hidden="true">{n + 1}</span>
                  <code className="editor-code">
                    {selRects(buf, n, cw)}
                    {matchRects(match, n, cw, buf.lines)}
                    {!v.composing && n === head.line ? (
                      <span className="editor-caret" style={{ left: `${caretX}px`, height: `${EDIT_LINE_H}px` }} aria-hidden="true" />
                    ) : null}
                    {codeSpans(runs[i]!, p.showWs, line)}
                    {line === "" ? "\u00a0" : null}
                  </code>
                </div>
              );
            })}
          </div>
        </div>
        {/* One probe measures the shared glyph advance (all editors share the
            face). The ref stores the node so a font-settled re-measure can
            re-read it, and defers the first read to a microtask so a
            measurement that changes the advance repaints through a fresh
            render instead of re-entering the mount/patch already running. The
            test DOM reports no geometry (offsetWidth 0) and the fallback
            holds; document.fonts drives the real-browser re-measure. */}
        <span className="editor-measure" aria-hidden="true" ref={(el) => {
          const node = el as unknown as HTMLElement | null;
          if (!node) return; // unmount: a stale probe reads offsetWidth 0 (a
          // no-op remeasure that keeps the last good advance), so leave it.
          probeNode = node;
          queueMicrotask(() => remeasureCharWidth());
        }}>{Array.from({ length: 100 }, () => "0").join("")}</span>
      </div>
      {/* The foot bar rides the viewer's idiom (the sticky seam is shared). */}
      <div className="file-view-bar editor-bar">
        {p.onLang ? (
          // The syntax chooser: same native select, same choices, same
          // store seam as the viewer, so one override per path drives both
          // shapes.
          <select
            className={
              p.override !== undefined && p.override !== p.guessed
                ? "file-view-lang is-overridden"
                : "file-view-lang"
            }
            aria-label="Syntax highlighting language"
            title={
              p.override !== undefined && p.override !== p.guessed
                ? `Painted as ${langLabel(p.override)}; auto-detected ${langLabel(p.guessed ?? "plain text")} (click to change)`
                : `Painted as ${langLabel(p.guessed ?? "plain text")}, auto-detected (click to change)`
            }
            onChange={(e: Event) => {
              const value = (e.currentTarget as unknown as { value: string }).value;
              p.onLang!(p.path, value === "" ? null : value);
            }}
          >
            <option value="" selected={p.override === undefined}>
              {`Auto (${langLabel(p.guessed ?? "plain text")})`}
            </option>
            <option value="plain" selected={p.override === "plain"}>
              {`Plain text${p.guessed === undefined ? " (auto)" : ""}`}
            </option>
            {fileViewLangChoices().map((l) => (
              <option key={l} value={l} selected={p.override === l}>
                {`${langLabel(l)}${l === p.guessed ? " (auto)" : ""}`}
              </option>
            ))}
          </select>
        ) : null}
        <span className="file-view-status" role="status">
          {`${total} line${total === 1 ? "" : "s"} \u00b7 ${statusText}`}
        </span>
        {v.gotoOpen ? (
          <input
            className="editor-goto-input"
            type="text"
            aria-label="Go to line: N, or N:col (both 1-based)"
            spellcheck="false"
            ref={(el) => {
              // Re-seed on every patch (inline refs detach/attach per
              // render): the onInput mirror makes the seed idempotent, and
              // focus lands the caret in the box (the house isConnected
              // guard -- the ref fires before insertion).
              const node = el as unknown as HTMLInputElement | null;
              v.gotoEl = node;
              if (!node) return;
              node.value = v.gotoText;
              queueMicrotask(() => {
                if ((node as unknown as { isConnected?: boolean }).isConnected !== false) node.focus();
              });
            }}
            onInput={() => {
              v.gotoText = v.gotoEl?.value ?? "";
            }}
            onKeydown={(e: KeyboardEvent) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeGoto(true); // cancel: no jump, editor keeps the keystroke's owner
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                submitGoto();
              }
            }}
            onBlur={() => {
              // Walking away without submitting is a cancel, never a jump.
              if (!v.gotoOpen) return;
              closeGoto(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="file-reload-btn editor-goto-btn"
            title="Caret position (row:col). Click to jump: N keeps the column, N:M sets both."
            aria-label={`Caret at row ${head.line + 1}, column ${head.col + 1}. Jump to line.`}
            onClick={openGoto}
          >
            {`${head.line + 1}:${head.col + 1}`}
          </button>
        )}
        <button
          type="button"
          className={`file-reload-btn editor-ws-btn${p.showWs ? " is-on" : ""}`}
          title="Toggle visible whitespace"
          aria-label="Toggle visible whitespace"
          aria-pressed={p.showWs ? "true" : "false"}
          onClick={() => p.onToggleWs()}
        >
          <IconWhitespace />
        </button>
        <button
          type="button"
          className="file-reload-btn"
          title="Re-read the file from the top"
          aria-label="Reload"
          onClick={() => p.onReload(p.path)}
        >
          <IconReload className="file-reload-glyph" />
        </button>
      </div>
    </div>
  );
}

// ── Selection rects (the overlay layer) ────────────────────────────────────

/** Selection rectangles for one rendered row, painted from EVERY range in
 *  the list (the multicaret node gets its extra carets painted for free;
 *  only the caret itself rides `primary`). */
function selRects(buf: TextBuffer, n: number, cw: number): JsxChild[] {
  const out: JsxChild[] = [];
  for (let i = 0; i < buf.sels.length; i++) {
    const r = buf.sels[i]!;
    const [a, b] = r.anchor.line < r.head.line || (r.anchor.line === r.head.line && r.anchor.col <= r.head.col)
      ? [r.anchor, r.head]
      : [r.head, r.anchor];
    if (n < a.line || n > b.line) continue;
    const lineText = buf.lines[n] ?? "";
    // All px via the shared xForCol -- the same mapping the caret and the
    // hit-test use, so rects, caret and clicks land on identical cells.
    const aLeft = n === a.line ? xForCol(lineText, a.col, cw) : 0;
    if (n === b.line && n === a.line) {
      const w = xForCol(lineText, b.col, cw) - aLeft;
      if (w > 0) out.push(<span key={i} className="editor-sel" style={{ left: `${aLeft}px`, width: `${w}px` }} aria-hidden="true" />);
    } else if (n === b.line) {
      const w = xForCol(lineText, b.col, cw);
      if (w > 0) out.push(<span key={i} className="editor-sel" style={{ left: "0px", width: `${w}px` }} aria-hidden="true" />);
    } else if (n === a.line) {
      // The ANCHOR row of a multi-row range paints from the anchor column,
      // not from 0 -- text left of the anchor is not selected.
      out.push(<span key={i} className="editor-sel" style={{ left: `${aLeft}px`, right: "0px" }} aria-hidden="true" />);
    } else {
      out.push(<span key={i} className="editor-sel" style={{ left: "0px", right: "0px" }} aria-hidden="true" />);
    }
  }
  return out;
}

/** The matched-pair tints for one rendered row (empty when nothing matches;
 *  the mate may live on a different row -- only the row that holds a bracket
 *  of the pair paints one cell). */
function matchRects(
  match: { a: Pos; b: Pos } | undefined,
  n: number,
  cw: number,
  lines: string[],
): JsxChild[] {
  if (!match) return [];
  const out: JsxChild[] = [];
  ([match.a, match.b] as const).forEach((pt, i) => {
    if (pt.line !== n) return;
    out.push(
      <span
        key={`m${i}`}
        className="editor-match"
        data-match-line={n + 1}
        style={{ left: `${xForCol(lines[n] ?? "", pt.col, cw)}px`, width: `${cw}px` }}
        aria-hidden="true"
      />,
    );
  });
  return out;
}

/** shift-drag / shift-click extension (kept here so the buffer module stays
 *  about the model; same rule as editor-buffer.extendPrimary). */
function extendSelTo(buf: TextBuffer, pos: Pos): TextBuffer {
  const cur = buf.sels[buf.primary] ?? buf.sels[0]!;
  const clamped: Pos = {
    line: Math.max(0, Math.min(pos.line, buf.lines.length - 1)),
    col: Math.max(0, Math.min(pos.col, (buf.lines[Math.max(0, Math.min(pos.line, buf.lines.length - 1))] ?? "").length)),
  };
  return { ...buf, sels: buf.sels.map((r, i) => (i === buf.primary ? { anchor: cur.anchor, head: clamped } : r)) };
}

// ── Keyboard ───────────────────────────────────────────────────────────────
// Claimed BEFORE default on the textarea: typing, editing keys, navigation,
// the clipboard chords, undo/redo, and Ctrl/Cmd+S (unclaimed app-wide --
// the only document hotkey is Ctrl+Shift+L, and the editor never touches
// it). Ctrl+V is deliberately NOT claimed: the native paste event carries
// the text. Alt chords pass to the browser; the completion menu and the tab
// strip live on other elements, so nothing here fights them.

function onKeyDown(
  e: KeyboardEvent,
  p: FileEditorProps,
  v: EditorView,
  act: (next: TextBuffer) => void,
): void {
  // The IME owns the event while composing -- no intercept, no clear.
  if (v.composing || (e as KeyboardEvent & { isComposing?: boolean }).isComposing === true || e.key === "Process") return;
  const mod = e.ctrlKey || e.metaKey;
  const buf = p.session.buffer;
  const now = Date.now();
  if (mod && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    e.stopPropagation();
    p.onSave(p.path);
    return;
  }
  if (mod && !e.altKey) {
    const k = typeof e.key === "string" ? e.key.toLowerCase() : "";
    if (k === "z") {
      e.preventDefault();
      act(e.shiftKey ? redo(buf) : undo(buf));
      return;
    }
    if (k === "y") {
      e.preventDefault();
      act(redo(buf));
      return;
    }
    if (k === "a") {
      e.preventDefault();
      act(selectAll(buf));
      return;
    }
    if (k === "c") {
      // Copy writes through the shared copyText seam (same as Ctrl+X). The
      // old stage-the-textarea-and-let-the-native-copy-fire trick was
      // self-defeated: our own onCopy handler cleared the value inside the
      // copy event, before the default action could read it, so nothing
      // reached the clipboard. Empty selection stays inert (Ctrl+X
      // doctrine), and un-prevented.
      const text = stagedCopyText(buf);
      if (text === "") return;
      e.preventDefault();
      void copyText(text);
      return;
    }
    if (k === "x") {
      // A cut is a copy THEN a delete: with nothing selected it is inert
      // (like Ctrl+C), NOT a caret-backspace -- an empty-selection Ctrl+X
      // must not eat the character left of the caret or join lines.
      const text = stagedCopyText(buf);
      if (text === "") return;
      e.preventDefault();
      void copyText(text);
      act(backspaceSmart(buf, now)); // selection delete rides the undo seam
      return;
    }
    if (k === "v") return; // native paste event
    if (e.key === "Home") {
      e.preventDefault();
      act(docStart(buf, e.shiftKey));
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      act(docEnd(buf, e.shiftKey));
      return;
    }
    return;
  }
  // VS Code's add-caret-below/above: Ctrl+Shift+Alt+Arrow OR Alt+Shift+Arrow
  // (both spellings ship -- the macOS/Windows chords differ). Claimed before
  // the plain-arrow collapse so a multi-caret list grows instead of shrinking.
  if (e.altKey && e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    act(addCaretVertical(buf, e.key === "ArrowDown" ? 1 : -1));
    return;
  }
  switch (e.key) {
    case "Backspace":
      e.preventDefault();
      act(backspaceSmart(buf, now));
      return;
    case "Delete":
      e.preventDefault();
      act(deleteForward(buf, now));
      return;
    case "Enter":
      e.preventDefault();
      act(pressEnterSmart(buf, now));
      return;
    case "Tab":
      e.preventDefault();
      act(e.shiftKey ? dedentLines(buf, now) : indentTab(buf, now));
      return;
    case "Escape":
      e.preventDefault();
      act(collapseSelections(buf));
      return;
    case "ArrowLeft":
      e.preventDefault();
      act(moveHorizontal(buf, -1, e.shiftKey));
      return;
    case "ArrowRight":
      e.preventDefault();
      act(moveHorizontal(buf, 1, e.shiftKey));
      return;
    case "ArrowUp":
      e.preventDefault();
      act(moveVertical(buf, -1, e.shiftKey));
      return;
    case "ArrowDown":
      e.preventDefault();
      act(moveVertical(buf, 1, e.shiftKey));
      return;
    case "Home":
      e.preventDefault();
      act(smartHome(buf, e.shiftKey));
      return;
    case "End":
      e.preventDefault();
      act(smartEnd(buf, e.shiftKey));
      return;
    case "PageUp":
      e.preventDefault();
      act(moveVertical(buf, -pageRows(v), e.shiftKey));
      return;
    case "PageDown":
      e.preventDefault();
      act(moveVertical(buf, pageRows(v), e.shiftKey));
      return;
    default:
      if (e.key.length === 1 && !e.altKey && !mod) {
        e.preventDefault();
        // Brace-aware typing (auto-close / skip-over per caret).
        act(typeChar(buf, e.key, now));
      }
  }
}

/** A page is the viewport minus a little overlap, min 1 (arrows step one
 *  line; PageUp/PageDown travel this many). */
function pageRows(v: EditorView): number {
  return Math.max(1, Math.floor((v.viewportH || 30 * EDIT_LINE_H) / EDIT_LINE_H) - 2);
}

/** Clipboard payload: every range's text (joins with \n -- the multicaret
 *  clipboard contract). */
const stagedCopyText = (buf: TextBuffer): string => allSelText(buf);
