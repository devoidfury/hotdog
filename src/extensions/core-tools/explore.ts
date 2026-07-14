// Explore tool — run the agent in explorer mode against a project directory.

import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolDef,
  param,
  ToolResult,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { logger } from "../../core/logger.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

// Resolve the path to the current binary (main.ts)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "hotdog");

export class ExploreTool {
  static readonly TOOL_NAME = "explore";

  toToolDef() {
    return toolDef(
      ExploreTool.TOOL_NAME,
      "Run the agent in explorer mode against a project directory. Executes the agent with the explorer profile and a prompt describing what to explore.",
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          path: param("string", "The root path of the project to explore"),
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

  async execute(input: string | Record<string, unknown> | null, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const args = this._parseArgs(input);

    // outline is required
    if (!args.outline || args.outline.trim().length === 0) {
      const error =
        "The 'outline' argument is required. Provide an outline of what you're specifically interested in or any particular questions you have.";
      return ToolResult.ok({
        error,
        path: args.path,
        outline: args.outline,
      }).withEntries({
        path: args.path,
        outline: args.outline,
      });
    }

    const prompt = `Explore project at '${args.path}'. ${args.outline}`;

    logger.debug(`Explore: ${BIN_PATH}`);
    // Build command: bun main.ts -c "<prompt>" --profile explorer
    const command = [
      BIN_PATH,
      "-c",
      prompt,
      "--profile",
      "explorer",
      "--hide-tools",
      "--hide-thinking",
    ];
    const cp: ChildProcess = spawn("bun", command, {
      cwd: args.path,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    cp.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    cp.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      cp.on("close", resolve);
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
