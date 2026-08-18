// Edit tool — replace text in a file.

import fs from "node:fs/promises";
import path from "node:path";
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
      "Single mode tool that replaces text in a file. Finds oldString, replaces with newString. Use this instead of the write tool for precise code edits.",
      {
        properties: {
          path: param("string", "File path, absolute or relative to workspace root."),
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
      return ToolResult.err("Error parsing arguments");
    }

    const { path: filePath, oldString, newString, replace_all: replaceAll = false } = op;
    const workspace = (ctx.get("workspace") as Workspace | null) || null;
    const workspaceRoot = (ctx.get("workspaceRoot") as string | null) || null;

    let resolvedPath: string;
    try {
      if (workspace) {
        resolvedPath = workspace.resolveSafe(filePath);
      } else {
        resolvedPath = path.resolve(workspaceRoot || ".", filePath);
      }
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        return ToolResult.err(e.message);
      }
      return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
    }

    // Validate input size
    const inputSize = oldString.length + newString.length;
    if (inputSize > this.maxEditInputSize) {
      throw AssistantRetryableError.WithHint(
        `Edit input too large: ${inputSize} characters (max ${this.maxEditInputSize}).`,
        "Split this edit into multiple smaller edits, each targeting a specific section of the file.",
      );
    }

    // Read file
    let sourceContent: string;
    try {
      sourceContent = await fs.readFile(resolvedPath, "utf-8");
    } catch (e: unknown) {
      return ToolResult.err(`File not found or unreadable '${filePath}': ${(e as Error).message}`);
    }

    // Find and replace
    const result = findAndReplace(sourceContent, oldString, newString, replaceAll || false);
    if (result.error) {
      return ToolResult.err(`Edit failed: ${result.error}`);
    }

    const { newContent, matchInfo } = result;

    // Write file
    try {
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });
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

/**
 * Parse and validate edit tool arguments.
 * Supports both camelCase and snake_case field names.
 */
function parseArgs(input: string | Record<string, unknown> | null): EditArgs | null {
  const json = parseToolInput(input);
  if (!json) return null;

  // Support snake_case aliases
  const path = json.path;
  const oldString = json.oldString ?? json.old_string;
  const newString = json.newString ?? json.new_string;

  if (typeof path !== "string" || !path) {
    return null;
  }
  // oldString and newString must be present (not undefined/null), "" allowed here.
  // Empty oldString is rejected later with a specific message;
  // empty newString is valid and signals text deletion.
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

/**
 * Truncate a string to max length, adding '...' if truncated.
 * UTF-8 safe: uses character iteration.
 */
function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * Find `old` in `content` and replace with `new`.
 * Strategy 1: exact match.
 * Strategy 2: line-trimmed fallback — match each line with leading whitespace trimmed.
 */
function findAndReplace(content: string, old: string, newStr: string, all: boolean): FindReplaceResult {
  // Reject empty oldString
  if (old.length === 0) {
    return { error: "oldString must not be empty" };
  }

  // Strategy 1: exact match
  if (content.includes(old)) {
    if (old === newStr) {
      return {
        error: "no changes to apply — oldString and newString are identical",
      };
    }

    // Calculate line numbers for exact match
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
    // Provide helpful error with file context
    const contextLines =
      contentLines.length <= 10
        ? contentLines
        : [...contentLines.slice(0, 3), "...", ...contentLines.slice(Math.max(0, contentLines.length - 4))];
    const context = contextLines.join("\n");
    throw AssistantRetryableError.WithHint(
      `text not found in file.\n\nSearched for: ${JSON.stringify(old)}\n\nFile content:\n${context}`,
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

  // Build result
  const resultLines = [
    ...contentLines.slice(0, startLineIdx),
    ...adjustedNewLines,
    ...contentLines.slice(startLineIdx + oldTrimmed.length),
  ];
  const newContent = resultLines.join("\n");
  const startLine = startLineIdx + 1; // 1-indexed
  // Degenerate to startLine when deleting (zero-length replacement).
  const endLine = Math.max(startLine, startLineIdx + adjustedNewLines.length); // 1-indexed

  return {
    newContent,
    matchInfo: { startLine, endLine, matchCount: 1 },
  };
}
