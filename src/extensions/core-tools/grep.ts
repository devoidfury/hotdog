// Grep tool — search files for patterns. Tries ripgrep first, falls back to native.

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import util from "node:util";
import { join, extname, resolve } from "node:path";
import { ToolError } from "../../core/error.ts";
import extensionData from "./extension.json" with { type: "json" };
import {
  toolDef,
  param,
  ToolResult,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { correctCommonPathMistakes } from "../../utils/file-utils.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

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
const TYPE_EXTENSIONS: Record<string, string[]> = {
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

interface GrepToolOptions {
  maxResults?: number;
  maxOutputLines?: number;
}

interface GrepToolConfig {
  coreTools?: {
    properties: {
      grepMaxResults: { default: number };
      maxToolOutputLines: { default: number };
    };
  };
}

interface GrepArgs {
  pattern: string;
  path: string | null;
  maxResults: number;
  context: number;
  type: string | null;
}

/**
 * Map file type names to file extensions.
 */
function typeToExtensions(typeName: string): string[] {
  const name = typeName.toLowerCase();
  return TYPE_EXTENSIONS[name] || [typeName];
}

/**
 * Check if a file extension matches the type filter.
 */
function matchesType(fileExt: string, typeFilter: string | null): boolean {
  if (!typeFilter || typeFilter === "all") return true;
  const extensions = typeToExtensions(typeFilter);
  return extensions.length === 0 || extensions.includes(fileExt);
}

/**
 * Check if a file is binary by reading its first bytes.
 */
async function isBinary(filePath: string): Promise<boolean> {
  try {
    const data = await fs.readFile(filePath);
    const slice = data.length > 512 ? data.subarray(0, 512) : data;
    return slice.indexOf(0) !== -1;
  } catch {
    return true;
  }
}

/**
 * Recursively walk a directory and search files for a pattern.
 */
async function walkAndSearch(
  dir: string,
  re: RegExp,
  maxResults: number,
  context: number,
  typeFilter: string | null,
  outputLines: string[],
  totalMatches: { count: number },
): Promise<void> {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (outputLines.length >= maxResults) return;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip common non-source directories
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkAndSearch(
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
      if (await isBinary(fullPath)) continue;

      // Read file and search
      let content: string;
      try {
        content = await fs.readFile(fullPath, "utf-8");
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
async function grepNative(
  pattern: string,
  searchDir: string,
  maxResults: number,
  context: number,
  typeFilter: string | null,
): Promise<{ display: string; totalMatches: number }> {
  // Validate regex first
  const re = new RegExp(pattern);

  const outputLines: string[] = [];
  const totalMatches = { count: 0 };

  await walkAndSearch(
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
async function grepWithRg(
  pattern: string,
  searchDir: string,
  maxResults: number,
  context: number,
  typeFilter: string | null,
): Promise<{ display: string; totalMatches: number }> {
  // Resolve to absolute path to avoid cwd-relative path issues
  const absSearchDir = resolve(searchDir);
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

  args.push(pattern, absSearchDir);

  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: absSearchDir,
    });

    // Parse NDJSON output from ripgrep
    const lines = stdout.trim().split("\n").filter(Boolean);
    const outputLines: string[] = [];
    let totalMatches = 0;

    for (const line of lines) {
      try {
        const match = JSON.parse(line) as Record<string, unknown>;
        if (match.type === "match" && match.data) {
          const path =
            ((match.data as Record<string, unknown>).path?.text as string) ||
            ((match.data as Record<string, unknown>).absolute_path as string) ||
            "";
          const text =
            ((match.data as Record<string, unknown>).lines?.text as string) ||
            "";
          const lineNum =
            ((match.data as Record<string, unknown>).line_number as number) ||
            0;

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
  } catch (e: unknown) {
    // ripgrep not found or failed — fall back to native
    throw ToolError.NotAvailable("ripgrep");
  }
}

/**
 * Parse and validate grep tool arguments.
 */
function parseArgs(
  input: string | Record<string, unknown> | null,
  defaultMaxResults: number,
): GrepArgs | null {
  const json = parseToolInput(input);
  if (!json) return null;

  let pattern = json.pattern as string | undefined;
  if (!pattern || typeof pattern !== "string") {
    return null;
  }

  let path = typeof json.path === "string" ? json.path : null;
  const maxResults =
    typeof json.max_results === "number" && json.max_results >= 1
      ? json.max_results
      : defaultMaxResults;
  const context =
    typeof json.context === "number" && json.context >= 0 ? json.context : 0;
  const type = typeof json.type === "string" ? json.type : null;

  [pattern, path] = correctCommonPathMistakes(pattern, path);

  return { pattern, path, maxResults, context, type };
}

export class GrepTool {
  static readonly TOOL_NAME = "grep";

  private readonly maxResults: number;
  private readonly maxOutputLines: number;

  constructor(options: GrepToolOptions = {}) {
    const config = extensionData.configSchema as GrepToolConfig;
    this.maxResults =
      options.maxResults ?? config.coreTools?.properties.grepMaxResults.default;
    this.maxOutputLines =
      options.maxOutputLines ??
      config.coreTools?.properties.maxToolOutputLines.default;
  }

  toToolDef(): Record<string, unknown> {
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
            default: this.maxResults,
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

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args: Record<string, unknown>) => {
        if (!args.pattern) return "";
        const path = args.path || ".";
        return `'${args.pattern}' in ${path}`;
      },
      typeof input === "string" ? input : "",
    );
  }

  async execute(
    input: string | Record<string, unknown> | null,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const args = parseArgs(input, this.maxResults);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { pattern, path: searchPath, maxResults, context, type } = args;
    const searchDir = searchPath || ".";

    // Validate regex
    try {
      new RegExp(pattern);
    } catch (e: unknown) {
      return ToolResult.err(`Invalid regex pattern: ${(e as Error).message}`);
    }

    // Try ripgrep first, fall back to native implementation
    let result: { display: string; totalMatches: number };
    try {
      result = await grepWithRg(pattern, searchDir, maxResults, context, type);
    } catch {
      // ripgrep not available — use native implementation
      result = await grepNative(pattern, searchDir, maxResults, context, type);
    }

    const { display, totalMatches } = result;
    const truncated = totalMatches > maxResults;

    if (totalMatches === 0) {
      return ToolResult.ok("No matches found.");
    }

    const content = truncateOutput(display, this.maxOutputLines);

    const metadata = new Map<string, string>();
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
