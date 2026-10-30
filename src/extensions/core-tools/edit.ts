import fs from "node:fs/promises";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { PathEscapeError } from "@utils/workspace.ts";
import type { Workspace } from "@utils/workspace.ts";
import { AssistantRetryableError } from "@core/error.ts";
import { ToolContext } from "@core/extensions/types.ts";
import { detectFileStyle, stripFileStyle, applyFileStyle } from "@utils/file-utils.ts";

interface EditToolOptions {
  maxEditInputSize: number;
}

interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replace_all: boolean;
}

interface MatchInfo {
  startLine: number;
  endLine: number;
  matchCount: number;
}

interface FindReplaceResult {
  newContent?: string;
  matchInfo?: MatchInfo;
  error?: string;
}

export class EditTool {
  static readonly TOOL_NAME = "edit";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  private readonly maxEditInputSize: number;

  constructor(options: EditToolOptions) {
    this.maxEditInputSize = options.maxEditInputSize;
  }

  toToolDef() {
    return toolDef(
      EditTool.TOOL_NAME,
      "Replaces exact occurrences of oldString with newString in existing file. Fails with an error if oldString matches nothing. When replace_all is false, oldString must match exactly once; multiple matches fail with an error listing the matched line numbers. Read the file before editing -- whitespace and indentation must match.",
      {
        properties: {
          path: param("string", "File path. Path relative to the workspace root, or an absolute path inside a configured workspace root."),
          oldString: param("string", "Exact text to find and replace."),
          newString: param("string", "Replacement text."),
          replace_all: param("boolean", "Replace all occurrences. Defaults false.", {
            default: false,
          }),
        },
        required: ["path", "oldString", "newString"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const op = parseArgs(input);
    if (!op) {
      return ToolResult.err(
        "Error parsing arguments: expected a JSON object with required 'path', 'oldString', and 'newString' strings (optional: replace_all)",
      );
    }

    const { path: filePath, oldString, newString, replace_all: replaceAll = false } = op;
    const workspace = ctx.get("workspace") as Workspace;

    let resolvedPath: string;
    try {
      resolvedPath = workspace.resolveSafe(filePath);
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        return ToolResult.err(e.message);
      }
      return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
    }

    const inputSize = oldString.length + newString.length;
    if (inputSize > this.maxEditInputSize) {
      throw AssistantRetryableError.WithHint(
        `Edit input too large: ${inputSize} characters (max ${this.maxEditInputSize}).`,
        "Split this edit into multiple smaller edits, each targeting a specific section of the file.",
      );
    }

    let sourceContent: string;
    try {
      sourceContent = await fs.readFile(resolvedPath, "utf-8");
    } catch (e: unknown) {
      // A missing file is a model mistake: return (don't throw) with a
      // structured hint so the model can self-correct, mirroring the
      // thrown AssistantRetryableError path.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return ToolResult.err(`File not found: ${filePath}`).withHint(
          "Check the path is correct. Use the find tool to locate the file, or read the containing directory to list its contents.",
        );
      }
      return ToolResult.err(`Failed to read file '${filePath}': ${(e as Error).message}`);
    }

    // Match in LF/BOM-free space, re-apply the file's real style on write:
    // a CRLF file edited with LF oldString/newString (what every reader and
    // the model speak) must stay CRLF, and a BOM must survive its first line
    // being replaced.
    const style = detectFileStyle(sourceContent);
    const content = stripFileStyle(sourceContent);
    const result = findAndReplace(
      content,
      stripFileStyle(oldString),
      stripFileStyle(newString),
      replaceAll || false,
    );
    if (result.error) {
      return ToolResult.err(`Edit failed: ${result.error}`);
    }

    const { newContent, matchInfo } = result;

    try {
      await fs.writeFile(resolvedPath, applyFileStyle(newContent!, style), "utf-8");
    } catch (e: unknown) {
      return ToolResult.err(`Error writing file: ${(e as Error).message}`);
    }

    const matchCount = matchInfo!.matchCount;
    const isDelete = newString === "";
    const deletedLines = oldString.split("\n").length;
    const replacedLines = isDelete ? 0 : newString.split("\n").length;
    const action = isDelete
      ? `deleted ${deletedLines} line${deletedLines > 1 ? "s" : ""}`
      : `replaced with ${replacedLines} line${replacedLines !== 1 ? "s" : ""}`;
    return ToolResult.ok(
      `Successfully edited '${filePath}', found ${matchCount} match${matchCount > 1 ? "es" : ""}, ${action}`,
    ).withEntries({
      path: filePath,
      match_count: String(matchCount),
      lines_replaced: String(replacedLines),
      start_line: String(matchInfo!.startLine),
      end_line: String(matchInfo!.endLine),
    });
  }
}

function parseArgs(input: string | Record<string, unknown> | null): EditArgs | null {
  const json = parseToolInput(input);
  if (!json) return null;

  const path = json.path;
  const oldString = json.oldString ?? json.old_string;
  const newString = json.newString ?? json.new_string;

  if (typeof path !== "string" || !path) {
    return null;
  }
  // Presence check, not non-empty: "" oldString is rejected later with a
  // specific message, while "" newString is a valid deletion signal.
  if (typeof newString !== "string" || typeof oldString !== "string") {
    return null;
  }

  return {
    path,
    oldString,
    newString,
    replace_all: Boolean(json.replace_all),
  };
}


function findAndReplace(content: string, old: string, newStr: string, all: boolean): FindReplaceResult {
  if (old.length === 0) {
    return { error: "oldString must not be empty" };
  }

  if (content.includes(old)) {
    if (old === newStr) {
      return {
        error: "no changes to apply — oldString and newString are identical",
      };
    }

    // Single pass over the content: every non-overlapping match's 1-based
    // start line. Without replace_all, more than one match is ambiguous --
    // silently editing the first one is a wrong-file-edit class of bug.
    const matchLines = matchLineNumbers(content, old);
    if (!all && matchLines.length > 1) {
      return { error: ambiguousEditError(matchLines) };
    }

    const startLine = matchLines[0]!;
    const endLine = startLine + old.split("\n").length - 1;
    const matchCount = matchLines.length;
    // Empty oldString is rejected above, so split() always has a non-empty
    // pattern and replace_all deletion cannot degenerate into an empty match.
    const newContent = all ? content.split(old).join(newStr) : content.replace(old, () => newStr);

    return {
      newContent,
      matchInfo: { startLine, endLine, matchCount },
    };
  }

  // Strategy 2: line-trimmed fallback.
  // Match at the LINE level: compare trimmed lines one-by-one so that
  // differing indentation still matches, but the splice indices stay in
  // the original line array's coordinate space (character offsets in a
  // whitespace-normalized string do NOT map back to line boundaries).
  const oldLines = old.split("\n");
  // Empty replacement signals deletion: drop the matched lines entirely
  // instead of splicing in a blank line.
  const newLines = newStr === "" ? [] : newStr.split("\n");
  const oldTrimmed = oldLines.map((l: string) => l.trim());
  const contentLines = content.split("\n");

  // Collect non-overlapping trimmed-line matches. Without replace_all, a
  // second match is as ambiguous as on the exact path; replace_all keeps the
  // historical fallback behavior of editing only the first window.
  const matchStarts: number[] = [];
  for (let i = 0; i + oldTrimmed.length <= contentLines.length; i++) {
    let matches = true;
    for (let j = 0; j < oldTrimmed.length; j++) {
      if (contentLines[i + j]!.trim() !== oldTrimmed[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchStarts.push(i);
      if (all) break;
      i += oldTrimmed.length - 1;
    }
  }

  if (!all && matchStarts.length > 1) {
    return { error: ambiguousEditError(matchStarts.map((i) => i + 1)) };
  }

  const startLineIdx = matchStarts[0] ?? -1;

  if (startLineIdx === -1) {
    // Same size ceiling as closestMatches: past 2 MB, suggestion work stops
    // paying for itself and the preview stands.
    const region =
      content.length <= CLOSEST_MATCH_MAX_FILE_CHARS
        ? nearestRegion(contentLines, oldTrimmed)
        : null;
    let detail: string;
    if (region) {
      detail = region.ranOffFile
        ? `Nearest region: lines ${region.fileStart}-${region.fileEnd}; the file ends at line ${region.fileEnd}.\n` +
          `oldString line ${region.diffOldLine} has no counterpart in the file: ${JSON.stringify(region.oldText)}`
        : `Nearest region: lines ${region.fileStart}-${region.fileEnd}; first difference at file line ${region.diffFileLine} (oldString line ${region.diffOldLine}):\n` +
          `  file:      ${JSON.stringify(region.fileText)}\n` +
          `  oldString: ${JSON.stringify(region.oldText)}\n` +
          (region.allOthersMatch
            ? "All other in-file lines of the region match modulo indentation."
            : "More differences follow after this line.");
    } else {
      const near = closestMatches(content, old);
      if (near.length > 0) {
        detail =
          "Closest matches (1-based line numbers; copy the exact text):\n" +
          near
            .map(
              (m) =>
                `  line ${m.line} (differs by ${m.distance} char${m.distance !== 1 ? "s" : ""}):\n    ${m.text}`,
            )
            .join("\n");
      } else {
        const contextLines =
          contentLines.length <= 10
            ? contentLines
            : [...contentLines.slice(0, 3), "...", ...contentLines.slice(Math.max(0, contentLines.length - 4))];
        detail = `File content:\n${contextLines.join("\n")}`;
      }
    }
    throw AssistantRetryableError.WithHint(
      `text not found in file.\n\nSearched for: ${JSON.stringify(old)}\n\n${detail}`,
      "Use the exact text from the file, including correct indentation. You can use the read tool to get the current file contents if needed.",
    );
  }

  // Fix only the first line's indentation to match the file; the rest is
  // left as-is (if it's wrong, a code formatter will sort it out).
  const origFirstIndent = contentLines[startLineIdx]!.match(/^\s*/)?.[0] ?? "";
  const adjustedNewLines = [...newLines];
  if (adjustedNewLines.length > 0 && adjustedNewLines[0]!.trim().length > 0) {
    adjustedNewLines[0] = origFirstIndent + adjustedNewLines[0]!.trimStart();
  }

  const resultLines = [
    ...contentLines.slice(0, startLineIdx),
    ...adjustedNewLines,
    ...contentLines.slice(startLineIdx + oldTrimmed.length),
  ];
  const newContent = resultLines.join("\n");
  const startLine = startLineIdx + 1;
  // Degenerate to startLine when deleting (zero-length replacement).
  const endLine = Math.max(startLine, startLineIdx + adjustedNewLines.length);

  return {
    newContent,
    matchInfo: { startLine, endLine, matchCount: 1 },
  };
}

// 1-based start line of every non-overlapping occurrence of `old` in
// `content`. One pass: each character is scanned for newlines at most once,
// including the interior of previous matches (a multi-line oldString's own
// newlines advance the line counter for later matches).
function matchLineNumbers(content: string, old: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let scanned = 0;
  for (let pos = content.indexOf(old); pos !== -1; pos = content.indexOf(old, pos + old.length)) {
    for (let i = scanned; i < pos; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    scanned = pos;
    lines.push(line);
  }
  return lines;
}

// Caps report bloat when a short oldString hits hundreds of times; the
// count above is always exact, only the line list is truncated.
const AMBIGUOUS_MATCH_LINE_LIMIT = 10;

function ambiguousEditError(matchLines: number[]): string {
  const shown = matchLines.slice(0, AMBIGUOUS_MATCH_LINE_LIMIT);
  const more = matchLines.length - shown.length;
  const where = `lines ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
  return (
    `oldString matched ${matchLines.length} times (at ${where}) and replace_all is false. ` +
    "Refusing to guess which occurrence to edit: add more surrounding context so oldString matches exactly once, or set replace_all=true to replace every occurrence."
  );
}

// ── Miss recovery: nearest region, then nearest lines ─────────────────────
//
// When oldString misses (even after the trimmed-line fallback), the model is
// stranded: a head/tail preview of a large file rarely contains the target.
// Report where the miss actually is so the corrected edit needs no read
// round-trip. Two shapes:
// - nearestRegion: a block that still aligns with the file but drifted inside
//   (the stale-context case -- an earlier edit renamed one interior line).
//   Windowing the file on an anchor-like line and reporting the first
//   divergence points at the exact line to fix; one retry, no re-read.
// - closestMatches: single lines near oldString's first non-blank line.
//   Intra-line drift (typos, renames) is what the trimmed fallback can't
//   recover; reordered multi-line blocks won't suggest well, but they don't
//   match either, so behavior is no worse.

interface ClosestMatch {
  line: number; // 1-based
  text: string;
  distance: number;
}

const CLOSEST_MATCH_MAX_FILE_CHARS = 2 * 1024 * 1024;
const CLOSEST_MATCH_CANDIDATE_CAP = 200;
const CLOSEST_MATCH_LIMIT = 3;

/** A file line whose trimmed text lies within the anchor's distance threshold. */
interface AnchorCandidate {
  idx: number; // 0-based
  distance: number;
}

/**
 * File lines whose trimmed text is within edit distance of `anchor`, sorted
 * best first. Prefilter on the anchor's longest tokens keeps the scan
 * O(lines) substring checks per attempt; the longest token is the most
 * distinctive but may itself be the typo, so try up to 3 (longest first)
 * until one yields candidates. Shared by both miss reports so they can never
 * disagree on what "anchor-like" means. Capped, not display-limited: the
 * region scan needs the pool, the line list takes the top few.
 */
function anchorCandidates(lines: string[], anchor: string): AnchorCandidate[] {
  const tokens = Array.from(
    new Set(anchor.split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 4)),
  )
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (tokens.length === 0) return [];

  const threshold = Math.max(2, Math.floor(anchor.length * 0.4));
  const scored: AnchorCandidate[] = [];
  for (const needle of tokens) {
    let candidates = 0;
    for (let i = 0; i < lines.length && candidates < CLOSEST_MATCH_CANDIDATE_CAP; i++) {
      const line = lines[i]!;
      if (!line.includes(needle)) continue;
      candidates++;
      const trimmed = line.trim();
      // Length-difference lower bound: skips pathological long lines
      // (minified bundles) before the quadratic distance computation.
      if (Math.abs(trimmed.length - anchor.length) > threshold) continue;
      const distance = editDistance(trimmed, anchor);
      if (distance <= threshold) scored.push({ idx: i, distance });
    }
    if (scored.length > 0) break;
  }
  scored.sort((a, b) => a.distance - b.distance || a.idx - b.idx);
  return scored;
}

function closestMatches(content: string, old: string): ClosestMatch[] {
  if (content.length > CLOSEST_MATCH_MAX_FILE_CHARS) return [];
  const anchor = old
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!anchor) return [];
  const lines = content.split("\n");
  return anchorCandidates(lines, anchor)
    .slice(0, CLOSEST_MATCH_LIMIT)
    .map((m) => ({ line: m.idx + 1, text: lines[m.idx]!, distance: m.distance }));
}

interface NearestRegion {
  fileStart: number; // 1-based, inclusive
  fileEnd: number; // 1-based, inclusive; clamped to the file's last line
  diffFileLine: number | null; // 1-based; null when the divergence is EOF
  diffOldLine: number; // 1-based within oldString
  fileText: string | null; // trimmed -- copy it verbatim and the trimmed fallback matches
  oldText: string; // trimmed
  ranOffFile: boolean;
  allOthersMatch: boolean;
}

/**
 * Localize a multi-line miss. Windows the file at each anchor-like line --
 * aligning the anchor's offset inside oldString, so leading blank lines
 * don't shift the window -- and counts trimmed-equal lines from the anchor
 * on; the best window is the region, its first trimmed mismatch the line
 * the model must fix. The region starts AT the anchor: leading blank lines
 * carry no signal and reporting against them would point the model at
 * unrelated file lines. Requires at least two agreeing lines -- one line of
 * agreement is the closest-line list's job, and a coincidental window would
 * only mislead. Ties go to the better anchor candidate, then the earliest
 * window, so duplicated blocks report deterministically.
 */
function nearestRegion(lines: string[], oldTrimmed: string[]): NearestRegion | null {
  const anchorIdx = oldTrimmed.findIndex((l) => l.length > 0);
  if (anchorIdx === -1 || oldTrimmed.length < 2 || lines.length === 0) return null;

  let best: { start: number; equal: number } | null = null;
  for (const cand of anchorCandidates(lines, oldTrimmed[anchorIdx]!)) {
    if (cand.idx < anchorIdx) continue; // block head would hang above line 1
    const start = cand.idx - anchorIdx;
    let equal = 0;
    for (let j = anchorIdx; j < oldTrimmed.length; j++) {
      const fl = lines[start + j];
      if (fl !== undefined && fl.trim() === oldTrimmed[j]) equal++;
    }
    if (equal >= 2 && (best === null || equal > best.equal)) {
      best = { start, equal };
    }
  }
  if (!best) return null;

  const { start, equal } = best;
  const contentStart = start + anchorIdx;
  const compared = Math.min(oldTrimmed.length - anchorIdx, lines.length - contentStart);
  let diff = -1;
  for (let j = anchorIdx; j < oldTrimmed.length; j++) {
    const fl = lines[start + j];
    if (fl === undefined || fl.trim() !== oldTrimmed[j]) {
      diff = j;
      break;
    }
  }
  // Every line agreed: strategy 2 would have edited this window already, so
  // there is nothing to report. Belt-and-suspenders -- unreachable.
  if (diff === -1) return null;

  const fileLine = lines[start + diff];
  const ranOffFile = fileLine === undefined;
  return {
    fileStart: contentStart + 1,
    fileEnd: contentStart + compared,
    diffFileLine: ranOffFile ? null : start + diff + 1,
    diffOldLine: diff + 1,
    fileText: ranOffFile ? null : fileLine!.trim(),
    oldText: oldTrimmed[diff]!,
    ranOffFile,
    // ranOffFile: every in-file line agreed (the mismatch is past EOF).
    allOthersMatch: ranOffFile ? true : equal === compared - 1,
  };
}

/** Levenshtein distance, two-row DP. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}
