import { spawn, ChildProcess } from "node:child_process";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
  truncateOutput,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { AssistantRetryableError } from "@core/error.ts";
import { HOOKS } from "@core/hooks.ts";
import { CoreContext, ExtensionInstance, ToolContext, getExtensionConfig } from "@core/extensions/types.ts";
import { copyScrubbedEnv } from "@utils/env.ts";
import { OWN_PROCESS_GROUP, killProcessGroup } from "@utils/process-group.ts";

/**
 * Hard cap on in-memory output buffering per stream. truncateOutput()
 * still applies the line-based display cap afterwards; this only prevents
 * a chatty command (e.g. `yes`) from exhausting memory before the timeout
 * fires. Known ceiling: a single line longer than the cap is kept whole.
 */
const MAX_OUTPUT_CHARS = 1_000_000;

/** Grace period between SIGTERM and SIGKILL on timeout, in ms. */
const KILL_GRACE_MS = 2000;

interface BashToolOptions {
  timeoutMs: number;
  maxOutputLines: number;
  /** Hard cap on a model-requested timeoutMs (config: bashTool.maxTimeoutMs). */
  maxTimeoutMs?: number;
}

/**
 * Sanitize and clamp the model-provided timeout. The value comes from the
 * model, so it is untrusted input: 0/negative/NaN/strings would misfire the
 * kill timers, and unbounded values would disable the timeout. Invalid
 * values fall back to the configured default; valid ones are clamped to
 * [1, maxTimeoutMs] when a cap is configured.
 */
export function resolveBashTimeout(
  requested: unknown,
  defaultMs: number,
  maxMs?: number,
): number {
  const validMs = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  let timeout = validMs(requested) ? requested : defaultMs;
  if (validMs(maxMs) && timeout > maxMs) timeout = maxMs;
  return Math.max(1, timeout);
}

export class BashTool {
  static readonly TOOL_NAME = "bash";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  readonly timeoutMs: number;
  readonly maxOutputLines: number;
  readonly maxTimeoutMs?: number;

  constructor(options: BashToolOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxOutputLines = options.maxOutputLines;
    this.maxTimeoutMs = options.maxTimeoutMs;
  }

  toToolDef() {
    const capNote = this.maxTimeoutMs ? ` Capped at ${this.maxTimeoutMs}ms.` : "";
    return toolDef(BashTool.TOOL_NAME, `Execute a bash command from the current working directory.`, {
      properties: {
        command: param("string", "The shell command to execute."),
        timeoutMs: param("integer", `Optional timeout in milliseconds.${capNote}`, {
          default: this.timeoutMs,
        }),
      },
      required: ["command"],
    });
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `bash: ${args.command as string}`);
  }

  async execute(input: string | Record<string, unknown> | null, _ctx: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }
    const command = args.command as string;
    const timeout = resolveBashTimeout(
      args.timeoutMs ?? args.timeout_ms ?? this.timeoutMs,
      this.timeoutMs,
      this.maxTimeoutMs,
    );

    if (!command) {
      return ToolResult.err("Error: command is required");
    }

    return new Promise((resolve, reject) => {
      const proc: ChildProcess = spawn(command, [], {
        shell: true,
        // Own process group on POSIX so timeouts can kill the entire tree
        // (see utils/process-group.ts for the trade-off).
        ...OWN_PROCESS_GROUP,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...copyScrubbedEnv(),
          // enable agent-friendly test output in bun test, maybe others
          AGENT: "hotdog",
          HOTDOG: "1",
          // prior art -- used for automated builds, exporting this ensures
          // that compilers, interactive CLIs, and scripts suppress blocking
          // prompt traps (Press any key to continue...), escape sequences, colors
          CI: "true",
          TERM: "dumb",
          NO_COLOR: "1",
          EDITOR: "cat",
          // prevent git from opening a blocking nano/vim/etc prompt during a commit
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "cat",
          GIT_PAGER: "cat",
          // this is only here because it changes some behavior in programs like bun test to be more desirable.
          // https://bun.com/docs/test#ai-agent-integration
          CLAUDECODE: "1",
        },
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let done = false;
      let timedOut = false;
      let termTimer: ReturnType<typeof setTimeout>;
      let killTimer: ReturnType<typeof setTimeout>;

      /**
       * Settle the promise exactly once. Deliberately does NOT clear the
       * kill timer: after SIGTERM the group may still be alive, so the
       * SIGKILL escalation must stay armed until the group actually exits.
       */
      const finish = (result: ToolResult | Error) => {
        if (done) return;
        done = true;
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const appendCapped = (
        current: string,
        chunk: string,
        truncated: boolean,
      ): { value: string; truncated: boolean } => {
        if (truncated) return { value: current, truncated: true };
        const value = current + chunk;
        if (value.length > MAX_OUTPUT_CHARS) {
          return { value: value.slice(0, MAX_OUTPUT_CHARS), truncated: true };
        }
        return { value, truncated: false };
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        const r = appendCapped(stdout, chunk.toString(), stdoutTruncated);
        stdout = r.value;
        stdoutTruncated = r.truncated;
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const r = appendCapped(stderr, chunk.toString(), stderrTruncated);
        stderr = r.value;
        stderrTruncated = r.truncated;
      });

      termTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc, "SIGTERM");
        finish(
          AssistantRetryableError.WithHint(
            `Command timed out after ${timeout}ms`,
            "Use a faster command, or increase timeoutMs in the tool call.",
          ),
        );
      }, timeout);

      // Give it a two second grace period before hard killing. This timer
      // must outlive finish() -- see finish() for why.
      killTimer = setTimeout(() => {
        killProcessGroup(proc, "SIGKILL");
        finish(
          AssistantRetryableError.WithHint(
            `Command timed out after ${timeout}ms`,
            "Use a faster command, add a timeout flag (e.g., `timeout 10s ...`), or increase timeoutMs in the tool call.",
          ),
        );
      }, timeout + KILL_GRACE_MS);

      const cmdFirstLine = command.trim().split("\n")[0] ?? "";
      proc.on("close", (code: number | null) => {
        // "close" only means the SHELL exited -- group members can outlive
        // it (e.g. they trap TERM). So after a timeout the SIGKILL
        // escalation stays armed; a dead group just makes it a no-op.
        clearTimeout(termTimer);
        if (!timedOut) clearTimeout(killTimer);
        if (done) return; // already settled by a timeout; output not needed
        let output = [stdout, stderr].filter(Boolean).join("\n");
        if (stdoutTruncated || stderrTruncated) {
          output += "\n[output truncated]";
        }
        const truncated = truncateOutput(output, this.maxOutputLines);
        finish(
          ToolResult.ok(truncated).withEntries({
            command: cmdFirstLine.length > 60 ? cmdFirstLine.slice(0, 60) + "…" : cmdFirstLine,
            exit_code: String(code),
          }),
        );
      });

      proc.on("error", (err: Error) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        finish(ToolResult.err(`Error: ${err.message}`));
      });
    });
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<{
    bashTimeoutMs: number;
    maxToolOutputLines: number;
    maxTimeoutMs?: number;
  }>(core, "bashTool");
  const timeoutMs = config.bashTimeoutMs;
  const maxOutputLines = config.maxToolOutputLines;
  const maxTimeoutMs = config.maxTimeoutMs;

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const tool = new BashTool({ timeoutMs, maxOutputLines, maxTimeoutMs });
        registry.register(BashTool.TOOL_NAME, tool);
      },
    },

    // Expose for external use
    BashTool,
  };
}
