// Explore tool — run the agent in explorer mode against a project directory.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolDef, param, ToolResult, toolResult, defaultCallDisplay } from "./registry.js";

// Resolve the path to the current binary (main.js)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "..", "..", "src", "main.js");

export class ExploreTool {
  static TOOL_NAME = "explore";

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

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const p = args.path || ".";
      const o = args.outline || "";
      return `path=${p} -> ${o}`;
    }, { fallback: "path=.", returnRawOnParseError: true });
  }

  async execute(input, ctx) {
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

    // Build command: bun main.js -c "<prompt>" --profile explorer
    const command = [
      BIN_PATH,
      "-c",
      prompt,
      "--profile",
      "explorer",
      "--hide-tools",
      "--hide-thinking",
    ];
    const cp = spawn("bun", command, {
      cwd: args.path,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    cp.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    cp.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const exitCode = await new Promise((resolve) => {
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

    return ToolResult.ok({
      content: stdout.trim(),
      path: args.path,
      outline: args.outline,
      command: command.join(" "),
    }).withEntries({
      path: args.path,
      outline: args.outline,
      command: command.join(" "),
      exit_code: String(exitCode),
      content_length: String(stdout.length),
    });
  }

  _parseArgs(input) {
    if (!input || (typeof input === "string" && input.trim().length === 0)) {
      return { path: ".", outline: "" };
    }

    let json;
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
