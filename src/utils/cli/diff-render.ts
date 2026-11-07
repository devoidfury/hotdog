// The terminal's rendering of a declared `kind: "diff"` display part
// (ToolDisplaySpec, resolved server-side from the tool's metadata and handed
// to the sink through its `display` seam -- the same posture the webui reads
// off the wire). Nothing here keys off tool names: the declaration decides.
//
// Two consumers, one grammar:
//   - CliOutputSink paints the RESULT of a declared-diff call with the
//     palette, bounded to CLI_MAX_DIFF_LINES rows per side (scrollback is
//     write-once: a huge edit must not bury the transcript behind it).
//   - The user-gate approval prompt renders the SAME block plain (no palette),
//     so what the human approves is the change they can read. Plain is not a
//     shortcut: the prompt rides the question seam and may surface in a
//     non-terminal UI, where ANSI bytes would be garbage.
//
// Every model-authored byte -- path header and row text alike -- is
// spoof-neutralized BEFORE any ANSI is composed (ESC is itself a neutralized
// code point, so styling first would shred the escape).

import {
  addOnlyDiffLines,
  computeDiffLines,
  diffStat,
  type DiffLine,
} from "@utils/diff.ts";
import { spoofSafe } from "@utils/spoof.ts";
import type { ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import { applyColor, type ColorPalette } from "./colors.ts";

/**
 * Rows rendered per side (adds and dels separately) before the elision
 * summary -- the write-once-scrollback sibling of the webui's MAX_DIFF_LINES
 * (300 rows per side, which it can afford because it folds the rest behind an
 * expand button). At most header + 2*this + 2 context rows + one elision line
 * land in the transcript per call.
 */
export const CLI_MAX_DIFF_LINES = 20;

/**
 * Runes of ONE row's text before an inline `… +N chars` tail marks the cut.
 * The line count alone is not a bound: one minified line of a 200 KB file would
 * otherwise commit 200 KB of scrollback where the folded args preview used to
 * print 80 runes. Long lines wrap in the terminal anyway; the row stays
 * reviewable, the rest is what `read` is for.
 */
export const CLI_MAX_DIFF_ROW_RUNES = 400;

/** Runes of the declared path in the header line (the gate bounds its target echo at 200). */
export const CLI_MAX_DIFF_PATH_RUNES = 200;

/**
 * Rune-cap one model-authored cell, mark what fell off, then neutralize. Cap
 * BEFORE spoofing so a cut can never split a `[U+XXXX]` token in half.
 */
function capCell(text: string, max: number): string {
  const runes = Array.from(text);
  if (runes.length <= max) return spoofSafe(text);
  return spoofSafe(runes.slice(0, max).join("")) + ` \u2026 +${runes.length - max} chars`;
}

/** A resolved, capped diff block, ready to render. */
export interface CliDiffView {
  /** The declared `pathArg` value (full, as the model sent it); null when the
   * part declares no path key. */
  path: string | null;
  lines: DiffLine[];
  /** Changed lines the cap dropped, both sides together. */
  elided: number;
}

export interface CliDiffResolveOptions {
  /** The call's result says it failed: a write that did not happen has no
   * diff to show, and the generic result posture carries that story. */
  failed?: boolean;
  /** edit's `start_line` result meta: the file line the snippet starts at, so
   * the gutter numbers the file rather than the snippet. Anything that is not
   * a positive integer (no result yet, an old result) leaves snippet numbering. */
  startLine?: number | null;
  /** Cap override; sinks use CLI_MAX_DIFF_LINES. */
  maxLines?: number;
}

/** The args object of a call, or null when it is not a JSON object. */
function parseArgs(input: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function declaredPath(parsed: Record<string, unknown>, spec: ToolDisplaySpec): string | null {
  const v = spec.pathArg !== undefined ? parsed[spec.pathArg] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The FIRST renderable kind:"diff" part of a call's declaration, resolved
 * against its args -- or null, meaning "no diff posture, use the generic
 * result rendering" (unknown kinds and undeclared tools land here, and so
 * does every skip rule below). Later parts are not rendered: one diff block
 * per committed result row keeps the scrollback bounded, and no tool declares
 * a second.
 *
 * Sources follow the spec: `source: "args"` (append/overwrite) renders the
 * written string as pure adds -- there is no old side to pair against, and the
 * tool's own result is a size envelope, not content. The default source
 * (edit) pairs `oldArg`/`newArg` through the shared diff algorithm. A part
 * whose bytes are missing, non-string or empty skips, so the generic posture
 * covers it, and so does a replace that changed nothing (an empty diff would
 * say less than the result text does).
 */
export function resolveCliDiff(
  display: ToolDisplaySpec[] | undefined,
  args: string,
  opts: CliDiffResolveOptions = {},
): CliDiffView | null {
  // Cheapest tests first: no declaration (or a failed call) must not pay for
  // parsing what is often a large args JSON (bash commands, write bodies).
  if (!display || opts.failed) return null;
  if (!display.some((spec) => spec.kind === "diff")) return null;
  const parsed = parseArgs(args);
  if (!parsed) return null;
  const maxLines = opts.maxLines ?? CLI_MAX_DIFF_LINES;
  for (const spec of display) {
    if (spec.kind !== "diff") continue;
    const path = declaredPath(parsed, spec);
    if (spec.source === "args") {
      const body = spec.arg !== undefined ? parsed[spec.arg] : undefined;
      if (typeof body !== "string" || body === "") continue;
      const { lines, elided } = addOnlyDiffLines(body, spec.addStart, maxLines);
      return { path, lines, elided };
    }
    const oldV = spec.oldArg !== undefined ? parsed[spec.oldArg] : undefined;
    const newV = spec.newArg !== undefined ? parsed[spec.newArg] : undefined;
    if (typeof oldV !== "string" || typeof newV !== "string") continue;
    const startLine =
      typeof opts.startLine === "number" && Number.isInteger(opts.startLine) && opts.startLine > 0
        ? opts.startLine
        : undefined;
    const lines = computeDiffLines(oldV, newV, maxLines, startLine);
    const stat = diffStat(lines);
    if (stat.add === 0 && stat.del === 0) continue;
    return {
      path,
      lines,
      elided: lines.reduce((n, l) => n + (l.elided ?? 0), 0),
    };
  }
  return null;
}

export interface CliDiffRenderOptions {
  /** Paint rows through the palette. Absent (or a colors-off palette) renders
   * plain text: what the approval prompt must be, since its question may be
   * presented by a UI that has no terminal. */
  palette?: ColorPalette;
  /** Prefix on every row -- the approval prompt indents under its question. */
  indent?: string;
  /** Lead words on the header line: the gate passes "will change", so the
   * block reads as a proposal before the call runs. */
  label?: string;
}

const ROW_SIGN: Record<"ctx" | "add" | "del", string> = { ctx: " ", add: "+", del: "-" };

/**
 * The diff block as committed text: a `path +A −D` header, the rows (sign and
 * a shared line-number gutter when the diff has numbers at all), then one
 * elision line naming what the cap dropped. Row text is spoof-neutralized;
 * the stat, signs and gutter are harness-authored and ride through as-is.
 *
 * Every row that can carry a color closes its own SGR, because the sink's
 * mode color wraps the whole block and a row's RESET would otherwise strand
 * the lines after it.
 */
export function renderCliDiff(view: CliDiffView, opts: CliDiffRenderOptions = {}): string {
  const palette = opts.palette;
  const paint = (text: string, color: string): string =>
    palette ? applyColor(text, color, palette.use_colors) : text;
  const indent = opts.indent ?? "";
  const stat = diffStat(view.lines);
  // A number gutter only exists when every row has a number to fill it: a
  // pure-insertion rail with no declared addStart has none at all, and half a
  // gutter is worse than none.
  const numbers = view.lines
    .filter((l) => l.kind !== "info")
    .map((l) => (l.kind === "del" ? l.oldNo : l.newNo));
  const gutter = numbers.every((n) => typeof n === "number")
    ? Math.max(4, ...numbers.map((n) => String(n).length))
    : 0;

  const out: string[] = [];
  // The header's model-authored piece is the path; label and stat are ours.
  // The stat counts the SHOWN rows -- with a cap it is not the whole change,
  // and the elision line carries the remainder.
  const parts = [
    opts.label,
    view.path !== null ? capCell(view.path, CLI_MAX_DIFF_PATH_RUNES) : undefined,
    `+${stat.add}${stat.del > 0 ? ` \u2212${stat.del}` : ""}`,
  ];
  out.push(indent + paint(parts.filter(Boolean).join(" "), palette?.diff_meta ?? ""));
  for (const line of view.lines) {
    if (line.kind === "info") continue; // folded into the single elision line below
    const no = line.kind === "del" ? line.oldNo : line.newNo;
    const row =
      indent +
      ROW_SIGN[line.kind] +
      (gutter > 0 && typeof no === "number" ? no.toString().padStart(gutter) : "") +
      " " +
      capCell(line.text, CLI_MAX_DIFF_ROW_RUNES);
    const color =
      line.kind === "add" ? palette?.diff_add : line.kind === "del" ? palette?.diff_del : palette?.diff_ctx;
    out.push(paint(row, color ?? ""));
  }
  if (view.elided > 0) {
    const summary = `${indent}  \u2026 ${view.elided} more changed line${view.elided === 1 ? "" : "s"}`;
    out.push(paint(summary, palette?.diff_meta ?? ""));
  }
  return out.join("\n");
}
