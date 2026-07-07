// Find tool — find files matching a glob pattern.
// Helper functions are defined before the class to ensure they are
// available in all scope contexts (including catch blocks).

import { execFile } from "node:child_process";
import util from "node:util";
import extensionData from "./extension.json";
import { toolDef, param, ToolResult, truncateOutput, parseToolInput, defaultCallDisplay } from "../../core/extensions/tool-utils.js";
import { correctCommonPathMistakes } from "../../utils/file-utils";

const execFileAsync = util.promisify(execFile);

// Helper functions

/**
 * Parse and validate find tool arguments. Returns normalized args object or null on error.
 */
function parseArgs(input, defaultMaxResults) {
  // Empty input → defaults
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return { pattern: "*", file_type: null, max_results: defaultMaxResults, path: null };
  }

  const json = parseToolInput(input);
  if (!json) return null;

  // pattern is required
  let pattern = json.pattern;
  if (!pattern || typeof pattern !== "string") return null;
  
  // optional params
  const file_type = typeof json.file_type === "string" ? json.file_type : null;
  const max_results = typeof json.max_results === "number" && json.max_results >= 0 ? json.max_results : defaultMaxResults;
  let path = typeof json.path === "string" ? json.path : null;
  [pattern, path] = correctCommonPathMistakes(pattern, path);
  return { pattern, file_type, max_results, path };
}

/**
 * Build fd arguments based on file_type and pattern.
 * --no-require-git: respect .gitignore even without a .git directory
 * --glob: treat pattern as a glob (not regex)
 */
function buildFdArgs(args) {
  const fdArgs = [];

  // File type filter
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

  // Pattern handling
  let pattern = args.pattern;
  if (pattern.includes("*")) {
    if (pattern.includes("/")) {
      fdArgs.push("--full-path");
      // Auto-prepend **/ for patterns that don't start with / or *
      if (!pattern.startsWith("/") && !pattern.startsWith("*")) {
        pattern = `**/${pattern}`;
      }
    }
    fdArgs.push("--glob");
  }
  fdArgs.push(pattern);

  return fdArgs;
}

/**
 * Fallback to the `find` command when `fd` is not available.
 *
 * Note: `find -name` does NOT support `**` glob patterns
 */
async function runFindFallback(pattern, fileType, cwd) {
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
  } catch (e) {
    // find returns exit code 1 when no matches found
    if (e.code === 1 || e.status === 1) {
      return "";
    }
    throw e;
  }
}

export class FindTool {
  static TOOL_NAME = "find";
  constructor(options = {}) {
    this.maxResults = options.maxResults ?? extensionData.configSchema.coreTools.properties.findMaxResults.default;
    this.maxOutputLines = options.maxOutputLines ?? extensionData.configSchema.coreTools.properties.maxToolOutputLines.default;
  }
  toToolDef() {
    return toolDef(
      FindTool.TOOL_NAME,
      "Find files and directories matching a glob pattern. Use this tool when you need to find files by name patterns.",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          pattern: param(
            "string",
            'Glob pattern to match files against (e.g. "*.rs", "**/test*", "/etc/**/*.conf")',
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
  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      if (!args.pattern) return `* in . (max ${this.maxResults})`;
      const { file_type, path, max_results } = args;
      const pathStr = path || ".";
      const max = max_results ?? this.maxResults;
      if (!file_type) {
        return `${args.pattern} in ${pathStr} (max ${max})`;
      }
      return `${args.pattern} in ${pathStr} (${file_type}, max ${max})`;
    }, (raw) => `* in . (max ${this.maxResults})`);
  }
  async execute(input, ctx) {
    const args = parseArgs(input, this.maxResults);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const { pattern, file_type, max_results, path: searchPath } = args;
    const cwd = searchPath || ".";

    // Build fd arguments
    const fdArgs = buildFdArgs(args);
    const fdArgsStrs = fdArgs.map((s) => s);

    // Try fd first, fall back to find command
    let output;
    try {
      output = await execFileAsync("fd", fdArgsStrs, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      output = output.stdout;
    } catch {
      // Fallback: use `find` command
      output = await runFindFallback(pattern, file_type, cwd);
    }

    let files = output.trim().split("\n").filter(Boolean);

    // Sort by path for deterministic output
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
