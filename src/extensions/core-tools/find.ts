import { execFile } from "node:child_process";
import util from "node:util";
import { toolDef, param, ToolResult, truncateOutput, parseToolInput, defaultCallDisplay } from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { correctCommonPathMistakes } from "../../utils/file-utils.ts";
import { PathEscapeError } from "../../utils/workspace.ts";
import type { Workspace } from "../../utils/workspace.ts";
import { ToolContext } from "../../core/extensions/types.ts";

const execFileAsync = util.promisify(execFile);

interface FindToolOptions {
  maxResults: number;
  maxOutputLines: number;
}


interface FindArgs {
  pattern: string;
  file_type: string | null;
  max_results: number;
  path: string | undefined;
}

function parseArgs(input: string | Record<string, unknown> | null, defaultMaxResults: number): FindArgs | null {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return { pattern: "*", file_type: null, max_results: defaultMaxResults, path: undefined };
  }

  const json = parseToolInput(input);
  if (!json) return null;

  let pattern = json.pattern as string | undefined;
  if (!pattern || typeof pattern !== "string") return null;

  const file_type = typeof json.file_type === "string" ? json.file_type : null;
  const max_results = typeof json.max_results === "number" && json.max_results >= 0 ? json.max_results : defaultMaxResults;
  let path = typeof json.path === "string" ? json.path : undefined;
  [pattern, path] = correctCommonPathMistakes(pattern, path);
  return { pattern, file_type, max_results, path };
}

function buildFdArgs(args: FindArgs): string[] {
  const fdArgs: string[] = [];

  switch (args.file_type) {
    case "f":
    case "file":
      fdArgs.push("-tf");
      break;
    case "d":
    case "directory":
      fdArgs.push("-td");
      break;
    case "e":
    case "empty":
      fdArgs.push("-te");
      break;
    default:
      break;
  }

  // Always include hidden files and respect .gitignore
  fdArgs.push("--hidden");
  fdArgs.push("--no-require-git");

  let pattern = args.pattern;
  if (pattern.includes("*")) {
    if (pattern.includes("/")) {
      fdArgs.push("--full-path");
      if (!pattern.startsWith("/") && !pattern.startsWith("*")) {
        pattern = `**/${pattern}`;
      }
    }
    fdArgs.push("--glob");
  }
  fdArgs.push(pattern);

  return fdArgs;
}

async function runFindFallback(pattern: string, fileType: string | null, cwd: string): Promise<string> {
  // glob change ** -> * for find compatibility
  let namePattern = pattern;
  if (namePattern.includes("**")) {
    namePattern = namePattern.replace("**", "*");
  }

  // If pattern contains `/`, use -path instead of -name (matches
  // against the full relative path).
  const usePath = namePattern.includes("/") && namePattern !== pattern;

  let findArgs = [cwd, "-maxdepth", "5"];
  if (usePath) {
    findArgs.push("-path", namePattern);
  } else {
    findArgs.push("-name", namePattern);
  }

  if (fileType === "f" || fileType === "file") {
    findArgs.push("-type", "f");
  } else if (fileType === "d" || fileType === "directory") {
    findArgs.push("-type", "d");
  } else if (fileType === "e" || fileType === "empty") {
    findArgs.push("-empty");
  }

  try {
    const { stdout } = await execFileAsync("find", findArgs, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (e: unknown) {
    // find returns exit code 1 when no matches found
    const err = e as { code?: number; status?: number };
    if (err.code === 1 || err.status === 1) {
      return "";
    }
    throw e;
  }
}

export class FindTool {
  static readonly TOOL_NAME = "find";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  private readonly maxResults: number;
  private readonly maxOutputLines: number;

  constructor(options: FindToolOptions) {

    this.maxResults = options.maxResults;
    this.maxOutputLines = options.maxOutputLines;
  }

  toToolDef() {
    return toolDef(
      FindTool.TOOL_NAME,
      "Find files and directories matching a glob pattern. Use this tool when you need to find files by name patterns.",
      {
        properties: {
          pattern: param(
            "string",
            'Glob pattern to match files against.',
          ),
          file_type: param(
            "string",
            'Filter by file type: "f" for files, "d" for directories.',
            { enum: ["f", "d"] },
          ),
          max_results: param("integer", `Maximum number of results to return`, {
            minimum: 1,
            maximum: 10000,
            default: this.maxResults,
          }),
          path: param(
            "string",
            "Path to search in. Defaults to current directory.",
          ),
        },
        required: ["pattern"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => {
      if (!args.pattern) return `* in . (max ${this.maxResults})`;
      const { file_type, path, max_results } = args;
      const pathStr = path || ".";
      const max = max_results ?? this.maxResults;
      if (!file_type) {
        return `${args.pattern} in ${pathStr} (max ${max})`;
      }
      return `${args.pattern} in ${pathStr} (${file_type}, max ${max})`;
    }, { fallback: `* in . (max ${this.maxResults})` });
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(input, this.maxResults);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { pattern, file_type, max_results, path: searchPath } = args;
    let cwd = searchPath || ".";

    const workspace = ctx.get("workspace") as Workspace | null || null;
    if (workspace) {
      try {
        cwd = workspace.resolveSafe(cwd);
      } catch (e: unknown) {
        if (e instanceof PathEscapeError) {
          return ToolResult.err(e.message);
        }
        return ToolResult.err(`Error resolving path: ${(e as Error).message}`);
      }
    }

    const fdArgs = buildFdArgs(args);
    const fdArgsStrs = fdArgs.map((s: string) => s);

    let output: string;
    try {
      const { stdout } = await execFileAsync("fd", fdArgsStrs, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      output = stdout;
    } catch {
      output = await runFindFallback(pattern, file_type, cwd);
    }

    let files = output.trim().split("\n").filter(Boolean);

    // Sort for deterministic output
    files.sort();

    const total_count = files.length;
    const truncated = total_count > max_results;
    if (truncated) {
      files = files.slice(0, max_results);
    }

    const display_count = files.length;
    const showing = truncated
      ? `1-${display_count} (of ${total_count} total)`
      : `1-${display_count}`;

    const content = files.length === 0 ? "No files found" : files.join("\n");

    return ToolResult.ok(truncateOutput(content, this.maxOutputLines)).withEntries({
      pattern,
      path: cwd,
      total_count: String(total_count),
      showing,
      ...(truncated ? { truncated: "true" } : {}),
      ...(file_type ? { file_type } : {}),
    });
  }
}
