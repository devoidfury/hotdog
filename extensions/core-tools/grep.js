// Grep tool — search files for patterns. Tries ripgrep first, falls back to native.

import fs from "node:fs";
import { execFile } from "node:child_process";
import util from "node:util";
import { join, extname } from "node:path";
import {
  toolDef,
  param,
  ToolResult,
  toolResult,
  truncateOutput,
} from "./registry.js";
import {
  DEFAULT_GREP_MAX_RESULTS,
  DEFAULT_MAX_TOOL_OUTPUT_LINES,
} from "../../src/config.js";

const execFileAsync = util.promisify(execFile);

// Common directories to skip during recursive search
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cargo",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
]);

// File type → extensions mapping
const TYPE_EXTENSIONS = {
  rust: ["rs"],
  rs: ["rs"],
  ts: ["ts", "tsx"],
  typescript: ["ts", "tsx"],
  py: ["py"],
  python: ["py"],
  js: ["js", "jsx"],
  javascript: ["js", "jsx"],
  go: ["go"],
  java: ["java"],
  c: ["c", "h"],
  cpp: ["cpp", "cxx", "cc", "hpp", "hxx"],
  cxx: ["cpp", "cxx", "cc", "hpp", "hxx"],
  cc: ["cpp", "cxx", "cc", "hpp", "hxx"],
  rb: ["rb"],
  ruby: ["rb"],
  sh: ["sh", "bash"],
  bash: ["sh", "bash"],
  shell: ["sh", "bash"],
  yaml: ["yaml", "yml"],
  yml: ["yaml", "yml"],
  json: ["json"],
  md: ["md"],
  markdown: ["md"],
  toml: ["toml"],
  xml: ["xml"],
  html: ["html", "htm"],
  htm: ["html", "htm"],
  css: ["css", "scss", "less"],
  scss: ["css", "scss", "less"],
  less: ["css", "scss", "less"],
};

/**
 * Map file type names to file extensions.
 */
function typeToExtensions(typeName) {
  const name = typeName.toLowerCase();
  return TYPE_EXTENSIONS[name] || [typeName];
}

/**
 * Check if a file extension matches the type filter.
 */
function matchesType(fileExt, typeFilter) {
  if (!typeFilter || typeFilter === "all") return true;
  const extensions = typeToExtensions(typeFilter);
  return extensions.length === 0 || extensions.includes(fileExt);
}

/**
 * Check if a file is binary by reading its first bytes.
 */
function isBinary(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const slice = data.length > 512 ? data.subarray(0, 512) : data;
    return slice.some((b) => b === 0);
  } catch {
    return true;
  }
}

/**
 * Recursively walk a directory and search files for a pattern.
 */
function walkAndSearch(
  dir,
  re,
  maxResults,
  context,
  typeFilter,
  outputLines,
  totalMatches,
) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (outputLines.length >= maxResults) return;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip common non-source directories
      if (SKIP_DIRS.has(entry.name)) continue;
      walkAndSearch(
        fullPath,
        re,
        maxResults,
        context,
        typeFilter,
        outputLines,
        totalMatches,
      );
    } else if (entry.isFile()) {
      // Check file type filter
      const ext = extname(entry.name).slice(1); // Remove leading dot
      if (!matchesType(ext, typeFilter)) continue;

      // Skip binary files
      if (isBinary(fullPath)) continue;

      // Read file and search
      let content;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const pathStr = fullPath;

      for (
        let i = 0;
        i < lines.length && outputLines.length < maxResults;
        i++
      ) {
        const line = lines[i];
        if (!re.test(line)) continue;

        re.lastIndex = 0; // Reset regex state
        totalMatches.count++;
        const lineNum = i + 1;

        // Add context lines before
        const start = context > 0 ? Math.max(1, lineNum - context) : lineNum;
        for (let ctxLine = start; ctxLine < lineNum; ctxLine++) {
          const idx = ctxLine - 1;
          if (idx < lines.length) {
            outputLines.push(`${pathStr}:${ctxLine}:${lines[idx]}`);
          }
        }

        // Add matching line
        outputLines.push(`${pathStr}:${lineNum}:${line}`);

        // Add context lines after
        const end =
          context > 0 ? Math.min(lines.length, lineNum + context) : lineNum;
        for (let ctxLine = lineNum + 1; ctxLine <= end; ctxLine++) {
          const idx = ctxLine - 1;
          if (idx < lines.length) {
            outputLines.push(`${pathStr}:${ctxLine}:${lines[idx]}`);
          }
        }
      }
    }
  }
}

/**
 * Native grep implementation — walks directory tree and searches file contents.
 */
function grepNative(pattern, searchDir, maxResults, context, typeFilter) {
  // Validate regex first
  const re = new RegExp(pattern);

  const outputLines = [];
  const totalMatches = { count: 0 };

  walkAndSearch(
    searchDir,
    re,
    maxResults,
    context,
    typeFilter,
    outputLines,
    totalMatches,
  );

  const display = outputLines.join("\n");
  return { display, totalMatches: totalMatches.count };
}

/**
 * Try running ripgrep with JSON output.
 */
async function grepWithRg(pattern, searchDir, maxResults, context, typeFilter) {
  const args = ["--json", "--no-heading", "--color", "never"];

  if (context > 0) {
    args.push(`-C${context}`);
  }

  if (typeFilter && typeFilter !== "all") {
    const extensions = typeToExtensions(typeFilter);
    for (const ext of extensions) {
      args.push(`--glob=*.${ext}`);
    }
  }

  args.push(pattern, searchDir);

  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: searchDir,
    });

    // Parse NDJSON output from ripgrep
    const lines = stdout.trim().split("\n").filter(Boolean);
    const outputLines = [];
    let totalMatches = 0;

    for (const line of lines) {
      try {
        const match = JSON.parse(line);
        if (match.type === "match" && match.data) {
          const path = match.data.path?.text || match.data?.absolute_path || "";
          const text = match.data.lines?.text || "";
          const lineNum = match.data.line_number || 0;

          if (outputLines.length < maxResults) {
            totalMatches++;
            outputLines.push(`${path}:${lineNum}:${text}`);
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    return { display: outputLines.join("\n"), totalMatches };
  } catch (e) {
    // ripgrep not found or failed — fall back to native
    throw new Error("ripgrep not available");
  }
}

/**
 * Parse and validate grep tool arguments.
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

  const pattern = json.pattern;
  if (!pattern || typeof pattern !== "string") {
    return null;
  }

  const path = typeof json.path === "string" ? json.path : null;
  const maxResults =
    typeof json.max_results === "number" && json.max_results >= 1
      ? json.max_results
      : DEFAULT_GREP_MAX_RESULTS;
  const context =
    typeof json.context === "number" && json.context >= 0 ? json.context : 0;
  const type = typeof json.type === "string" ? json.type : null;

  return { pattern, path, maxResults, context, type };
}

export class GrepTool {
  static TOOL_NAME = "grep";

  toToolDef() {
    return toolDef(
      GrepTool.TOOL_NAME,
      "Search file contents for a pattern. Supports regex, file type filtering, and context lines. Returns matching lines with file paths.",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          pattern: param("string", "Search pattern (regex)"),
          path: param(
            "string",
            "File or directory to search (default: workspace root)",
          ),
          type: param(
            "string",
            "File type filter (e.g., rust, ts, py, js, all)",
          ),
          max_results: param("integer", `Maximum results to return`, {
            minimum: 1,
            default: DEFAULT_GREP_MAX_RESULTS,
          }),
          context: param(
            "integer",
            "Number of context lines before/after match",
            {
              default: 0,
            },
          ),
        },
        required: ["pattern"],
      },
    );
  }

  callDisplay(input) {
    const args = parseArgs(input);
    if (!args) {
      return typeof input === "string" ? input : "";
    }
    const path = args.path || ".";
    return `'${args.pattern}' in ${path}`;
  }

  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { pattern, path: searchPath, maxResults, context, type } = args;
    const searchDir = searchPath || ".";

    // Validate regex
    try {
      new RegExp(pattern);
    } catch (e) {
      return ToolResult.err(`Invalid regex pattern: ${e.message}`);
    }

    // Try ripgrep first, fall back to native implementation
    let result;
    try {
      result = await grepWithRg(pattern, searchDir, maxResults, context, type);
    } catch {
      // ripgrep not available — use native implementation
      result = grepNative(pattern, searchDir, maxResults, context, type);
    }

    const { display, totalMatches } = result;
    const truncated = totalMatches > maxResults;

    if (totalMatches === 0) {
      return ToolResult.ok("No matches found.");
    }

    const content = truncateOutput(display, DEFAULT_MAX_TOOL_OUTPUT_LINES);

    const metadata = new Map();
    metadata.set("path", searchDir);
    metadata.set("pattern", pattern);
    metadata.set("results", String(totalMatches));

    if (truncated) {
      metadata.set("truncated", "true");
      metadata.set("max_results", String(maxResults));
    }

    if (context > 0) {
      metadata.set("context", String(context));
    }

    if (type) {
      metadata.set("type", type);
    }

    return ToolResult.ok(content).withEntries(metadata);
  }
}
