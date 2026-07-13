// Bash tool — execute shell commands.

import { spawn, ChildProcess } from "node:child_process";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { HOOKS } from "../../core/hooks.ts";
import extensionData from "./extension.json" with { type: "json" };
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  ToolExecutionContext,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

interface BashToolOptions {
  timeoutMs?: number;
  maxOutputLines?: number;
}

interface BashToolConfig {
  bashTool?: {
    properties: {
      bashTimeoutMs: { default: number };
      maxToolOutputLines: { default: number };
    };
  };
}

export class BashTool {
  static readonly TOOL_NAME = "bash";

  readonly timeoutMs: number;
  readonly maxOutputLines: number;

  constructor(options: BashToolOptions = {}) {
    const config = extensionData.configSchema as BashToolConfig;
    this.timeoutMs =
      options.timeoutMs ??
      config.bashTool?.properties.bashTimeoutMs.default;
    this.maxOutputLines =
      options.maxOutputLines ??
      config.bashTool?.properties.maxToolOutputLines.default;
  }

  toToolDef(): Record<string, unknown> {
    return toolDef(
      BashTool.TOOL_NAME,
      `Execute a bash command, from the working directory '${process.cwd()}'`,
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

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `bash: ${args.command as string}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolExecutionContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }
    const command = args.command as string;
    // Support both camelCase (timeoutMs) and snake_case (timeout_ms)
    const timeout = (args.timeoutMs as number) ?? (args.timeout_ms as number) ?? this.timeoutMs;

    if (!command) {
      return ToolResult.err("Error: command is required");
    }

    return new Promise((resolve) => {
      const proc: ChildProcess = spawn(command, [], {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // enable agent-friendly test output in bun test, maybe others
          // https://bun.com/docs/test#ai-agent-integration
          AGENT: "1",
          CLAUDECODE: "1",
          // prior art -- used for automated builds, exporting this ensures
          // that compilers, interactive CLIs, and scripts suppress blocking
          // prompt traps (Press any key to continue...), escape sequences, colors
          CI: "true",
          TERM: "dumb",
          NO_COLOR: "1",
          // prevent git from opening a blocking nano/vim/etc prompt during a commit
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "cat",
        },
      });

      let stdout = "";
      let stderr = "";
      let done = false;

      const finish = (result: ToolResult) => {
        if (done) return;
        done = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(result);
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
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
      proc.on("close", (code: number | null) => {
        const output = [stdout, stderr].filter(Boolean).join("\n");
        const truncated = this.truncateOutput(output, this.maxOutputLines);
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

      proc.on("error", (err: Error) => {
        finish(ToolResult.err(`Error: ${err.message}`));
      });
    });
  }

  private truncateOutput(text: string, maxLines: number): string {
    if (!text) return "";
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    const truncated = lines.slice(0, maxLines).join("\n");
    return `${truncated}\n--- [truncated, ${lines.length - maxLines} more lines] ---`;
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the bash-tool extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig(core, "bashTool");
  const timeoutMs = config.bashTimeoutMs as number | undefined;
  const maxOutputLines = config.maxToolOutputLines as number | undefined;

  return {
    hooks: {
      /**
       * Register the bash tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        const tool = new BashTool({ timeoutMs, maxOutputLines });
        registry.register(BashTool.TOOL_NAME, tool);
      },
    },

    // Expose for external use
    BashTool,
  };
}
