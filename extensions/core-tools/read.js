// Read tool — read content from a file.

import fsSync from "node:fs";
import path from "node:path";
import {
  toolDef,
  param,
  ToolResult,
  toolResult,
  validateCwdBoundary,
  resolvePath,
  parseToolInput,
  defaultCallDisplay,
} from "../../src/core/tool-registry.js";
import { DEFAULT_READ_TOOL_LIMIT } from "./defaults.js";

export class ReadTool {
  static TOOL_NAME = "read";

  toToolDef() {
    return toolDef(
      ReadTool.TOOL_NAME,
      `Read a file's contents with optional pagination. Supports line-based extraction with offset/limit. Returns an error for directories with a depth-1 listing instead.`,
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          path: param(
            "string",
            "Path to the file to read (relative to workspace root)",
          ),
          limit: param("integer", `Maximum number of lines to return`, {
            minimum: 1,
            default: DEFAULT_READ_TOOL_LIMIT,
          }),
          offset: param("integer", "Number of lines to skip", {
            minimum: 0,
            default: 0,
          }),
        },
        required: ["path"],
      },
    );
  }

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const { path: filePath, limit, offset } = args;
      if (!filePath) {
        return typeof input === "string" ? input : "(no path)";
      }
      const end = offset + limit;
      return `${filePath} (lines ${offset}-${end})`;
    }, typeof input === "string" ? input : "(no path)");
  }

  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { path: filePath, limit, offset } = args;
    if (!filePath) {
      return ToolResult.err("path is required");
    }

    const cwdBoundary = ctx?.get('cwdBoundary') || null;
    const workspaceRoot = ctx?.get('workspaceRoot') || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return ToolResult.err(boundaryError);
    }

    const resolved = resolvedPath;

    // Check if it's a directory
    try {
      const stat = fsSync.statSync(resolved);
      if (stat.isDirectory()) {
        const listing = listDirectoryDepth1(resolved);
        return ToolResult.ok(
          `'${filePath}' is a directory. Here's a depth-1 listing:\n${listing}`,
        ).withEntries({
          path: resolved,
          type: "directory",
        });
      }
    } catch (e) {
      // stat failed — continue to file-not-found handling below
    }

    // Check if file exists
    if (!fsSync.existsSync(resolved)) {
      return ToolResult.err(`File not found: ${filePath}`);
    }

    return readLines(resolved, offset, limit);
  }
}

/**
 * Parse and validate read tool arguments.
 */
function parseArgs(input) {
  // Empty input → defaults
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return {
      path: null,
      limit: DEFAULT_READ_TOOL_LIMIT,
      offset: 0,
    };
  }

  const json = parseToolInput(input);
  if (!json) {
    return null; // Invalid JSON — error
  }

  const filePath = json.path;
  if (!filePath || typeof filePath !== "string") {
    return null;
  }

  const limit =
    typeof json.limit === "number" && json.limit >= 1
      ? json.limit
      : DEFAULT_READ_TOOL_LIMIT;
  const offset =
    typeof json.offset === "number" && json.offset >= 0 ? json.offset : 0;

  return { path: filePath, limit, offset };
}

/**
 * Read file by lines with offset/limit pagination.
 */
function readLines(filePath, offset, limit) {
  try {
    const content = fsSync.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (offset >= totalLines) {
      return ToolResult.ok(
        `File has ${totalLines} lines, offset ${offset} is beyond end.\n[empty]`,
      ).withEntries({
        path: filePath,
        total_lines: String(totalLines),
        offset: String(offset),
        limit: String(limit),
      });
    }

    const end = Math.min(offset + limit, totalLines);
    const selected = lines.slice(offset, end);
    const result = selected.length === 0 ? "[empty]" : selected.join("\n");

    return ToolResult.ok(result).withEntries({
      path: filePath,
      total_lines: String(totalLines),
      offset: String(offset),
      limit: String(limit),
      showing: `${offset + 1}-${end} (of ${totalLines} total)`,
    });
  } catch (e) {
    return ToolResult.err(`Failed to read file: ${e.message}`);
  }
}

/**
 * List directory contents at depth 1, sorted.
 */
function listDirectoryDepth1(dirPath) {
  try {
    const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    const sorted = entries
      .map((entry) => {
        const suffix = entry.isDirectory() ? "/" : "";
        return `  ${entry.name}${suffix}`;
      })
      .sort();
    return sorted.join("\n");
  } catch {
    return "  (unable to read directory)";
  }
}
