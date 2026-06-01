// Bash tool — execute shell commands.

import { spawn } from "node:child_process";
import {
  toolDef,
  param,
  ToolResult,
  toolResult,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
} from "../../src/core/tool-registry.js";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_OUTPUT_LINES,
} from "../../src/config.js";

export class BashTool {
  static TOOL_NAME = "bash";

  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || DEFAULT_BASH_TIMEOUT_MS;
    this.maxOutputLines =
      options.maxOutputLines || DEFAULT_MAX_TOOL_OUTPUT_LINES;
  }

  toToolDef() {
    return toolDef(
      BashTool.TOOL_NAME,
      "Execute a bash command. Returns stdout + stderr.",
      {
        properties: {
          command: param("string", "The shell command to execute."),
          timeoutMs: param("integer", "Optional timeout in milliseconds.", {
            default: DEFAULT_BASH_TIMEOUT_MS,
          }),
        },
        required: ["command"],
      },
    );
  }

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => `bash: ${args.command}`);
  }

  async execute(input, ctx) {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }
    const command = args.command;
    // Support both camelCase (timeoutMs) and snake_case (timeout_ms)
    const timeout = args.timeoutMs ?? args.timeout_ms ?? this.timeoutMs;

    if (!command) {
      return ToolResult.err("Error: command is required");
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
        resolve(ToolResult.err(`Command timed out after ${timeout}ms`));
      }, timeout);

      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(ToolResult.err(`Command timed out after ${timeout}ms`));
      }, timeout + 2000); // give it a two second grace period before hard killing

      const cmdFirstLine = command.trim().split("\n")[0];
      proc.on("close", (code) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        const output = [stdout, stderr].filter(Boolean).join("\n");
        const truncated = truncateOutput(output, this.maxOutputLines);
        resolve(
          ToolResult.ok(truncated).withEntries({
            command:
              cmdFirstLine.length > 60
                ? cmdFirstLine.slice(0, 60) + "…"
                : cmdFirstLine,
            exit_code: String(code),
          }),
        );
      });

      proc.on("error", (err) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(ToolResult.err(`Error: ${err.message}`));
      });
    });
  }
}
