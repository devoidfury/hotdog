// Project Info tool — compact project structure overview.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import util from "node:util";
import { toolDef, param, ToolResult, defaultCallDisplay } from "../../core/extensions/tool-utils.ts";
import { DEFAULT_GREP_MAX_RESULTS } from "./defaults.ts";
import { correctCommonPathMistakes } from "../../utils/file-utils.ts";
import { compileGitignore } from "../../utils/gitignore.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

const execFileAsync = util.promisify(execFile);

const DEFAULT_DU_DEPTH = 1;

export class ProjectInfoTool {
  static readonly TOOL_NAME = "project_info";

  toToolDef() {
    return toolDef(
      ProjectInfoTool.TOOL_NAME,
      "Get a compact overview of the project structure, file list, sizes, and git status for a directory.",
      {
        properties: {
          path: param(
            "string",
            "Path to the directory to analyze. Defaults to current directory.",
          ),
          max_depth: param("integer", "Max directory depth for du.", {
            default: DEFAULT_DU_DEPTH,
          }),
          max_files: param("integer", "Max files to list.", {
            default: DEFAULT_GREP_MAX_RESULTS,
          }),
        },
        required: [],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => {
      const p = args.path || ".";
      const d = args.max_depth;
      const f = args.max_files;
      if (d && f) return `(path=${p}, depth=${d}, files=${f})`;
      if (d) return `(path=${p}, depth=${d})`;
      if (f) return `(path=${p}, files=${f})`;
      return `(path=${p})`;
    });
  }

  async execute(input: string | Record<string, unknown> | null, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const args: Record<string, unknown> = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
    let cwd = args.path as string || ".";
    const maxDepth = args.max_depth as number || DEFAULT_DU_DEPTH;
    const maxFiles = args.max_files as number || DEFAULT_GREP_MAX_RESULTS;

    [cwd] = correctCommonPathMistakes(cwd);

    // Resolve working directory
    let workdir: string;
    try {
      workdir = path.resolve(cwd);
    } catch {
      return ToolResult.err(`Error: invalid path ${cwd}`);
    }

    // Check if directory exists
    let dirExists: boolean;
    try {
      const stats = await fs.stat(cwd);
      dirExists = stats.isDirectory();
    } catch {
      dirExists = false;
    }

    if (!dirExists) {
      return ToolResult.err(`=== Project Info ===\nDirectory not found: ${cwd}`);
    }

    // Try git ls-files
    let gitFiles: string[];
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "ls-files",
          "--cached",
          "--modified",
          "--other",
          "--exclude-standard",
          "--deduplicate",
        ],
        { cwd: workdir, maxBuffer: 10 * 1024 * 1024 },
      );
      gitFiles = stdout
        .split("\n")
        .filter((l: string) => l.trim())
        .sort();
    } catch {
      // Not a git repo or git unavailable — partial info
      return this._partialInfo(workdir, cwd, maxDepth, maxFiles);
    }

    if (gitFiles.length === 0) {
      return ToolResult.ok("=== Project Info ===\nNo files found.").withEntries({
        path: workdir,
        file_count: "0",
      });
    }

    // Gather metadata
    const branch = await this._getGitBranch(workdir);
    const lastCommit = await this._getLastCommitTime(workdir);
    const gitStatus = await this._getGitStatus(workdir);
    const langs = this._countByLanguage(gitFiles);
    const gitignoreFilter = await this._loadGitignoreFilter(workdir);
    const dirSizes = await this._getDirSizes(maxDepth, workdir, gitignoreFilter);

    // Build output
    const lines: string[] = [];
    lines.push("=== Project Info ===");

    const gitInfo = branch ? `git (${branch})` : "git";
    const commitInfo = lastCommit ? `, last commit: ${lastCommit}` : "";
    lines.push(
      `Dir: ${workdir} | Files: ${gitFiles.length} | ${gitInfo}:${commitInfo}`,
    );
    lines.push("");

    // File list
    lines.push("── Files ──────────────────────────────");
    const displayFiles = gitFiles.slice(0, maxFiles);
    for (const f of displayFiles) {
      lines.push(`  ${f}`);
    }
    if (gitFiles.length > maxFiles) {
      lines.push(
        `  ... and ${gitFiles.length - maxFiles} more (use max_files to show more)`,
      );
    }
    lines.push("");

    // Directory sizes
    if (dirSizes.length > 0) {
      lines.push("── Directories ────────────────────────");
      for (const [size, dirPath] of dirSizes) {
        const displayPath =
          dirPath === "." ? "." : dirPath.replace(/^\.\//, "");
        lines.push(`${size}  ${displayPath}`);
      }
      lines.push("");
    }

    // Git status
    if (gitStatus.length > 0) {
      lines.push("── Git Status ─────────────────────────");
      for (const [status, file] of gitStatus) {
        lines.push(`${status}  ${file}`);
      }
      lines.push("");
    }

    // Language breakdown
    if (langs.length > 0) {
      lines.push("── Languages ──────────────────────────");
      for (const [lang, count] of langs) {
        const pct = ((count / gitFiles.length) * 100).toFixed(0).padStart(4);
        lines.push(`${lang}: ${count} files (${pct}%)`);
      }
      lines.push("");
    }

    return ToolResult.ok(lines.join("\n")).withEntries({
      path: workdir,
      file_count: String(gitFiles.length),
      ...(branch ? { branch } : {}),
      ...(lastCommit ? { last_commit: lastCommit } : {}),
    });
  }

  private async _partialInfo(workdir: string, cwd: string, maxDepth: number, maxFiles: number): Promise<ToolResult> {
    const lines: string[] = [];
    lines.push("=== Project Info ===");
    lines.push(`Dir: ${workdir} (not a git repo)`);
    lines.push("");

    // List files manually
    const files = await this._listFilesRecursively(cwd, maxDepth, maxFiles);
    if (files.length > 0) {
      lines.push("── Files ──────────────────────────────");
      for (const f of files) {
        lines.push(`  ${f}`);
      }
      lines.push("");
    }

    // Directory sizes
    const gitignoreFilter = await this._loadGitignoreFilter(cwd, []);
    const dirSizes = await this._getDirSizes(maxDepth, cwd, gitignoreFilter);
    if (dirSizes.length > 0) {
      lines.push("── Directories ────────────────────────");
      for (const [size, dirPath] of dirSizes) {
        const displayPath =
          dirPath === "." ? "." : dirPath.replace(/^\.\//, "");
        lines.push(`${size}  ${displayPath}`);
      }
      lines.push("");
    }

    // Language breakdown
    if (files.length > 0) {
      const langs = this._countByLanguage(files);
      if (langs.length > 0) {
        lines.push("── Languages ──────────────────────────");
        for (const [lang, count] of langs) {
          const pct = ((count / files.length) * 100).toFixed(0).padStart(4);
          lines.push(`${lang}: ${count} files (${pct}%)`);
        }
        lines.push("");
      }
    }

    return ToolResult.ok(lines.join("\n")).withEntries({
      path: workdir,
      file_count: String(files.length),
      git_repo: "false",
    });
  }

  private async _listFilesRecursively(base: string, maxDepth: number, maxFiles: number): Promise<string[]> {
    const results: string[] = [];
    await this._walkDir(base, 0, maxDepth, results, maxFiles);
    return results;
  }

  private async _walkDir(dir: string, depth: number, maxDepth: number, results: string[], maxFiles: number): Promise<void> {
    if (depth > maxDepth || results.length >= maxFiles) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const relPath = path.relative(".", fullPath);
          results.push(relPath);
        } else if (entry.isDirectory()) {
          await this._walkDir(fullPath, depth + 1, maxDepth, results, maxFiles);
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  private async _getGitBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        {
          cwd,
          maxBuffer: 1024 * 1024,
        },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async _getLastCommitTime(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%ar"],
        {
          cwd,
          maxBuffer: 1024 * 1024,
        },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async _getGitStatus(cwd: string): Promise<[string, string][]> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => [l.slice(0, 2).trim(), l.slice(3)])
        .filter(([, f]) => f) as [string, string][];
    } catch {
      return [];
    }
  }

  private async _getDirSizes(
    maxDepth: number,
    cwd: string,
    shouldInclude?: (path: string) => boolean,
  ): Promise<[string, string][]> {
    try {
      const { stdout } = await execFileAsync(
        "du",
        ["--max-depth", String(maxDepth), "-h", "."],
        { cwd, maxBuffer: 10 * 1024 * 1024 },
      );
      let entries = stdout
        .split("\n")
        .filter((l: string) => l.trim())
        .map((l: string) => {
          const parts = l.split("\t");
          return [parts[0] || "", parts[1] || ""] as [string, string];
        });

      if (shouldInclude) {
        entries = entries.filter(([, dirPath]) => shouldInclude(dirPath));
      }

      return entries;
    } catch {
      return [];
    }
  }

  private async _loadGitignoreFilter(
    cwd: string,
    implicitPatterns: string[] = [".git"],
  ): Promise<((path: string) => boolean) | undefined> {
    try {
      const gitignorePath = path.join(cwd, ".gitignore");
      const content = await fs.readFile(gitignorePath, "utf-8");
      return compileGitignore(content, { implicitPatterns });
    } catch {
      // No .gitignore file — use implicit patterns only
      if (implicitPatterns.length > 0) {
        return compileGitignore("", { implicitPatterns });
      }
      return undefined;
    }
  }

  private _countByLanguage(files: string[]): [string, number][] {
    const counts: Record<string, number> = {};
    for (const file of files) {
      const ext = file.split(".").pop();
      const lang = extensionToLanguage(ext);
      counts[lang] = (counts[lang] || 0) + 1;
    }
    return Object.entries(counts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }
}

function extensionToLanguage(ext: string | undefined): string {
  const map: Record<string, string> = {
    rs: "Rust",
    py: "Python",
    js: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    ts: "TypeScript",
    tsx: "TypeScript",
    "d.ts": "TypeScript",
    go: "Go",
    java: "Java",
    cpp: "C++",
    cc: "C++",
    cxx: "C++",
    c: "C",
    h: "C/C++ Header",
    rb: "Ruby",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    kts: "Kotlin",
    scala: "Scala",
    ex: "Elixir",
    exs: "Elixir",
    erl: "Erlang",
    hrl: "Erlang",
    hs: "Haskell",
    toml: "TOML",
    yaml: "YAML",
    yml: "YAML",
    json: "JSON",
    xml: "XML",
    html: "HTML",
    htm: "HTML",
    css: "CSS",
    scss: "CSS",
    sass: "CSS",
    md: "Markdown",
    mdx: "Markdown",
    sh: "Shell",
    dockerfile: "Dockerfile",
    tf: "HCL",
    proto: "Protobuf",
    sql: "SQL",
    env: "Env",
  };
  return ext ? (map[ext] || "Other") : "Other";
}
