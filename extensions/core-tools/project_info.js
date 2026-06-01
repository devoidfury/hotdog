// Project Info tool — compact project structure overview.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import util from "node:util";
import { toolDef, param, ToolResult, toolResult, defaultCallDisplay } from "../../src/core/tool-registry.js";
import {
  DEFAULT_MAX_TOOL_OUTPUT_LINES,
  DEFAULT_READ_TOOL_LIMIT,
  DEFAULT_GREP_MAX_RESULTS,
} from "../../src/config.js";

const execFileAsync = util.promisify(execFile);

const DEFAULT_DU_DEPTH = 1;

export class ProjectInfoTool {
  static TOOL_NAME = "project_info";

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

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const p = args.path || ".";
      const d = args.max_depth;
      const f = args.max_files;
      if (d && f) return `(path=${p}, depth=${d}, files=${f})`;
      if (d) return `(path=${p}, depth=${d})`;
      if (f) return `(path=${p}, files=${f})`;
      return `(path=${p})`;
    });
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const cwd = args.path || ".";
    const maxDepth = args.max_depth || DEFAULT_DU_DEPTH;
    const maxFiles = args.max_files || DEFAULT_GREP_MAX_RESULTS;

    // Resolve working directory
    let workdir;
    try {
      workdir = path.resolve(cwd);
    } catch {
      return ToolResult.err(`Error: invalid path ${cwd}`);
    }

    // Check if directory exists
    let dirExists;
    try {
      dirExists = fs.statSync(cwd).isDirectory();
    } catch {
      dirExists = false;
    }

    if (!dirExists) {
      return ToolResult.err(`=== Project Info ===\nDirectory not found: ${cwd}`);
    }

    // Try git ls-files
    let gitFiles;
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
        .filter((l) => l.trim())
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
    const dirSizes = await this._getDirSizes(maxDepth, workdir);

    // Build output
    const lines = [];
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

  async _partialInfo(workdir, cwd, maxDepth, maxFiles) {
    const lines = [];
    lines.push("=== Project Info ===");
    lines.push(`Dir: ${workdir} (not a git repo)`);
    lines.push("");

    // List files manually
    const files = this._listFilesRecursively(cwd, maxDepth, maxFiles);
    if (files.length > 0) {
      lines.push("── Files ──────────────────────────────");
      for (const f of files) {
        lines.push(`  ${f}`);
      }
      lines.push("");
    }

    // Directory sizes
    const dirSizes = await this._getDirSizes(maxDepth, cwd);
    const filteredSizes = dirSizes.filter(([, p]) => {
      if (p === ".") return true;
      const clean = p.replace(/^\.\//, "");
      return !clean.startsWith(".");
    });
    if (filteredSizes.length > 0) {
      lines.push("── Directories ────────────────────────");
      for (const [size, dirPath] of filteredSizes) {
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

  _listFilesRecursively(base, maxDepth, maxFiles) {
    const results = [];
    this._walkDir(base, 0, maxDepth, results, maxFiles);
    return results;
  }

  _walkDir(dir, depth, maxDepth, results, maxFiles) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const relPath = path.relative(".", fullPath);
          results.push(relPath);
        } else if (entry.isDirectory()) {
          this._walkDir(fullPath, depth + 1, maxDepth, results, maxFiles);
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  async _getGitBranch(cwd) {
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

  async _getLastCommitTime(cwd) {
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

  async _getGitStatus(cwd) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => [l.slice(0, 2).trim(), l.slice(3)])
        .filter(([, f]) => f);
    } catch {
      return [];
    }
  }

  async _getDirSizes(maxDepth, cwd) {
    try {
      const { stdout } = await execFileAsync(
        "du",
        ["--max-depth", String(maxDepth), "-h", "."],
        { cwd, maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const parts = l.split("\t");
          return [parts[0] || "", parts[1] || ""];
        });
    } catch {
      return [];
    }
  }

  _countByLanguage(files) {
    const counts = {};
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

function extensionToLanguage(ext) {
  const map = {
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
  return map[ext] || "Other";
}
