// Explore tool — run the agent in explorer mode against a project directory.
// Mirrors Rust: oa-agent/src/tools/explore/mod.rs

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolContext, toolDef, param, toolResult } from "./registry.js";

const execFileAsync = import("node:util").then((util) =>
  util.promisify(execFile),
);

// Resolve the path to the current binary (main.js)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "..", "main.js");

export class ExploreTool {
  static TOOL_NAME = "explore";

  static tryNewFromContext(ctx) {
    return new ExploreTool();
  }

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
        required: [],
      },
    );
  }

  firstUseHelp() {
    return "Run the agent in explorer mode against a project directory. Executes the agent with the explorer profile and a prompt describing what to explore.";
  }

  callDisplay(input) {
    if (!input || (typeof input === "string" && input.trim().length === 0)) {
      return "path=.";
    }
    try {
      const args = typeof input === "string" ? JSON.parse(input) : input;
      const p = args.path || ".";
      const o = args.outline || "";
      return `path=${p} -> ${o}`;
    } catch {
      return input.toString();
    }
  }

  async execute(input, ctx) {
    const args = this._parseArgs(input);

    // outline is required
    if (!args.outline || args.outline.trim().length === 0) {
      const error =
        "The 'outline' argument is required. Provide an outline of what you're specifically interested in or any particular questions you have.";
      return toolResult({
        error,
        path: args.path,
        outline: args.outline,
      });
    }

    const prompt = `Explore project at '${args.path}'. ${args.outline}`;
    const command = `node ${BIN_PATH} -c "${args.outline}" --profile explorer`;

    // Build command: node main.js -c "<prompt>" --profile explorer
    const childProcess = await import("node:child_process");
    const cp = childProcess.spawn(
      "node",
      [
        BIN_PATH,
        "-c",
        prompt,
        "--profile",
        "explorer",
        "--hide-tools",
        "--hide-thinking",
      ],
      {
        cwd: args.path,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

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
      return toolResult({
        error: stderr.trim() || `Explorer exited with code ${exitCode}`,
        path: args.path,
        outline: args.outline,
        command,
      });
    }

    return toolResult({
      content: stdout.trim(),
      path: args.path,
      outline: args.outline,
      command,
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
