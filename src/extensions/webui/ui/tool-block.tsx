/// <reference lib="dom" />
// One mounted tool-call block: a generic interpreter for the declared
// display DSL (ToolDisplayWire, the `display` array on the S2C TOOL_CALL
// frame). Parts render in declaration order -- one element per known spec,
// unknown kinds skipped silently -- and the block falls back to the generic
// posture when nothing known rendered for the result. Nothing here keys off
// tool names: the spec decides the rendering, the name is only a label.
//
// Each block is its own mount tree: message-list appends a host div and
// mounts into it, so high-frequency updates elsewhere in the chat never diff
// tool blocks, and a block only re-renders on its own toggles or when its
// result arrives.

import { mount, type DomNode, type Mounted, type JsxChild } from "@utils/jsx";
import { parseMarkdown, mdTreeToHtml } from "@utils/md-parser.ts";
import { getTokenizer } from "@utils/syntax";
import {
  computeDiffLines,
  addOnlyDiffLines,
  diffStat,
  MAX_DIFF_LINES,
  type DiffLine,
} from "@utils/diff.ts";
import { TOOL_ICONS } from "./icons.tsx";
import { copyText } from "./utils.ts";
import type { ToolDisplayWire } from "@extensions/websocket/protocol.ts";

// One declared display part per spec (kind/source/arg keys): the single
// source stays ToolDisplayWire in @extensions/websocket/protocol.ts (a
// type-only import, erased in the browser bundle).
export type { ToolDisplayWire };

/** Image payload on the wire (see wireImages in @extensions/websocket/protocol.ts). */
export interface ToolImageWire {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
}

export interface ToolResultData {
  output?: string;
  error?: string;
  images?: ToolImageWire[];
  /** 1-based file line the edit's change starts at (the result part's
   *  `start_line` meta, forwarded on the TOOL_RESULT frame). Numbers the
   *  diff gutters with real file lines; absent -> snippet-relative 1..N. */
  startLine?: number;
}

export interface ToolBlockState {
  name: string;
  args: string;
  /**
   * Server-computed title-bar fold: the shared hint fold
   * (ToolMetadata.argDisplay) or, for tools declaring headerKeys, the labeled
   * key fold (summarizeHeaderArgs). Tri-state: undefined = server sent no
   * fold (the local argsSummary heuristic covers older servers); "" =
   * explicit "no summary" -- the declared parts are the story, and the
   * heuristic must NOT step in.
   */
  argsSummary?: string;
  /** Declared display parts (TOOL_CALL frame `display`), rendered in order. */
  display?: ToolDisplayWire[];
  result?: ToolResultData;
  expanded: boolean;
  /** Args shown as the raw wire string instead of pretty-printed JSON. */
  raw: boolean;
  /** Result preview replaced by the full text. */
  fullResult: boolean;
  /** Explicit box overrides (file parts "f<i>", generic "g"); absent means
   *  "fall back to auto-expand" (see AUTO_EXPAND_MAX_LINES). */
  boxes: Record<string, boolean>;
  /** Lists showing everything: diff folds "d<i>", capped files "ff<i>". */
  unfolded: Record<string, boolean>;
}

/** Beyond this many chars the result shows a preview + "show full" button. */
export const RESULT_PREVIEW_CHARS = 2000;
/**
 * Per-side cap on rendered diff lines (huge edits fall back to "…" rows).
 * Re-exported from the shared util (with `computeDiffLines` itself) so the
 * number and the algorithm's own fallback are one constant and can never drift
 * apart; the render path still passes it explicitly, so the block's posture
 * stays visible at its call site.
 */
export { MAX_DIFF_LINES };
/** Inline diff rows before the "expand remaining" button takes over. */
export const MAX_INLINE_DIFF_LINES = 30;
/** Cap on rendered file-part text; past it a "… N more — show full" button shows. */
export const FILE_RENDER_CAP_CHARS = 100_000;
/** Bodies under this many lines auto-open when they arrive (owner ruling
 *  2026-11-05): a small result is not worth a click. Strictly fewer; empty
 *  bodies stay closed, and so does anything past the preview cap -- a
 *  one-line giant is a blob, and a collapsed summary is its lazy face.
 *  A user toggle is always the explicit override in both directions. */
export const AUTO_EXPAND_MAX_LINES = 20;
const underAutoExpand = (text: string): boolean =>
  text !== "" &&
  text.length <= RESULT_PREVIEW_CHARS &&
  text.split("\n").length < AUTO_EXPAND_MAX_LINES;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The path header's two-tone split: the directory portion (separator included,
 * so the strings re-join byte-identical to the arg) and the basename, which
 * carries the emphasis (GitHub's filename reading). Slash-normalized for the
 * cut only -- the returned pieces stay the verbatim arg bytes, because that
 * string is also what the copy button writes.
 */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = path.replace(/\\/g, "/").lastIndexOf("/") + 1;
  const base = path.slice(cut);
  // Trailing separator (a path with no name to emphasize): the whole arg is
  // the primary piece, and there is no muted prefix.
  return base === "" ? { dir: "", base: path } : { dir: path.slice(0, cut), base };
}

/**
 * The path a part DECLARES (its `pathArg`), verbatim from the args -- no
 * resolution, no absolutizing: the args are workspace-relative in practice and
 * that relative string IS what the header shows and the copy button copies.
 * Null when the spec names no pathArg or names one the call did not fill with
 * a non-empty string (the part then renders with no path header).
 */
function declaredPath(args: string, spec: ToolDisplayWire): string | null {
  if (spec.pathArg === undefined) return null;
  const v = parseArgsObject(args)?.[spec.pathArg];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Parsed args object, or null when the wire string is not a JSON object. */
export function parseArgsObject(args: string): Record<string, unknown> | null {
  try {
    const p: unknown = JSON.parse(args);
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    // Not JSON: callers treat the args as unstructured.
  }
  return null;
}

/** "N lines · K chars" -- the house result-size grammar. */
export function textStat(text: string): string {
  const lines = text === "" ? 0 : text.split("\n").length;
  return `${lines} lines · ${text.length} chars`;
}

/**
 * Summary for a file part: `text` is the part's body bytes (the result text
 * for a result-sourced part, the written arg for `source: "args"`). Range
 * form `basename — lines 1–500 of 1234` when offsetArg/limitArg name numeric
 * args; plain size otherwise. Null (skip the part) when pathArg does not name
 * a string.
 */
export function fileSummary(args: string, resultText: string, spec: ToolDisplayWire): string | null {
  const parsed = parseArgsObject(args);
  const path = spec.pathArg !== undefined ? parsed?.[spec.pathArg] : undefined;
  if (typeof path !== "string" || path === "") return null;
  const total = resultText === "" ? 0 : resultText.split("\n").length;
  const num = (key: string | undefined): number | undefined => {
    if (key === undefined) return undefined;
    const v = parsed?.[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : undefined;
  };
  const offset = num(spec.offsetArg);
  const limit = num(spec.limitArg);
  if ((offset === undefined && limit === undefined) || total === 0) {
    return `${basename(path)} — ${textStat(resultText)}`;
  }
  const start = (offset ?? 0) + 1;
  let end = limit !== undefined ? (offset ?? 0) + limit : total;
  if (end > total) end = total;
  if (end < start) end = start;
  return `${basename(path)} — lines ${start}–${end} of ${total}`;
}

/**
 * The header pair for a declared-path part: the path arg VERBATIM and the
 * fileSummary meta with its basename prefix dropped (the path is already the
 * header's left side; saying the name twice is noise). Same skip rule as
 * fileSummary -- no declared path string, no part. `fileSummary` itself stays
 * the centered-summary builder untouched.
 */
function fileHead(args: string, resultText: string, spec: ToolDisplayWire): { path: string; meta: string } | null {
  const summary = fileSummary(args, resultText, spec);
  if (summary === null) return null;
  const path = declaredPath(args, spec);
  if (path === null) return null;
  const prefix = `${basename(path)} — `;
  return { path, meta: summary.startsWith(prefix) ? summary.slice(prefix.length) : summary };
}

/**
 * Fallback header when the server sent no argsSummary: a compact one-liner
 * built from well-known arg keys (path basename, command/pattern text, then
 * any string value). NEVER a raw JSON line.
 */
export function argsSummary(args: string): string {
  const parsed = parseArgsObject(args);
  if (parsed === null) return oneLine(args, 80);

  const str = (k: string): string | null => {
    const v = parsed[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const path = str("path") ?? str("file_path");
  if (path) return basename(path);
  for (const key of ["command", "cmd", "pattern", "query", "url", "skill", "task_id"]) {
    const v = str(key);
    if (v) return oneLine(v, 80);
  }
  for (const v of Object.values(parsed)) {
    if (typeof v === "string" && v.trim()) return oneLine(v, 80);
  }
  const keys = Object.keys(parsed);
  return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "";
}

/** Pretty args for the collapsed body; unparseable strings pass through. */
export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

// The diff algorithm (prefix/suffix trim, two-gutter numbering, per-side cap,
// the all-add rail) lives in the shared zero-dep util @utils/diff.ts, which
// the terminal sink renders from too -- one algorithm, so the browser's gutters
// and the CLI's ANSI block can never disagree about what one edit changed.
// Re-exported here as the module's existing surface. The header renders the
// stat "+N −M"; a zero-del side renders nothing -- the stat never says "−0".
export { computeDiffLines, diffStat, type DiffLine };

/** One styled run of highlighted code; cls null means unstyled text. */
export interface CodeRun {
  cls: string | null;
  text: string;
}

/**
 * Tokenize code through the shared @utils/syntax registry: token runs map
 * to `tok-<type>` CSS classes (default runs stay unstyled), adjacent same-
 * class runs coalesce. Null means "no tokenizer for this lang" -- the caller
 * renders plain text (never a failure: e.g. python has no tokenizer yet).
 */
export function codeRuns(text: string, lang?: string): CodeRun[] | null {
  const tokenizer = lang ? getTokenizer(lang) : undefined;
  if (!tokenizer) return null;
  const out: CodeRun[] = [];
  for (const run of tokenizer(text)) {
    const cls = run.type === "default" ? null : `tok-${run.type}`;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += run.text;
    else out.push({ cls, text: run.text });
  }
  return out;
}

/** Prose bytes through the house sanitizer-backed markdown route. */
export function proseHtml(text: string): string {
  return mdTreeToHtml(parseMarkdown(text));
}

/**
 * Bytes a prose/code part renders, keyed by its source. "pending" means the
 * source waits for a result; null means the part cannot render (skip).
 */
function partBytes(
  spec: ToolDisplayWire,
  state: ToolBlockState,
): string | "pending" | null {
  if (spec.source === "args") {
    const parsed = parseArgsObject(state.args);
    const v = spec.arg !== undefined ? parsed?.[spec.arg] : undefined;
    return typeof v === "string" ? v : null;
  }
  if (spec.source === "error") {
    if (!state.result) return "pending";
    return state.result.error ?? null;
  }
  if (!state.result) return "pending";
  if (state.result.error) return null;
  return state.result.output ?? "";
}

type PartView =
  | { posture: "skip" }
  | { posture: "pending"; icon?: string }
  | { posture: "file"; path: string; meta: string; text: string; envelope?: string }
  | { posture: "diff"; path: string | null; lines: DiffLine[]; envelope?: string }
  | { posture: "prose"; text: string; icon?: string }
  | { posture: "code"; text: string; runs: CodeRun[] | null };

/**
 * Resolve one declared part against the block state. Rules: result/error
 * sources render only once the result arrives; error results never render
 * as file parts; missing/non-string keys skip the part; unknown kinds skip
 * silently (forward-compat). `consumes` (below) tracks whether a rendered
 * part accounted for the result bytes, gating the generic result box.
 * A part follows `source` like the other kinds: result bytes by default, or
 * the written arg at call time (`source: "args"`). An args-sourced file box
 * and an args-sourced all-add diff (append/overwrite) both take the ok
 * result's size envelope as a quiet footer line under their body.
 */
function resolvePart(spec: ToolDisplayWire, state: ToolBlockState): PartView {
  switch (spec.kind) {
    case "file": {
      if (spec.source === "args") {
        const body = spec.arg !== undefined ? parseArgsObject(state.args)?.[spec.arg] : undefined;
        if (typeof body !== "string" || body === "") return { posture: "skip" };
        const head = fileHead(state.args, body, spec);
        if (head === null) return { posture: "skip" };
        // Ok result = the write confirmation envelope: a quiet footer line
        // inside the box, never the face. An error is no envelope at all.
        if (!state.result || state.result.error) return { posture: "file", ...head, text: body };
        return { posture: "file", ...head, text: body, envelope: oneLine(state.result.output ?? "", 80) };
      }
      if (!state.result || state.result.error) return { posture: "skip" };
      const text = state.result.output ?? "";
      const head = fileHead(state.args, text, spec);
      if (head === null) return { posture: "skip" };
      return { posture: "file", ...head, text };
    }
    case "diff": {
      const parsed = parseArgsObject(state.args);
      if (spec.source === "args") {
        // append/overwrite: the written content IS one hunk of adds -- no
        // old side, no diff computation. Skip rules mirror the file args
        // posture (missing/non-string/empty bytes), and an error result
        // skips too: the tinted generic box carries that story.
        const body = spec.arg !== undefined ? parsed?.[spec.arg] : undefined;
        if (typeof body !== "string" || body === "" || state.result?.error) return { posture: "skip" };
        // Line accounting and the add-rail rule come from the shared util
        // (split on \n only, so a \r rides inside the line and a trailing
        // \n yields a final empty add row, the same way the file posture
        // already counts it; a non-positive addStart leaves the rail blank).
        // No cap here: the block bounds this render with its own expand row.
        const { lines } = addOnlyDiffLines(body, spec.addStart);
        // Ok result = the size envelope as a quiet footer under the body
        // (same treatment as the file box); pending has nothing to show.
        const envelope = state.result ? oneLine(state.result.output ?? "", 80) : undefined;
        return { posture: "diff", path: declaredPath(state.args, spec), lines, envelope };
      }
      if (!state.result || state.result.error) return { posture: "skip" };
      const oldV = parsed && spec.oldArg ? parsed[spec.oldArg] : undefined;
      const newV = parsed && spec.newArg ? parsed[spec.newArg] : undefined;
      if (typeof oldV !== "string" || typeof newV !== "string") return { posture: "skip" };
      return {
        posture: "diff",
        path: declaredPath(state.args, spec),
        lines: computeDiffLines(oldV, newV, MAX_DIFF_LINES, state.result.startLine),
      };
    }
    case "prose":
    case "code": {
      const bytes = partBytes(spec, state);
      if (bytes === null) return { posture: "skip" };
      if (bytes === "pending") {
        // Prose waits quietly (icon + name chip); framed parts show nothing.
        return spec.kind === "prose" ? { posture: "pending", icon: spec.icon } : { posture: "skip" };
      }
      if (bytes === "") return { posture: "skip" };
      if (spec.kind === "prose") return { posture: "prose", text: bytes, icon: spec.icon };
      return { posture: "code", text: bytes, runs: codeRuns(bytes, spec.lang) };
    }
    default:
      return { posture: "skip" };
    }
}

/** Did a rendered part account for the result? Gates the generic result box. */
function partConsumesResult(spec: ToolDisplayWire, view: PartView): boolean {
  switch (view.posture) {
    case "file":
      // A result-sourced file part IS the result bytes. An args-sourced one
      // shows the written content instead and takes the ok result into the
      // box's footer meta, so the same text never arrives a second time as a
      // framed box -- but an error result is no envelope: it
      // keeps the generic tinted box.
      return spec.source !== "args" || view.envelope !== undefined;
    case "diff":
      // The result-gated edit diff is the result's story: consumed. An
      // args-sourced all-add part mirrors the file posture -- it takes the
      // ok result into its footer envelope (consumed), and an error result
      // skips the part entirely, so the tinted generic box stays.
      return spec.source !== "args" || view.envelope !== undefined;
    case "prose":
    case "code":
      return spec.source !== "args";
    default:
      return false;
  }
}

function statusOf(state: ToolBlockState): "pending" | "ok" | "error" {
  if (!state.result) return "pending";
  return state.result.error ? "error" : "ok";
}

const STATUS_GLYPH = { pending: "…", ok: "✓", error: "✗" } as const;

/** One thumbnail; click toggles full size. Ref-captured rather than
 * currentTarget-based (currentTarget is null once dispatch completes). */
function Thumb({ img }: { img: ToolImageWire }) {
  let el: HTMLElement | null = null;
  return (
    <img
      className="message-image"
      loading="lazy"
      src={`data:${img.mimeType};base64,${img.data}`}
      ref={(node) => {
        el = node as unknown as HTMLElement | null;
      }}
      onClick={() => el?.classList.toggle("fullsize")}
    />
  );
}

function ImagesView({ images }: { images: ToolImageWire[] }) {
  if (images.length === 0) return null;
  return (
    <div className="message-images">
      {images.map((img, i) =>
        img.skipped || !img.data ? (
          <div key={i} className="image-skipped">
            {img.note || "image not displayed"}
          </div>
        ) : !img.mimeType.startsWith("image/") ? (
          <div key={i} className="image-skipped">
            {`unsupported image type: ${img.mimeType}`}
          </div>
        ) : (
          <Thumb key={i} img={img} />
        ),
      )}
    </div>
  );
}

/** Summary line for the generic result box (rule: sizes collapsed, errors name themselves). */
export function genericResultSummary(result: ToolResultData): string {
  if (result.error) {
    const first = result.error.trim().split("\n")[0] ?? "";
    return `error — ${oneLine(first, 80)}`;
  }
  return `result — ${textStat(result.output ?? "")}`;
}

interface PartProps {
  view: PartView;
  state: ToolBlockState;
  index: number;
  /** Toggle a body; `current` is the EFFECTIVE open state (auto-expand
   *  included), so the first click on an auto-opened body collapses it. */
  onToggleBox: (key: string, current: boolean) => void;
  onUnfold: (key: string) => void;
}

/**
 * Copy-the-path button -- the message footer's copy idiom at header scale. The
 * bytes are the path arg VERBATIM: args are workspace-relative in practice and
 * that relative string is exactly what the owner wants on the clipboard, so
 * there is no resolution here and no server call. The green check rides ONLY a
 * real acknowledged copy (a failed one flashes nothing), and the click stops
 * propagation so a copy under a toggleable header never folds the body.
 */
function CopyPath({ path }: { path: string }): JsxChild {
  let el: HTMLElement | null = null;
  let flash: ReturnType<typeof setTimeout> | null = null;
  return (
    <button
      type="button"
      className="part-copy"
      title="copy path"
      aria-label="copy path"
      ref={(node) => {
        el = node as unknown as HTMLElement | null;
      }}
      onClick={(e: MouseEvent) => {
        e.stopPropagation(); // a copy is not a toggle
        void copyText(path).then((ok) => {
          if (!ok || !el) return; // no fake confirmation: the check rides a real copy
          if (flash) clearTimeout(flash);
          el.classList.add("copied");
          flash = setTimeout(() => {
            el?.classList.remove("copied");
            flash = null;
          }, 1200);
        });
      }}
    >
      {/* Static glyph pair (same 24-viewBox stroke idiom as the footer's copy
          button); CSS swaps them on the .copied state. */}
      <svg
        className="part-copy-icon"
        viewBox="0 0 24 24"
        width="12"
        height="12"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </svg>
      <svg
        className="part-copy-check"
        viewBox="0 0 24 24"
        width="12"
        height="12"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M4 12l5 5L20 6" />
      </svg>
    </button>
  );
}

/**
 * The declared-path header (GitHub's file header, typographic): the verbatim
 * path with its directory portion muted and the basename primary, the copy
 * button immediately right of it, the part's meta far right. NOT a slab -- the
 * block fill stays the only surface, and an open body is separated by a single
 * hairline. `onToggle` is what makes this row the file part's fold (the
 * centered summary used to be); the diff part passes none, because its body is
 * inline primary content and the line fold stays its only fold.
 */
function PartHeader({
  path,
  meta,
  onToggle,
}: {
  path: string;
  meta: JsxChild;
  onToggle?: () => void;
}): JsxChild {
  const { dir, base } = splitPath(path);
  // The fold was a <button>; it is a row now, so the button semantics are
  // restated by hand (role/tabIndex/Enter+Space) rather than regressed.
  const onKey = onToggle
    ? (e: KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space toggles, it never scrolls the row
          onToggle();
        }
      }
    : undefined;
  return (
    <div
      className={onToggle ? "part-head part-head-toggle" : "part-head"}
      role={onToggle ? "button" : undefined}
      tabIndex={onToggle ? 0 : undefined}
      onClick={onToggle}
      onKeyDown={onKey}
    >
      <span className="part-path">
        {dir === "" ? null : <span className="part-path-dir">{dir}</span>}
        <span className="part-path-base">{base}</span>
      </span>
      <CopyPath path={path} />
      <span className="part-meta">{meta}</span>
    </div>
  );
}

/** One declared part as DOM, per the posture resolved above. */
function Part({ view, state, index, onToggleBox, onUnfold }: PartProps): JsxChild {
  switch (view.posture) {
    case "skip":
      return null;
    case "file": {
      const key = `f${index}`;
      const openKey = `ff${index}`;
      const open = state.boxes[key] ?? underAutoExpand(view.text);
      const full = state.unfolded[openKey] === true;
      const capped = !full && view.text.length > FILE_RENDER_CAP_CHARS;
      return (
        <div className="tool-file" key={key}>
          <PartHeader path={view.path} meta={view.meta} onToggle={() => onToggleBox(key, open)} />
          {open ? (
            <>
              <pre className="tool-file-pre">
                {capped ? view.text.slice(0, FILE_RENDER_CAP_CHARS) : view.text}
              </pre>
              {capped ? (
                <button
                  type="button"
                  className="tool-raw-toggle"
                  onClick={() => onUnfold(openKey)}
                >
                  {`… ${view.text.length - FILE_RENDER_CAP_CHARS} more — show full`}
                </button>
              ) : null}
              {view.envelope ? (
                <div className="tool-file-meta">{view.envelope}</div>
              ) : null}
            </>
          ) : null}
        </div>
      );
    }
    case "diff": {
      const key = `d${index}`;
      const folded = view.lines.length > MAX_INLINE_DIFF_LINES;
      const unfolded = state.unfolded[key] === true;
      const shown = folded && !unfolded ? view.lines.slice(0, MAX_INLINE_DIFF_LINES) : view.lines;
      const stat = diffStat(view.lines);
      return (
        <div className="tool-diff" key={key}>
          {view.path === null ? null : (
            <PartHeader
              path={view.path}
              meta={
                <span className="diff-stat">
                  <span className="diff-stat-add">{`+${stat.add}`}</span>
                  {/* A zero side of the stat is noise: the header never
                      says "−0", and on the all-add write posture it would
                      be a lie. */}
                  {stat.del > 0 ? <span className="diff-stat-del">{`−${stat.del}`}</span> : null}
                </span>
              }
            />
          )}
          {shown.map((line, j) => (
            <div key={j} className={`diff-row diff-${line.kind}`}>
              {line.kind === "info" ? (
                // Hunk-info flavor: the cap placeholder talks about the diff,
                // not a line -- no gutters, no sign, full width.
                <span className="diff-text">{line.text}</span>
              ) : (
                <>
                  <span className="diff-ln diff-ln-old">
                    {line.oldNo === undefined ? "" : line.oldNo}
                  </span>
                  <span className="diff-ln diff-ln-new">
                    {line.newNo === undefined ? "" : line.newNo}
                  </span>
                  <span className="diff-sign">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
                  </span>
                  <span className="diff-text">{line.text}</span>
                </>
              )}
            </div>
          ))}
          {folded && !unfolded ? (
            <button
              type="button"
              className="tool-raw-toggle diff-expand"
              onClick={() => onUnfold(key)}
            >
              {`expand remaining ${view.lines.length - MAX_INLINE_DIFF_LINES} lines`}
            </button>
          ) : null}
          {/* Args-sourced writes: the size envelope rides under the body as
              the same quiet mono line the file box footer uses. */}
          {view.envelope ? <div className="tool-file-meta">{view.envelope}</div> : null}
        </div>
      );
    }
    case "prose": {
      // Quiet agent-message row: icon gutter + sanitizer-backed markdown.
      // The inline ref re-runs every render (new closure identity), keeping
      // the md-content div in sync through the house md pipeline only.
      const html = proseHtml(view.text);
      return (
        <div className="tool-prose" key={`p${index}`}>
          {view.icon && TOOL_ICONS[view.icon] ? (
            <span className="tool-prose-icon">{TOOL_ICONS[view.icon]!()}</span>
          ) : null}
          <div
            className="md-content tool-prose-md"
            ref={(el) => {
              if (el) (el as unknown as HTMLElement).innerHTML = html;
            }}
          />
        </div>
      );
    }
    case "pending": {
      return (
        <div className="tool-prose pending" key={`p${index}`}>
          {view.icon && TOOL_ICONS[view.icon] ? (
            <span className="tool-prose-icon">{TOOL_ICONS[view.icon]!()}</span>
          ) : null}
          <span className="tool-prose-chip">{state.name}</span>
        </div>
      );
    }
    case "code":
      return (
        <pre className="tool-code" key={`c${index}`}>
          {view.runs
            ? view.runs.map((run, j) =>
                run.cls === null ? (
                  run.text
                ) : (
                  <span key={j} className={run.cls}>
                    {run.text}
                  </span>
                ),
              )
            : view.text}
        </pre>
      );
    default:
      return null;
  }
}

interface BlockProps {
  state: ToolBlockState;
  onToggle: () => void;
  onToggleRaw: () => void;
  onShowFull: () => void;
  /** Toggle a body; `current` is the EFFECTIVE open state (auto-expand
   *  included), so the first click on an auto-opened body collapses it. */
  onToggleBox: (key: string, current: boolean) => void;
  onUnfold: (key: string) => void;
}

export function ToolBlock({ state, onToggle, onToggleRaw, onShowFull, onToggleBox, onUnfold }: BlockProps) {
  const status = statusOf(state);
  const result = state.result;
  const specs = state.display ?? [];
  const resolved = specs.map((spec) => {
    const view = resolvePart(spec, state);
    return { view, consumes: partConsumesResult(spec, view) };
  });
  const rendered = resolved.filter((r) => r.view.posture !== "skip");
  const consumed = resolved.some((r) => r.consumes && r.view.posture !== "skip");
  // Prose posture: the block reads as an agent message row, not a framed
  // tool box. Framing comes back only if every prose part skipped.
  const prosePosture = rendered.some((r) => r.view.posture === "prose" || r.view.posture === "pending");
  const showGenericBox = result !== undefined && !consumed;
  const resultText = result ? (result.error ? `Error: ${result.error}` : result.output ?? "") : "";
  const truncated = !state.fullResult && resultText.length > RESULT_PREVIEW_CHARS;
  const boxOpen = state.boxes["g"] ?? underAutoExpand(resultText);

  const parts = resolved.map((r, i) => (
    <Part
      key={i}
      view={r.view}
      state={state}
      index={i}
      onToggleBox={onToggleBox}
      onUnfold={onUnfold}
    />
  ));

  const genericBox = showGenericBox ? (
    <div className={"tool-result-box" + (status === "error" ? " tool-result-error" : "")}>
      <button type="button" className="tool-box-summary" onClick={() => onToggleBox("g", boxOpen)}>
        {genericResultSummary(result)}
      </button>
      {boxOpen ? (
        <>
          <pre className="tool-result-pre">
            {truncated
              ? resultText.slice(0, RESULT_PREVIEW_CHARS) +
                `\n\n… ${resultText.length - RESULT_PREVIEW_CHARS} more chars`
              : resultText}
          </pre>
          {truncated ? (
            <button type="button" className="tool-raw-toggle" onClick={onShowFull}>
              show full result
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  ) : null;

  const images = result?.images && result.images.length > 0 ? <ImagesView images={result.images} /> : null;

  if (prosePosture) {
    // Slim raw disclosure so the wire JSON stays reachable under prose.
    return (
      <div className={`tool-call-block posture-prose status-${status}`}>
        {parts}
        {genericBox}
        <div className="tool-prose-raw">
          <button type="button" className="tool-raw-toggle" onClick={onToggle}>
            {state.expanded ? "hide json" : "json"}
          </button>
          {state.expanded ? (
            <>
              <pre className="tool-args">{state.raw ? state.args : prettyArgs(state.args)}</pre>
              <button type="button" className="tool-raw-toggle" onClick={onToggleRaw}>
                {state.raw ? "pretty json" : "raw json"}
              </button>
            </>
          ) : null}
        </div>
        {images}
      </div>
    );
  }

  const header = state.argsSummary ?? argsSummary(state.args);
  // The header is a static row: the summary is the whole story, and the raw
  // args box it used to disclose is gone (prose posture keeps its explicit
  // "json" disclosure; the framed header never needs one).
  return (
    <div className={`tool-call-block status-${status}`}>
      <div className="tool-call-header" title={state.name}>
        <span className="tool-call-name">🛠 {state.name}</span>
        <span className="tool-call-display">{header}</span>
        <span className={`tool-call-status status-${status}`}>{STATUS_GLYPH[status]}</span>
      </div>
      {parts}
      {genericBox}
      {images}
    </div>
  );
}

/**
 * Imperative handle message-list drives: create with the call (including its
 * declared display parts), setResult when the matching result arrives,
 * destroy on clear. All state lives in the handle; the component is pure.
 */
export class ToolBlockController {
  #state: ToolBlockState;
  #mounted: Mounted;

  constructor(
    host: DomNode,
    init: { name: string; args: string; argsSummary?: string; display?: ToolDisplayWire[] },
  ) {
    this.#state = { ...init, expanded: false, raw: false, fullResult: false, boxes: {}, unfolded: {} };
    this.#mounted = mount(this.#el(), host);
  }

  #el() {
    return (
      <ToolBlock
        state={this.#state}
        onToggle={this.#toggle}
        onToggleRaw={this.#toggleRaw}
        onShowFull={this.#showFull}
        onToggleBox={this.#toggleBox}
        onUnfold={this.#unfold}
      />
    );
  }

  #toggle = (): void => {
    this.#state = { ...this.#state, expanded: !this.#state.expanded };
    this.#mounted.render(this.#el());
  };

  #toggleRaw = (): void => {
    this.#state = { ...this.#state, raw: !this.#state.raw };
    this.#mounted.render(this.#el());
  };

  #showFull = (): void => {
    this.#state = { ...this.#state, fullResult: true };
    this.#mounted.render(this.#el());
  };

  #toggleBox = (key: string, current: boolean): void => {
    this.#state = {
      ...this.#state,
      boxes: { ...this.#state.boxes, [key]: !current },
    };
    this.#mounted.render(this.#el());
  };

  #unfold = (key: string): void => {
    this.#state = { ...this.#state, unfolded: { ...this.#state.unfolded, [key]: true } };
    this.#mounted.render(this.#el());
  };

  setResult(result: ToolResultData): void {
    // Error results open the generic result box by default: it is the only
    // thing the user needs to see, tinted, naming itself on one line.
    const boxes = result.error
      ? { ...this.#state.boxes, g: true }
      : this.#state.boxes;
    this.#state = { ...this.#state, result, boxes };
    this.#mounted.render(this.#el());
  }

  get hasResult(): boolean {
    return this.#state.result !== undefined;
  }

  destroy(): void {
    this.#mounted.unmount();
  }
}
