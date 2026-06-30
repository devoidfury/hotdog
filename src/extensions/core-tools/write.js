// Write tool — write content to a file.

import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../../core/error.js";

/**
 * Check if a file exists.
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

import {
  toolDef,
  param,
  ToolResult,
  toolResult,
  parseToolInput,
} from "../../core/extensions/tool-utils.js";
import { validateCwdBoundary, resolvePath } from "../../utils/file-utils.js";

export class WriteTool {
  static TOOL_NAME = "write";

  toToolDef() {
    return toolDef(
      WriteTool.TOOL_NAME,
      "Writes a file to the local filesystem. Each call performs a single operation. Modes:\n\n1. **overwrite** — replaces entire file content. Requires: path, content.\n2. **insert_before** — inserts content at the given line, shifting existing lines down. Requires: path, start_at, content.\n3. **replace_all** — replaces all occurrences of literal string. Requires: path, search, content.\n4. **regex_replace** — replaces all matches of regex pattern. Requires: path, search_re, content.\n5. **replace_range** — replaces lines from start_at through end_at (inclusive) with new content. Requires: path, start_at, end_at, content.\n6. **replace_range_literal** — replaces literal string on each line from start_at to end_at (or EOF). Requires: path, search, start_at, content.\n7. **replace_range_regex** — applies regex replacement on each line from start_at to end_at (or EOF). Requires: path, search_re, start_at, content.\n\nAll line numbers are 1-indexed.",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          mode: param(
            "string",
            "Operation mode. One of: overwrite, insert_before, replace_all, regex_replace, replace_range, replace_range_literal, replace_range_regex",
          ),
          path: param("string", "File path relative to workspace root"),
          content: param(
            "string",
            "Replacement content or full new file content",
          ),
          search: param(
            "string",
            "Literal string to find/replace (used by replace_all, replace_range_literal)",
          ),
          search_re: param(
            "string",
            "Regex pattern to find/replace (used by regex_replace, replace_range_regex)",
          ),
          start_at: param(
            "integer",
            "Start line (1-indexed, inclusive). Required for insert_before, replace_range, replace_range_literal, replace_range_regex.",
            { minimum: 1 },
          ),
          end_at: param(
            "integer",
            "End line (1-indexed, inclusive). Required for replace_range, replace_range_literal, replace_range_regex. Optional for replace_range_literal/replace_range_regex — defaults to EOF.",
          ),
          replace_all: param(
            "boolean",
            "Replace all occurrences (default: false).",
          ),
        },
        required: ["mode", "path", "content"],
      },
    );
  }

  callDisplay(input) {
    let args;
    try {
      args = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      return typeof input === "string" ? input : "";
    }
    if (!args || !args.mode || !args.path || args.content === undefined) {
      return typeof input === "string" ? input : "";
    }
    const mode = args.mode;
    const filePath = args.path;
    const content = args.content || "";
    const search = args.search || "";
    const search_re = args.search_re || "";
    const start_at = typeof args.start_at === "number" ? args.start_at : null;
    const end_at = typeof args.end_at === "number" ? args.end_at : null;
    const contentLines = content.split("\n").length;

    switch (mode) {
      case "overwrite":
        return `${filePath} overwrite (${contentLines} lines)`;
      case "insert_before":
        return `${filePath} insert_before line ${start_at || 1} (${contentLines} lines)`;
      case "replace_all":
        return `${filePath} replace_all /${search || ""}/ (${contentLines} lines)`;
      case "regex_replace":
        return `${filePath} regex_replace /${search_re || ""}/ (${contentLines} lines)`;
      case "replace_range": {
        const start = start_at || 1;
        const end = end_at || start;
        const replaced = end - start + 1;
        return `${filePath} replace_range lines ${start}–${end} (${replaced} → ${contentLines} lines)`;
      }
      case "replace_range_literal":
      case "replace_range_regex": {
        const start = start_at || 1;
        const hasEnd = end_at !== null && end_at !== undefined;
        if (hasEnd) {
          const end = end_at;
          const replaced = end - start + 1;
          return `${filePath} ${mode} lines ${start}–${end} (${replaced} → ${contentLines} lines)`;
        }
        return `${filePath} ${mode} lines ${start}–EOF (${contentLines} lines)`;
      }
      default:
        return `${filePath} ${mode} (${contentLines} lines)`;
    }
  }

  async execute(input, ctx) {
    const rawArgs = parseToolInput(input);
    if (!rawArgs || !rawArgs.mode || !rawArgs.path || rawArgs.content === undefined) {
      return ToolResult.err("Error parsing arguments");
    }

    // Normalize args
    const args = {
      mode: rawArgs.mode,
      path: rawArgs.path,
      content: rawArgs.content,
      search: rawArgs.search || null,
      search_re: rawArgs.search_re || null,
      start_at: typeof rawArgs.start_at === "number" ? rawArgs.start_at : null,
      end_at: typeof rawArgs.end_at === "number" ? rawArgs.end_at : null,
      replace_all: rawArgs.replace_all || false,
    };

    const {
      mode,
      path: filePath,
      content,
      search,
      search_re,
      start_at,
      end_at,
    } = args;
    const cwdBoundary = ctx?.get('cwdBoundary') || null;
    const workspaceRoot = ctx?.get('workspaceRoot') || null;

    // Resolve path: cwdBoundary takes precedence, falls back to workspaceRoot
    const resolvedPath = resolvePath(filePath, cwdBoundary, workspaceRoot);

    // Validate cwd boundary on resolved path
    const boundaryError = validateCwdBoundary(resolvedPath, cwdBoundary);
    if (boundaryError) {
      return ToolResult.err(boundaryError);
    }

    // Validate mode
    const modeResult = validateMode(mode, {
      search,
      search_re,
      start_at,
      end_at,
    });
    if (modeResult) {
      return ToolResult.err(modeResult);
    }

    // Read existing content
    const dir = path.dirname(resolvedPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      return ToolResult.err(`Error creating directory: ${e.message}`);
    }

    const sourceContent = await fileExists(resolvedPath)
      ? await fs.readFile(resolvedPath, "utf-8")
      : "";
    const filesizeBefore = Buffer.byteLength(sourceContent, "utf-8");

    // Apply edit in-memory
    let newContent;
    try {
      newContent = applyEdit(
        sourceContent,
        mode,
        content,
        search,
        search_re,
        start_at,
        end_at,
      );
    } catch (e) {
      return ToolResult.err(`Edit failed: ${e.message}`);
    }

    const filesizeAfter = Buffer.byteLength(newContent, "utf-8");

    // Write the file
    try {
      await fs.writeFile(resolvedPath, newContent, "utf-8");
    } catch (e) {
      return ToolResult.err(`Error writing file: ${e.message}`);
    }

    // Return structured result with metadata
    return ToolResult.ok(
      JSON.stringify({
        path: filePath,
        mode,
        filesize_before: filesizeBefore,
        filesize_after: filesizeAfter,
      }),
    ).withEntries({
      path: filePath,
      mode,
      filesize_before: String(filesizeBefore),
      filesize_after: String(filesizeAfter),
      bytes_changed: String(filesizeAfter - filesizeBefore),
    });
  }
}

/**
 * Parse and validate write tool arguments.
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

  const mode = json.mode;
  const filePath = json.path;
  const content = json.content;

  if (!mode || !filePath || !content) {
    return null;
  }

  return {
    mode,
    path: filePath,
    content,
    search: json.search || null,
    search_re: json.search_re || null,
    start_at: typeof json.start_at === "number" ? json.start_at : null,
    end_at: typeof json.end_at === "number" ? json.end_at : null,
    replace_all: json.replace_all || false,
  };
}

/**
 * Validate mode-specific required parameters.
 */
function validateMode(mode, { search, search_re, start_at, end_at }) {
  switch (mode) {
    case "overwrite":
      return null;
    case "insert_before":
      if (!start_at || start_at < 1)
        return "insert_before requires path, start_at, and content";
      return null;
    case "replace_all":
      if (!search) return "replace_all requires path, search, and content";
      return null;
    case "regex_replace":
      if (!search_re)
        return "regex_replace requires path, search_re, and content";
      return null;
    case "replace_range":
      if (!start_at || !end_at)
        return "replace_range requires path, start_at, end_at, and content";
      if (start_at > end_at) return "replace_range: start_at must be <= end_at";
      return null;
    case "replace_range_literal":
      if (!search || !start_at)
        return "replace_range_literal requires path, search, start_at, and content";
      return null;
    case "replace_range_regex":
      if (!search_re || !start_at)
        return "replace_range_regex requires path, search_re, start_at, and content";
      return null;
    default:
      return `Edit failed: Unknown mode: '${mode}'`;
  }
}

/**
 * Apply edit operation in-memory.
 */
function applyEdit(source, mode, content, search, search_re, start_at, end_at) {
  switch (mode) {
    case "overwrite":
      return content;
    case "insert_before":
      return applyInsert(source, start_at, content);
    case "replace_all":
      return source.split(search).join(content);
    case "regex_replace":
      return applyRegexReplace(source, search_re, content);
    case "replace_range":
      return applyRangeReplace(source, start_at, end_at, content);
    case "replace_range_literal": {
      const effectiveEnd = end_at || source.split("\n").length;
      return applyRangeLiteralReplace(
        source,
        start_at,
        effectiveEnd,
        search,
        content,
      );
    }
    case "replace_range_regex": {
      const effectiveEnd = end_at || source.split("\n").length;
      return applyRangeRegexReplace(
        source,
        start_at,
        effectiveEnd,
        search_re,
        content,
      );
    }
    default:
      throw ToolError.UnknownMode(mode);
  }
}

function applyInsert(source, startLine, content) {
  // Empty source: just return content as-is
  if (source === "") {
    return content;
  }
  const lines = source.split("\n");
  const insertIdx = startLine - 1;

  if (insertIdx < 0) {
    // Insert at beginning
    const contentLines = content.split("\n");
    return [...contentLines, ...lines].join("\n");
  }

  if (insertIdx >= lines.length) {
    // Insert at end
    return source.endsWith("\n")
      ? `${source}${content}\n`
      : `${source}\n${content}`;
  }

  // Insert in middle
  const contentLines = content.split("\n");
  return [
    ...lines.slice(0, insertIdx),
    ...contentLines,
    ...lines.slice(insertIdx),
  ].join("\n");
}

function applyRegexReplace(source, pattern, replacement) {
  const re = new RegExp(pattern, "g");
  return source.replace(re, replacement);
}

function applyRangeReplace(source, startLine, endLine, content) {
  const lines = source.split("\n");
  const totalLines = lines.length;

  if (endLine > totalLines) {
    throw ToolError.EndExceedsLines(endLine, totalLines);
  }

  const startIdx = startLine - 1;
  const endIdx = endLine;
  const contentLines = content.split("\n");

  return [
    ...lines.slice(0, startIdx),
    ...contentLines,
    ...lines.slice(endIdx),
  ].join("\n");
}

function applyRangeLiteralReplace(
  source,
  startLine,
  endLine,
  search,
  replacement,
) {
  const lines = source.split("\n");
  const totalLines = lines.length;

  if (endLine > totalLines) {
    throw ToolError.EndExceedsLines(endLine, totalLines);
  }

  const startIdx = startLine - 1;
  const endIdx = endLine;
  const newLines = lines.map((line, i) => {
    if (i >= startIdx && i < endIdx) {
      return line.split(search).join(replacement);
    }
    return line;
  });

  return newLines.join("\n");
}

function applyRangeRegexReplace(
  source,
  startLine,
  endLine,
  pattern,
  replacement,
) {
  const re = new RegExp(pattern, "g");
  const lines = source.split("\n");
  const totalLines = lines.length;

  if (endLine > totalLines) {
    throw ToolError.EndExceedsLines(endLine, totalLines);
  }

  const startIdx = startLine - 1;
  const endIdx = endLine;
  const newLines = lines.map((line, i) => {
    if (i >= startIdx && i < endIdx) {
      return line.replace(re, replacement);
    }
    return line;
  });

  return newLines.join("\n");
}
