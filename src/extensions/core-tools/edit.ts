// Edit tool — replace text in a file.

import fs from "node:fs/promises";
import path from "node:path";
import extensionData from "./extension.json" with { type: "json" };
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { validateCwdBoundary, resolvePath } from "../../utils/file-utils.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

interface EditToolOptions {
  maxEditInputSize?: number;
}

interface EditToolConfig {
  coreTools?: {
    properties: {
      maxEditInputSize: { default: number };
    };
  };
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

  private readonly maxEditInputSize: number;

  constructor(options: EditToolOptions = {}) {
    const config = extensionData.configSchema as EditToolConfig;
    this.maxEditInputSize =
      options.maxEditInputSize ??
      config.coreTools?.properties.maxEditInputSize.default;
  }

  toToolDef() {
    return toolDef(
      EditTool.TOOL_NAME,
      "Single mode tool that replaces text in a file. Finds oldString, replaces with newString. Use this instead of the write tool for precise code edits.",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          path: param("string", "File path relative to workspace root"),
          oldString: param("string", "Exact text to find and replace"),
          newString: param("string", "Replacement text"),
          replace_all: param("boolean", "Replace all occurrences", {
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

  async execute(input: string | Record<string, unknown> | null, ctx: ToolExecutionContext): Promise<ToolResult> {
    const op = parseArgs(input);
    if (!op) {
      return ToolResult.err("Error parsing arguments");
    }

    const {
      path: filePath,
      oldString,
      newString,
      replace_all: replaceAll = false,
    } = op;
    const cwdBoundary = ctx.get("cwdBoundary") as string | null || null;
    const workspaceRoot = ctx.get("workspaceRoot") as string | null || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return ToolResult.err(boundaryError);
    }

    // Validate input size
    const inputSize = oldString.length + newString.length;
    if (inputSize > this.maxEditInputSize) {
      return ToolResult.err(
        `Edit input too large: ${inputSize} characters (max ${this.maxEditInputSize}). Please split into smaller edits.`,
      );
    }

    // Read file
    let sourceContent: string;
    try {
      sourceContent = await fs.readFile(resolvedPath, "utf-8");
    } catch (e: unknown) {
      return ToolResult.err(
        `File not found or unreadable '${filePath}': ${(e as Error).message}`,
      );
    }

    // Find and replace
    const result = findAndReplace(
      sourceContent,
      oldString,
      newString,
      replaceAll || false,
    );
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

    const lineCount = oldString.split("\n").length;
    return ToolResult.ok(
      `Successfully edited '${filePath}', found ${matchInfo!.matchCount} match${matchInfo!.matchCount > 1 ? "es" : ""}, replaced with ${lineCount} line${lineCount > 1 ? "s" : ""}`,
    ).withEntries({
      path: filePath,
      match_count: String(matchInfo!.matchCount),
      lines_replaced: String(lineCount),
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
  const path = json.path as string;
  const oldString = (json.oldString as string) ?? (json.old_string as string);
  const newString = (json.newString as string) ?? (json.new_string as string);

  if (!path || !newString) {
    return null;
  }
  // oldString can be empty string (findAndReplace validates that)
  // but must be present (not undefined/null)
  if (oldString === undefined || oldString === null) {
    return null;
  }

  return {
    path,
    oldString,
    newString,
    replace_all: json.replace_all as boolean || false,
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
    const newContent = all
      ? content.split(old).join(newStr)
      : content.replace(old, newStr);

    return {
      newContent,
      matchInfo: { startLine, endLine, matchCount },
    };
  }

  // Strategy 2: line-trimmed fallback
  const oldLines = old.split("\n");
  const newLines = newStr.split("\n");
  const oldFlat = oldLines.map((l: string) => l.trim()).join("\n");
  const contentLines = content.split("\n");
  const contentFlat = contentLines.map((l: string) => l.trim()).join("\n");

  const matchStart = contentFlat.indexOf(oldFlat);
  if (matchStart === -1) {
    // Provide helpful error with file context
    const contextLines =
      contentLines.length <= 10
        ? contentLines
        : [
            ...contentLines.slice(0, 3),
            "...",
            ...contentLines.slice(Math.max(0, contentLines.length - 4)),
          ];
    const context = contextLines.join("\n");
    return {
      error: `text not found in file.\n\nSearched for: ${JSON.stringify(old)}\n\nFile content:\n${context}\n\nTip: check whitespace/indentation. The tool supports line-trimmed matching (leading/trailing whitespace on each line is ignored).`,
    };
  }

  // Calculate which lines the match spans
  const beforeMatch = contentFlat.slice(0, matchStart);
  const startLineIdx = beforeMatch.split("\n").length;
  const oldLineCount = oldFlat.split("\n").length;

  // Build result
  const resultLines = [
    ...contentLines.slice(0, startLineIdx),
    ...newLines,
    ...contentLines.slice(startLineIdx + oldLineCount),
  ];
  const newContent = resultLines.join("\n");
  const startLine = startLineIdx + 1; // 1-indexed
  const endLine = startLineIdx + oldLineCount; // 1-indexed

  return {
    newContent,
    matchInfo: { startLine, endLine, matchCount: 1 },
  };
}
