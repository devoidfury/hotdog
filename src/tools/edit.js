// Edit tool — replace text in a file.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  toolDef,
  param,
  toolResult,
  validateCwdBoundary,
  resolvePath,
} from "./registry.js";
import { DEFAULT_MAX_EDIT_INPUT_SIZE } from "../config.js";

export class EditTool {
  static TOOL_NAME = "edit";

  static tryNewFromContext(ctx) {
    return new EditTool();
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

  callDisplay(input) {
    let op;
    try {
      op = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      return typeof input === "string" ? input : "";
    }
    if (!op || !op.path) {
      return typeof input === "string" ? input : "";
    }
    const oldPreview = truncateString(op.oldString || "", 40);
    const newPreview = truncateString(op.newString || "", 40);
    return `${op.path}: '${oldPreview}' → '${newPreview}'`;
  }

  async execute(input, ctx) {
    const op = parseArgs(input);
    if (!op) {
      return toolResult("Error parsing arguments");
    }

    const {
      path: filePath,
      oldString,
      newString,
      replace_all: replaceAll = false,
    } = op;
    const cwdBoundary = ctx?.cwdBoundary || null;
    const workspaceRoot = ctx?.workspaceRoot || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return toolResult(boundaryError);
    }

    // Validate input size
    const inputSize = oldString.length + newString.length;
    if (inputSize > DEFAULT_MAX_EDIT_INPUT_SIZE) {
      return toolResult(
        `Edit input too large: ${inputSize} characters (max ${DEFAULT_MAX_EDIT_INPUT_SIZE}). Please split into smaller edits.`,
      );
    }

    // Read file
    let sourceContent;
    try {
      sourceContent = fsSync.readFileSync(resolvedPath, "utf-8");
    } catch (e) {
      return toolResult(
        `File not found or unreadable '${filePath}': ${e.message}`,
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
      return toolResult(`Edit failed: ${result.error}`);
    }

    const { newContent, matchInfo } = result;

    // Write file
    try {
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(resolvedPath, newContent, "utf-8");
    } catch (e) {
      return toolResult(`Error writing file: ${e.message}`);
    }

    const lineCount = oldString.split("\n").length;
    return toolResult(
      `Successfully edited '${filePath}', found ${matchInfo.matchCount} match${matchInfo.matchCount > 1 ? "es" : ""}, replaced with ${lineCount} line${lineCount > 1 ? "s" : ""}`,
    );
  }
}

/**
 * Parse and validate edit tool arguments.
 * Supports both camelCase and snake_case field names.
 */
function parseArgs(input) {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return null;
  }

  let json;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch {
      return null;
    }
  } else {
    json = input;
  }

  // Support snake_case aliases
  const path = json.path;
  const oldString = json.oldString ?? json.old_string;
  const newString = json.newString ?? json.new_string;

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
    replace_all: json.replace_all || false,
  };
}

/**
 * Truncate a string to max length, adding '...' if truncated.
 * UTF-8 safe: uses character iteration.
 */
function truncateString(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * Find `old` in `content` and replace with `new`.
 * Strategy 1: exact match.
 * Strategy 2: line-trimmed fallback — match each line with leading whitespace trimmed.
 */
function findAndReplace(content, old, newStr, all) {
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
  const oldFlat = oldLines.map((l) => l.trim()).join("\n");
  const contentLines = content.split("\n");
  const contentFlat = contentLines.map((l) => l.trim()).join("\n");

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
