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
} from "../../core/extensions/tool-utils.ts";

import extensionData from "./extension.json";

export class BashTool {
  static TOOL_NAME = "bash";

  /**
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] - Command timeout in milliseconds.
   * @param {number} [options.maxOutputLines] - Maximum output lines.
   */
  constructor(options = {}) {
    this.timeoutMs =
      options.timeoutMs ??
      extensionData.configSchema.bashTool.properties.bashTimeoutMs.default;
    this.maxOutputLines =
      options.maxOutputLines ??
      extensionData.configSchema.bashTool.properties.maxToolOutputLines.default;
  }

  /**
   * Get tool definition for OpenAI API.
   * @returns {Object} Tool definition.
   */
  toToolDef() {
    return toolDef(
      BashTool.TOOL_NAME,
      "Execute a bash command. Returns stdout + stderr.",
      {
        properties: {
          command: param("string", "The shell command to execute."),
          timeoutMs: param("integer", "Optional timeout in milliseconds.", {
            default: this.timeoutMs,
          }),
        },
        required: ["command"],
      },
    );
  }

  /**
   * Get display string for tool call.
   * @param {string|Object|null} input - Tool input.
   * @returns {string} Display string.
   */
  callDisplay(input) {
    return defaultCallDisplay(input, (args) => `bash: ${args.command}`);
  }

  /**
   * Execute bash command.
   * @param {string|Object|null} input - Tool input with command field.
   * @param {Object} ctx - Tool context.
   * @returns {Promise<ToolResult>} Tool execution result.
   */
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
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(result);
      };

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const termTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        finish(ToolResult.err(`Command timed out after ${timeout}ms`));
      }, timeout);

      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        finish(ToolResult.err(`Command timed out after ${timeout}ms`));
      }, timeout + 2000); // give it a two second grace period before hard killing

      const cmdFirstLine = command.trim().split("\n")[0];
      proc.on("close", (code) => {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        const truncated = truncateOutput(output, this.maxOutputLines);
        finish(
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
        finish(ToolResult.err(`Error: ${err.message}`));
      });
    });
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

import { HOOKS } from "../../core/hooks.js";

/**
 * Create the bash-tool extension.
 *
 * @param {Object} core - The core object.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.bashTool || {};
  const timeoutMs = config.bashTimeoutMs;
  const maxOutputLines = config.maxToolOutputLines;

  return {
    hooks: {
      /**
       * Register the bash tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const tool = new BashTool({ timeoutMs, maxOutputLines });
        registry.register(BashTool.TOOL_NAME, tool);
      },
    },

    // Expose for external use
    BashTool,
  };
}
