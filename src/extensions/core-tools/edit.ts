import fs from "node:fs/promises";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { PathEscapeError } from "../../utils/workspace.ts";
import type { Workspace } from "../../utils/workspace.ts";
import { AssistantRetryableError } from "../../core/error.ts";
import { ToolContext } from "../../core/extensions/types.ts";

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
      "Replaces exact occurrences of oldString with newString in existing file. Fails with an error if oldString matches nothing. Read the file before editing -- whitespace and indentation must match.",
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

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (op: Record<string, unknown>) => {
      if (!op || !op.path) {
        return typeof input === "string" ? input : "";
      }
      const oldPreview = truncateString((op.oldString as string) || "", 40);
      const newPreview = truncateString((op.newString as string) || "", 40);
      return `${op.path}: '${oldPreview}' → '${newPreview}'`;
    });
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
      return ToolResult.err(`File not found or unreadable '${filePath}': ${(e as Error).message}`);
    }

    const result = findAndReplace(sourceContent, oldString, newString, replaceAll || false);
    if (result.error) {
      return ToolResult.err(`Edit failed: ${result.error}`);
    }

    const { newContent, matchInfo } = result;

    try {
      await fs.writeFile(resolvedPath, newContent!, "utf-8");
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

function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
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

    const matchPos = content.indexOf(old);
    const startLine = content.slice(0, matchPos).split("\n").length;
    const endLine = startLine + old.split("\n").length - 1;
    const matchCount = all ? content.split(old).length - 1 : 1;
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

  let startLineIdx = -1;
  for (let i = 0; i + oldTrimmed.length <= contentLines.length && startLineIdx === -1; i++) {
    let matches = true;
    for (let j = 0; j < oldTrimmed.length; j++) {
      if (contentLines[i + j]!.trim() !== oldTrimmed[j]) {
        matches = false;
        break;
      }
    }
    if (matches) startLineIdx = i;
  }

  if (startLineIdx === -1) {
    const near = closestMatches(content, old);
    let detail: string;
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

// ── Nearest-match suggestions ──────────────────────────────────────────────
//
// When oldString misses (even after the trimmed-line fallback), the model is
// stranded: a head/tail preview of a large file rarely contains the target.
// Report the closest actual lines so the corrected edit needs no read
// round-trip. Anchors on the first non-blank line of oldString — intra-line
// drift (typos, renames, reformatting) is what the trimmed fallback can't
// recover; reordered multi-line blocks won't suggest well, but they don't
// match either, so behavior is no worse.

interface ClosestMatch {
  line: number; // 1-based
  text: string;
  distance: number;
}

const CLOSEST_MATCH_MAX_FILE_CHARS = 2 * 1024 * 1024;
const CLOSEST_MATCH_CANDIDATE_CAP = 200;
const CLOSEST_MATCH_LIMIT = 3;

function closestMatches(content: string, old: string): ClosestMatch[] {
  if (content.length > CLOSEST_MATCH_MAX_FILE_CHARS) return [];

  const anchor = old
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!anchor) return [];

  // Prefilter on the anchor's longest tokens keeps the scan O(lines)
  // substring checks per attempt; the longest token is the most distinctive
  // but may itself be the typo, so try up to 3 (longest first) until one
  // yields candidates.
  const tokens = Array.from(
    new Set(anchor.split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 4)),
  )
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  if (tokens.length === 0) return [];

  const threshold = Math.max(2, Math.floor(anchor.length * 0.4));
  const lines = content.split("\n");
  const scored: ClosestMatch[] = [];

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
      if (distance <= threshold) {
        scored.push({ line: i + 1, text: line, distance });
      }
    }
    if (scored.length > 0) break;
  }

  scored.sort((a, b) => a.distance - b.distance || a.line - b.line);
  return scored.slice(0, CLOSEST_MATCH_LIMIT);
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
