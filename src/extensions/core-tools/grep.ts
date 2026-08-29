import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import util from "node:util";
import { join, extname, resolve } from "node:path";
import { AssistantRetryableError, ToolError } from "../../core/error.ts";
import {
  toolDef,
  param,
  ToolResult,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { correctCommonPathMistakes } from "../../utils/file-utils.ts";
import { PathEscapeError } from "../../utils/workspace.ts";
import type { Workspace } from "../../utils/workspace.ts";
import { ToolContext } from "../../core/extensions/types.ts";

const execFileAsync = util.promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cargo",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
]);

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
  maxResults: number;
  maxOutputLines: number;
}


interface GrepArgs {
  pattern: string;
  path: string | undefined;
  maxResults: number;
  context: number;
  type: string | null;
}

function typeToExtensions(typeName: string): string[] {
  const name = typeName.toLowerCase();
  return TYPE_EXTENSIONS[name] || [typeName];
}

function matchesType(fileExt: string, typeFilter: string | null): boolean {
  if (!typeFilter || typeFilter === "all") return true;
  const extensions = typeToExtensions(typeFilter);
  return extensions.length === 0 || extensions.includes(fileExt);
}

async function isBinary(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    // Only the first 512 bytes matter for NUL detection; don't read the
    // whole file into memory.
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(512), 0, 512, 0);
    return buffer.subarray(0, bytesRead).indexOf(0) !== -1;
  } catch {
    return true;
  } finally {
    await handle?.close();
  }
}

async function searchFile(
  filePath: string,
  re: RegExp,
  maxResults: number,
  context: number,
  typeFilter: string | null,
  outputLines: string[],
  totalMatches: { count: number },
): Promise<void> {
  if (outputLines.length >= maxResults) return;

  const ext = extname(filePath).slice(1);
  if (!matchesType(ext, typeFilter)) return;

  if (await isBinary(filePath)) return;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  const pathStr = filePath;

  for (
    let i = 0;
    i < lines.length && outputLines.length < maxResults;
    i++
  ) {
    const line = lines[i];
    if (!line || !re.test(line)) continue;

    re.lastIndex = 0;
    totalMatches.count++;
    const lineNum = i + 1;

    const start = context > 0 ? Math.max(1, lineNum - context) : lineNum;
    for (let ctxLine = start; ctxLine < lineNum; ctxLine++) {
      const idx = ctxLine - 1;
      if (idx < lines.length) {
        outputLines.push(`${pathStr}:${ctxLine}:${lines[idx]}`);
      }
    }

    outputLines.push(`${pathStr}:${lineNum}:${line}`);

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

async function walkAndSearch(
  path: string,
  re: RegExp,
  maxResults: number,
  context: number,
  typeFilter: string | null,
  outputLines: string[],
  totalMatches: { count: number },
): Promise<void> {
  try {
    const stats = await fs.stat(path);
    if (stats.isFile()) {
      await searchFile(
        path,
        re,
        maxResults,
        context,
        typeFilter,
        outputLines,
        totalMatches,
      );
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  const entries = await fs.readdir(path, { withFileTypes: true });

  for (const entry of entries) {
    if (outputLines.length >= maxResults) return;

    const fullPath = join(path, entry.name);

    if (entry.isDirectory()) {
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
      await searchFile(
        fullPath,
        re,
        maxResults,
        context,
        typeFilter,
        outputLines,
        totalMatches,
      );
    }
  }
}

async function grepNative(
  pattern: string,
  searchDir: string,
  maxResults: number,
  context: number,
  typeFilter: string | null,
): Promise<{ display: string; totalMatches: number }> {
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

async function grepWithRg(
  pattern: string,
  searchDir: string,
  maxResults: number,
  context: number,
  typeFilter: string | null,
): Promise<{ display: string; totalMatches: number }> {
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

    const lines = stdout.trim().split("\n").filter(Boolean);
    const outputLines: string[] = [];
    let totalMatches = 0;

    for (const line of lines) {
      try {
        const match = JSON.parse(line) as Record<string, unknown>;
        if (match.type === "match" && match.data && typeof match.data === "object") {
          const data = match.data as Record<string, unknown>;
          const pathObj = data.path as Record<string, unknown> | undefined;
          const path = (pathObj?.text as string) || (data.absolute_path as string) || "";
          const linesObj = data.lines as Record<string, unknown> | undefined;
          const text = (linesObj?.text as string) || "";
          const lineNum = (data.line_number as number) || 0;

          if (outputLines.length < maxResults) {
            totalMatches++;
            outputLines.push(`${path}:${lineNum}:${text}`);
          }
        }
      } catch {}
    }

    return { display: outputLines.join("\n"), totalMatches };
  } catch (e: unknown) {
    throw ToolError.NotAvailable("ripgrep");
  }
}

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

  let path = typeof json.path === "string" ? json.path : undefined;
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
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  private readonly maxResults: number;
  private readonly maxOutputLines: number;

  constructor(options: GrepToolOptions) {

    this.maxResults = options.maxResults;
    this.maxOutputLines = options.maxOutputLines;
  }

  toToolDef() {
    return toolDef(
      GrepTool.TOOL_NAME,
      "Search file contents for a pattern. Supports regex, file type filtering, and context lines. Returns matching lines with file paths.",
      {
        properties: {
          pattern: param("string", "Search pattern regex."),
          path: param(
            "string",
            "File or directory to search. Defaults to current working directory. Path relative to the workspace root, or an absolute path inside a configured workspace root.",
          ),
          type: param(
            "string",
            "File type filter. Examples - rust, ts, py, js, all",
          ),
          max_results: param("integer", `Maximum results to return.`, {
            minimum: 1,
            default: this.maxResults,
          }),
          context: param(
            "integer",
            "Number of context lines before and after match.",
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
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const args = parseArgs(input, this.maxResults);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { pattern, path: searchPath, maxResults, context, type } = args;

    // Models sometimes emit "/subpath" when they meant "./subpath"; detect and fix that here.
    const modelForgotPathPrefix =
      searchPath?.startsWith("/") &&
      !(await fs.exists(searchPath)) &&
      await fs.exists(`.${searchPath}`);
    let searchDir = modelForgotPathPrefix
      ? `.${searchPath}`
      : searchPath || ".";

    const workspace = ctx.get("workspace") as Workspace | null || null;
    if (workspace) {
      try {
        searchDir = workspace.resolveSafe(searchDir);
      } catch (e: unknown) {
        if (e instanceof PathEscapeError) {
          return ToolResult.err(e.message);
        }
        return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
      }
    }

    try {
      new RegExp(pattern);
    } catch (e: unknown) {
      throw AssistantRetryableError.WithHint(
        `Invalid regex pattern: ${(e as Error).message}`,
        "Fix the regex syntax. Common issues: unescaped special characters, mismatched brackets, invalid escape sequences.",
      );
    }

    let result: { display: string; totalMatches: number };
    try {
      result = await grepWithRg(pattern, searchDir, maxResults, context, type);
    } catch {
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

    return ToolResult.ok(content).withEntries(Object.fromEntries(metadata));
  }
}
