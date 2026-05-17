// Bash tool — execute shell commands.

import { spawn, execFile } from "node:child_process";
import {
  ToolContext,
  toolDef,
  param,
  toolResult,
  truncateOutput,
} from "./registry.js";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_OUTPUT_LINES,
} from "../config.js";

export class BashTool {
  static TOOL_NAME = "bash";
  static FIRST_USE_HELP = `Use this tool to execute a shell command. The result is the stdout + stderr of the command.`;

  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || DEFAULT_BASH_TIMEOUT_MS;
    this.maxOutputLines =
      options.maxOutputLines || DEFAULT_MAX_TOOL_OUTPUT_LINES;
  }

  static tryNewFromContext(ctx) {
    return new BashTool({
      timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
      maxOutputLines: DEFAULT_MAX_TOOL_OUTPUT_LINES,
    });
  }

  toToolDef() {
    return toolDef(
      BashTool.TOOL_NAME,
      "Execute a bash command. Returns stdout + stderr.",
      {
        properties: {
          command: param("string", "The shell command to execute."),
          timeout_ms: param("integer", "Optional timeout in milliseconds."),
        },
        required: ["command"],
      },
    );
  }

  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    return `bash: ${args.command}`;
  }

  firstUseHelp() {
    return BashTool.FIRST_USE_HELP;
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const command = args.command;
    const timeout = args.timeout_ms || this.timeoutMs;

    if (!command) {
      return toolResult("Error: command is required");
    }

    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const termTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve(toolResult(`Command timed out after ${timeout}ms`));
      }, timeout);

      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(toolResult(`Command timed out after ${timeout}ms`));
      }, timeout + 2000); // give it a two second grace period before hard killing

      proc.on("close", (code) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        const output = [stdout, stderr].filter(Boolean).join("\n");
        resolve(toolResult(truncateOutput(output, this.maxOutputLines)));
      });

      proc.on("error", (err) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(toolResult(`Error: ${err.message}`));
      });
    });
  }
}
