import { spawn, ChildProcess } from "node:child_process";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
  truncateOutput,
} from "@core/extensions/tool-utils.ts";
import { HOOKS } from "@core/hooks.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { AssistantRetryableError } from "@core/error.ts";
import { CoreContext, ExtensionInstance, ToolContext, getExtensionConfig } from "@core/extensions/types.ts";
import { copyScrubbedEnv } from "@utils/env.ts";
import { spawnSandboxed, fenceConfigFor, sysboxMemoryKillNote } from "@utils/sysbox/index.ts";
import { detectCapabilities, type SysboxCapabilities } from "@utils/sysbox/capabilities.ts";
import { ConfigError, formatError } from "@core/error.ts";
import type { Workspace } from "@utils/workspace.ts";
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
  /** Kernel gate level (config: bashTool.sandbox). off | static | fence. */
  sandbox?: SandboxMode;
}

export type SandboxMode = "off" | "static" | "fence";

/**
 * Env for agent-spawned commands, shared by the plain and sandboxed paths so
 * the two cannot drift. Scrubbed base: the model-reachable child must not
 * carry hotdog's own secrets (see utils/env.ts).
 */
export function agentSpawnEnv(): Record<string, string> {
  return {
    ...copyScrubbedEnv(process.env),
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
  } as Record<string, string>;
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
  readonly sandbox: SandboxMode;

  constructor(options: BashToolOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxOutputLines = options.maxOutputLines;
    this.maxTimeoutMs = options.maxTimeoutMs;
    this.sandbox = options.sandbox ?? "off";
  }

  toToolDef() {
    const capNote = this.maxTimeoutMs ? ` Capped at ${this.maxTimeoutMs}ms.` : "";
    return toolDef(BashTool.TOOL_NAME, `Execute a bash command from primary workspace root. Returns combined stdout/stderr. shell state (cwd, env vars, background jobs) does not persist between calls.`, {
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

  async execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err(
        "Error parsing arguments: expected a JSON object with a required 'command' string (optional: timeoutMs)",
      );
    }
    // Run from the primary workspace root, not the process CWD: the tool
    // description promises the root, and with workspace.paths pointing
    // elsewhere a process-CWD spawn silently executes outside every
    // declared root. Falls back to the process CWD only when no workspace
    // is on the context (standalone/test callers). `?.` on get: bare-object
    // ctx doubles in tests expose no methods.
    const workspace = ctx?.get?.("workspace") as Workspace | undefined;
    const cwd = workspace?.root;
    const command = args.command as string;
    const timeout = resolveBashTimeout(
      args.timeoutMs ?? args.timeout_ms ?? this.timeoutMs,
      this.timeoutMs,
      this.maxTimeoutMs,
    );

    if (!command) {
      return ToolResult.err("Error: command is required");
    }

    // Spawn per sandbox mode. The sysbox helper exec's sh after installing
    // its filters, so in both sandboxed paths the pid is the command's
    // process-group leader exactly like the plain detached spawn, and every
    // handler below is shared.
    let proc: ChildProcess;
    if (this.sandbox === "fence") {
      // Refuse rather than downgrade: fence roots come from the workspace, and
      // a fence without roots is not a fence (fail-closed invariant).
      if (!workspace) {
        return ToolResult.err('bashTool.sandbox="fence" requires a workspace on the tool context; refusing to run');
      }
      try {
        proc = spawnSandboxed({
          command,
          cwd: cwd ?? null,
          env: agentSpawnEnv(),
          fence: fenceConfigFor(workspace),
        });
      } catch (e) {
        return ToolResult.err(`sysbox fence spawn failed (command did not run): ${formatError(e)}`);
      }
    } else if (this.sandbox === "static") {
      proc = spawnSandboxed({ command, cwd: cwd ?? null, env: agentSpawnEnv() });
    } else {
      proc = spawn(command, [], {
        shell: true,
        // Primary workspace root (see execute); undefined inherits the
        // process CWD, preserving the standalone-caller behavior.
        cwd,
        // Own process group on POSIX so timeouts can kill the entire tree (see utils/process-group.ts for the trade-off).
        ...OWN_PROCESS_GROUP,
        // ignore keeps stdin-reading commands (`cat`, `read`, `python -c "input()"`) from hanging until the timeout.
        stdio: ["ignore", "pipe", "pipe"],
        env: agentSpawnEnv(),
      });
    }

    return new Promise((resolve, reject) => {

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

      // Stateful decoders per stream: a multibyte UTF-8 sequence split across
      // two read boundaries would decode to U+FFFD with per-chunk toString().
      // Matches the TextDecoder pattern in utils/fetch.ts readCappedBody.
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();

      proc.stdout?.on("data", (chunk: Buffer) => {
        const r = appendCapped(stdout, stdoutDecoder.decode(chunk, { stream: true }), stdoutTruncated);
        stdout = r.value;
        stdoutTruncated = r.truncated;
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const r = appendCapped(stderr, stderrDecoder.decode(chunk, { stream: true }), stderrTruncated);
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
        // Flush any trailing sequence held by the stream decoders before use.
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
        let output = [stdout, stderr].filter(Boolean).join("\n");
        if (stdoutTruncated || stderrTruncated) {
          output += "\n[output truncated]";
        }
        const truncated = truncateOutput(output, this.maxOutputLines);
        // Which cut happened does not matter to the reader; that one happened
        // does. Both are otherwise invisible until the marker at the END of a
        // 600-line block, by which time the model has already paid for the
        // block. `truncated` is in SHORT_META_KEYS (tool-format-xml), so this
        // arrives as a header attribute on the result element instead.
        const outputTruncated =
          stdoutTruncated || stderrTruncated || truncated !== output;
        // An in-cgroup OOM kill is a kernel SIGKILL: the tool would otherwise
        // report a bare dead exit code (null/137) with no why. The note is
        // appended AFTER truncation so it survives an output wall.
        const oomNote = sysboxMemoryKillNote(proc);
        const finalOutput = oomNote ? (truncated ? `${truncated}\n${oomNote}` : oomNote) : truncated;
        finish(
          ToolResult.ok(finalOutput).withEntries({
            command: cmdFirstLine.length > 60 ? cmdFirstLine.slice(0, 60) + "…" : cmdFirstLine,
            exit_code: String(code),
            // Only when cut, like find/grep: an attribute that is absent is
            // the common case, and its presence is the whole signal.
            ...(outputTruncated ? { truncated: "true" } : {}),
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

/**
 * Resolve bashTool.sandbox to a mode, fail-closed (docs/sysbox-sandbox.md
 * invariant 1): an unavailable mode is a startup error, never a silent
 * downgrade to plain spawn. Exported for direct testing.
 */
export function resolveSandboxMode(
  raw: string | undefined,
  caps: SysboxCapabilities,
): SandboxMode {
  const mode = raw ?? "off";
  if (mode !== "off" && mode !== "static" && mode !== "fence") {
    throw new ConfigError(`bashTool.sandbox must be "off", "static", or "fence", got "${mode}"`);
  }
  if (mode === "static" && !caps.staticAvailable) {
    throw new ConfigError(
      `bashTool.sandbox="static" is not available on this host: ${caps.reasons.join("; ")}`,
    );
  }
  if (mode === "fence" && !caps.landlockAvailable) {
    throw new ConfigError(
      `bashTool.sandbox="fence" is not available on this host: ${caps.reasons.join("; ")}`,
    );
  }
  return mode;
}

export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<{
    bashTimeoutMs: number;
    maxToolOutputLines: number;
    maxTimeoutMs?: number;
    sandbox?: string;
  }>(core, "bashTool");
  const timeoutMs = config.bashTimeoutMs;
  const maxOutputLines = config.maxToolOutputLines;
  const maxTimeoutMs = config.maxTimeoutMs;
  // Capability probing spawnSyncs the helper (landlock probe).
  // Skip it entirely when no sandbox is requested; anything other than
  // off/undefined still resolves fail-closed through detectCapabilities().
  const sandbox =
    config.sandbox === undefined || config.sandbox === "off"
      ? "off"
      : resolveSandboxMode(config.sandbox, detectCapabilities());

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const tool = new BashTool({ timeoutMs, maxOutputLines, maxTimeoutMs, sandbox });
        registry.register(BashTool.TOOL_NAME, tool);
      },
    },

    // Expose for external use
    BashTool,
  };
}
