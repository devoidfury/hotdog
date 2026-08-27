import { spawn as _spawn, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolDef,
  param,
  ToolResult,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { logger } from "../../core/logger.ts";
import { ToolContext } from "../../core/extensions/types.ts";
import { PathEscapeError, Workspace } from "../../utils/workspace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "hotdog");

export type SpawnFn = typeof _spawn;

export class ExploreTool {
  static readonly TOOL_NAME = "explore";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 4 };

  private readonly spawnFn: SpawnFn;

  // spawnFn is injectable for testing.
  constructor(spawnFn: SpawnFn = _spawn) {
    this.spawnFn = spawnFn;
  }

  toToolDef() {
    return toolDef(
      ExploreTool.TOOL_NAME,
      "Run the agent in explorer mode against a project directory. Executes the agent with the explorer profile and a prompt describing what to explore.",
      {
        properties: {
          path: param("string", "The root path of the project to explore. Resolved against the workspace boundary; escapes are rejected. Path relative to the workspace root, or an absolute path inside a configured workspace root."),
          outline: param(
            "string",
            "An outline of what you are specifically interested in or any particular questions you have",
          ),
        },
        required: ["path", "outline"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args: Record<string, unknown>) => {
        const p = args.path || ".";
        const o = args.outline || "";
        return `path=${p} -> ${o}`;
      },
      { fallback: "path=.", returnRawOnParseError: true },
    );
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const args = this._parseArgs(input);

    if (!args.outline || args.outline.trim().length === 0) {
      const error =
        "The 'outline' argument is required. Provide an outline of what you're specifically interested in or any particular questions you have.";
      return ToolResult.err(error).withEntries({
        path: args.path,
        outline: args.outline,
      });
    }

    // The spawned sub-agent runs with this directory as its CWD (and thus its
    // own workspace boundary), so the target must stay inside the parent
    // boundary or an LLM-supplied path could relocate the whole sub-agent.
    const workspace = ctx.get("workspace") as Workspace;

    let targetDir: string;
    try {
      targetDir = workspace.resolveSafe(args.path);
    } catch (e: unknown) {
      if (e instanceof PathEscapeError) {
        return ToolResult.err(e.message).withEntries({
          path: args.path,
          outline: args.outline,
        });
      }
      return ToolResult.err(`Error resolving path: ${(e as Error).message}`).withEntries({
        path: args.path,
        outline: args.outline,
      });
    }

    // Fail fast on bad targets instead of letting the sub-agent boot and die.
    let targetStat;
    try {
      targetStat = await fs.stat(targetDir);
    } catch {
      return ToolResult.err(`Directory not found: '${args.path}'`).withEntries({
        path: args.path,
        outline: args.outline,
      });
    }
    if (!targetStat.isDirectory()) {
      return ToolResult.err(`Not a directory: '${args.path}'`).withEntries({
        path: args.path,
        outline: args.outline,
      });
    }

    const prompt = `Explore project at '${targetDir}'. ${args.outline}`;

    logger.debug(`Explore: ${BIN_PATH}`);
    const command = [
      BIN_PATH,
      "-p",
      prompt,
      "--profile",
      "explorer",
      "--hide-tools",
      "--hide-thinking",
    ];
    const proc: ChildProcess = this.spawnFn("bun", command, {
      cwd: targetDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", resolve);
    });

    if (exitCode !== 0) {
      return ToolResult.err(
        stderr.trim() || `Explorer exited with code ${exitCode}`,
      ).withEntries({
        path: args.path,
        outline: args.outline,
        command: command.join(" "),
        exit_code: String(exitCode),
      });
    }

    return ToolResult.ok(stdout.trim()).withEntries({
      path: args.path,
      outline: args.outline,
      command: command.join(" "),
      exit_code: String(exitCode),
      content_length: String(stdout.length),
    });
  }

  private _parseArgs(input: string | Record<string, unknown> | null): { path: string; outline: string } {
    if (!input || (typeof input === "string" && input.trim().length === 0)) {
      return { path: ".", outline: "" };
    }

    let json: Record<string, unknown>;
    if (typeof input === "string") {
      try {
        json = JSON.parse(input);
      } catch {
        return { path: ".", outline: input };
      }
    } else {
      json = input;
    }

    return {
      path: typeof json.path === "string" ? json.path : ".",
      outline: typeof json.outline === "string" ? json.outline : "",
    };
  }
}
