// Interactive CLI Extension - Provides the interactive CLI session with readline loop.
//
// This extension implements "slash commands" as the UI syntax for invoking
// agent commands. The `/` prefix is a UI convention — commands themselves
// are defined in the core and registered by extensions via COMMANDS_REGISTER.

import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { parseCommand, Command, ACTIONS } from "../../core/commands.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import {
  LlmClient,
  type ProviderConfig,
} from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { SessionManager } from "../../core/session/index.ts";
import { Agent, type ModelConfig } from "../../core/agent.ts";
import { CliChannel } from "./cli-channel.ts";
import pkg from "../../../package.json" with { type: "json" };
import {
  readSessionEntries,
  sessionExists,
  replayEntriesIntoContext,
} from "../../core/session/session-log.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";
import { ExtensionError } from "../../core/error.ts";
import type { CompletionContext, CompletionHandler } from "../../core/completion.ts";
import { logger } from "../../core/logger.ts";

const HELP_TEXT = `
Commands:
  /quit, /exit  - Exit
  /help         - Show help
  /clear        - Clear context
  /loop <prompt> - Repeatedly run prompt until cancelled
  /model <name> - Switch model
  /models       - List available models
  /tokens       - Show token usage
  /tools        - Toggle tool call display
  /compact [n] [--compact-debug]  - Compact context
  /compact:strategy [name]        - Manage compaction strategies
  /cancel       - Cancel current run
  /prompt:name [args] - Execute saved prompt
  /skill        - List skills
  /skill:<name> - Activate skill
  /thinking     - Toggle thinking display
  /theme <name> - Set theme (dark, light, monochrome)
  /regenerate   - Regenerate system prompt
  /reasoning none|minimal|low|high|xhigh|max|unset - Set reasoning effort level
`;

const IGNORED_CMDS = new Set([
  "alert",
  "as",
  "clear",
  "continue",
  "do",
  "done",
  "else",
  "enable",
  "eval",
  "export",
  "false",
  "for",
  "help",
  "hotdog",
  "if",
  "in",
  "let",
  "local",
  "login",
  "logout",
  "man",
  "test",
  "then",
  "true",
  "wait",
  "yes",
]);
const MIN_CMD_LEN = 2;

// ── Types ──────────────────────────────────────────────────────────────────

interface ShellCommandResult {
  content?: string;
  error?: string;
  exitCode?: number;
}

interface InteractiveSessionOptions {
  createReadline?: (opts: Record<string, unknown>) => readline.Interface;
  onClose?: () => void;
  onSIGINT?: () => void;
  setupInput?: () => void;
}

// ── Completion Helpers ─────────────────────────────────────────────────────

/**
 * Parse the input line to extract command and argument for completion context.
 */
export function parseCompletionContext(
  line: string,
  cursorPos: number,
  agent: Agent,
): CompletionContext {
  // Get the text up to the cursor
  const text = line.slice(0, cursorPos).trimStart();

  let command: string | undefined;
  let commandArg: string | undefined;

  // Handle slash commands: /command [args]
  if (text.startsWith("/")) {
    const afterSlash = text.slice(1);
    const spaceIdx = afterSlash.indexOf(" ");
    if (spaceIdx === -1) {
      // No space -- completing the command name itself
      command = afterSlash.trim();
      commandArg = "";
    } else {
      // Has space -- command is done, completing the argument
      command = afterSlash.slice(0, spaceIdx).trim();
      commandArg = afterSlash.slice(spaceIdx + 1).trimStart();
    }
  }

  return {
    line,
    cursorPos,
    command,
    commandArg,
    agent,
  };
}

// ── System Command Helpers ─────────────────────────────────────────────────

/**
 * Check if a command name resolves to an executable on the system.
 * Uses `which` on Unix-like systems.
 */
export async function isSystemCommand(cmd: string): Promise<boolean> {
  if (cmdLookupCache.has(cmd)) {
    return cmdLookupCache.get(cmd)!;
  }
  return new Promise((resolve) => {
    const proc = spawn("which", [cmd], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("close", (code: number) => {
      cmdLookupCache.set(cmd, code === 0);
      resolve(code === 0);
    });
    proc.on("error", () => {
      cmdLookupCache.set(cmd, false);
      resolve(false);
    });
  });
}
// cache to avoid invoking `which` more than once for the same cmd
const cmdLookupCache = new Map<string, boolean>();

/**
 * Built-in command replacements (alias-like) applied before execution.
 * Keeps things simple and deterministic without sourcing user bashrc.
 */
const COMMAND_REPLACEMENTS: [string, (cmd: string) => string][] = [
  // ls -> ls --color=always (unless --color already specified)
  [
    "ls",
    (cmd) => {
      if (!cmd.includes("--color")) {
        return cmd.replace(/^ls(\b|$)/, "ls --color=always$1");
      }
      return cmd;
    },
  ],
];

/**
 * Regex that matches the send-to-assistant suffix: a pipe followed by optional
 * whitespace, @, and an optional note (e.g., "ls -la |@", "ls -la | @",
 * "ls -la | @ here's a note"). Note requires at least one space after @.
 */
export const SEND_TO_ASSISTANT_SUFFIX_RE = /\|\s*@(?:\s+(.*))?$/;

/**
 * Apply built-in command replacements to a command string.
 */
export function applyCommandReplacements(command: string): string {
  let result = command;
  for (const [pattern, transform] of COMMAND_REPLACEMENTS) {
    if (
      result.startsWith(pattern) &&
      (result[pattern.length] === " " ||
        result[pattern.length] === "\t" ||
        result.length === pattern.length)
    ) {
      result = transform(result);
    }
  }
  return result;
}

/**
 * Execute a shell command and return the output.
 *
 * @param command - The command to execute.
 * @param options.captureOutput - If true, also capture output (still streams to terminal).
 */
export async function executeShellCommand(
  command: string,
  options: { captureOutput?: boolean } = {},
): Promise<ShellCommandResult> {
  const { captureOutput = false } = options;
  const finalCommand = applyCommandReplacements(command);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", finalCommand], {
      env: process.env,
      stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    if (!captureOutput) {
      proc.on("close", (exitCode: number) => {
        resolve({ content: "", exitCode: exitCode ?? 0 });
      });
      proc.on("error", (err: Error) => {
        resolve({ error: `Error: ${err.message}` });
      });
      return;
    }

    // Capture mode: stream to terminal AND collect for the assistant
    let captured = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      captured += text;
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      captured += text;
    });

    proc.on("close", (exitCode: number) => {
      resolve({ content: captured, exitCode: exitCode ?? 0 });
    });

    proc.on("error", (err: Error) => {
      resolve({ error: `Error: ${err.message}` });
    });
  });
}

// ── AsyncInteractiveCliInput ──────────────────────────────────────────────

interface QuestionDef {
  key: string;
  prompt?: string;
  options?: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
  allow_other?: boolean;
}

interface InputInterface {
  isInteractive(): boolean;
  collectAnswers(questions: QuestionDef[]): Promise<Record<string, string>>;
}

/**
 * AsyncInteractiveCliInput — collects answers using the CLI's readline interface.
 * Implements the Input interface for question/answer collection.
 */
export class AsyncInteractiveCliInput implements InputInterface {
  readonly #rl: readline.Interface;
  readonly #onLine: (line: string) => void;
  readonly #addLineHandler: (handler: (line: string) => void) => void;

  constructor(
    rl: readline.Interface,
    onLine: (line: string) => void,
    addLineHandler: (handler: (line: string) => void) => void,
  ) {
    this.#rl = rl;
    this.#onLine = onLine;
    this.#addLineHandler = addLineHandler;
  }

  isInteractive(): boolean {
    return true;
  }

  /**
   * Collect answers to questions using the readline interface.
   */
  async collectAnswers(
    questions: QuestionDef[],
  ): Promise<Record<string, string>> {
    const rl = this.#rl;

    // Temporarily take over readline
    rl.removeListener("line", this.#onLine);

    const answers: Record<string, string> = {};
    try {
      for (const q of questions) {
        const key = q.key;
        const promptText = q.prompt || "";
        const options = q.options || [];
        const defaultValue = q.default ?? "";
        const required = q.required !== false;
        const allowOther = (q.allowOther ?? q.allow_other) !== false;

        process.stdout.write(`\n  ? ${promptText}\n`);

        if (options.length > 0) {
          for (let i = 0; i < options.length; i++) {
            process.stdout.write(`    [${i + 1}] ${options[i]}\n`);
          }
        }

        if (defaultValue !== "") {
          process.stdout.write(`    (default: ${defaultValue})\n`);
        }

        let answer = "";
        let valid = false;

        while (!valid) {
          const prompt = defaultValue !== "" ? ` [${defaultValue}] ` : " ";
          const line = await new Promise<string>((resolve) => {
            rl.question(prompt, (response: string) => {
              resolve(response ?? "");
            });
          });

          const trimmed = line.trim();

          if (trimmed === "") {
            answer = defaultValue;
          } else if (options.length > 0) {
            const idx = parseInt(trimmed, 10);
            if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
              answer = options[idx - 1] ?? "";
            } else if (options.includes(trimmed)) {
              answer = trimmed;
            } else if (allowOther) {
              answer = trimmed;
            } else {
              process.stderr.write(
                `  Invalid option. Please enter a number 1-${options.length} or one of: ${JSON.stringify(options)}\n`,
              );
              continue;
            }
          } else {
            answer = trimmed;
          }

          if (required && answer === "") {
            process.stderr.write(
              "  This question is required. Please enter a value.\n",
            );
            continue;
          }

          valid = true;
        }

        answers[key] = answer;
      }
    } finally {
      this.#addLineHandler(this.#onLine);
    }

    return answers;
  }
}

// Store reference for tool context
let currentInput: InputInterface | null = null;

// ── Completion Providers ───────────────────────────────────────────────────

/**
 * Register the generic slash command name completion: /<tab> -> list all commands.
 * Command-specific argument completions are registered by each extension
 * via the `completion` field on their CommandDefinition.
 */
export function registerSlashCommandNameCompletion(
  completionService: CoreContext["completion"],
): void {
  completionService.register(
    (ctx) => {
      // Match when line starts with / and we're completing the command name (no space after /)
      const text = ctx.line.slice(0, ctx.cursorPos).trimStart();
      return text.startsWith("/") && !text.slice(1).includes(" ");
    },
    (ctx) => {
      const agent = ctx.agent;
      const afterSlash = ctx.line.slice(0, ctx.cursorPos).trimStart().slice(1);
      const prefix = afterSlash.toLowerCase();

      // Get all registered command names from the agent's command registry
      const commandNames = agent.commandRegistry?.names() || [];
      const matches = commandNames
        .filter((name) => name.toLowerCase().startsWith(prefix))
        .map((name) => ({ value: `/${name}` }));

      return matches;
    },
    "ui-interactive-cli:slash-commands",
  );
}

/**
 * Register completion handlers from command definitions.
 * Called during COMMANDS_REGISTER to wire up completions declared inline with commands.
 */
export function registerCommandCompletions(
  completionService: CoreContext["completion"],
  registry: { all: () => Map<string, { completion?: CompletionHandler }> },
  source: string,
): void {
  for (const [name, def] of registry.all()) {
    if (!def.completion) continue;

    const matcher = (ctx: CompletionContext): boolean => {
      const cmd = ctx.command;
      if (!cmd) return false;
      return cmd === name || cmd.startsWith(`${name}:`);
    };

    completionService.register(matcher, def.completion, `${source}:${name}`);
  }
}

/**
 * Register shell mode completion provider.
 * Bash-like completion: commands, flags (from --help), and files.
 */
export function registerShellCompletion(
  completionService: CoreContext["completion"],
  shellModeEnabled: boolean,
): void {
  if (!shellModeEnabled) return;

  // Bash script that performs completion based on the line context.
  // Handles: command completion, flag completion (--help parsing), file completion.
  const COMPLETION_SCRIPT = `
line="$1"

# Check if line ends with space (user typed command + space, wants file completion)
if [[ "$line" =~ \\ $ ]]; then
  set -- $line
  cmd="$1"
  compgen -f
else
  set -- $line
  cmd="$1"
  shift
  args_count=$#

  # Get the last word (the one being completed)
  word="$1"
  for w in "$@"; do word="$w"; done

  if [[ $args_count -eq 0 && -n "$cmd" ]]; then
    # Single word - command completion
    compgen -c -- "$cmd"
  elif [[ -z "$word" ]]; then
    # Space after command/flags - complete files in current dir
    compgen -f
  elif [[ "$word" == -* ]]; then
    # Flag completion - extract options from command's --help
    if command -v "$cmd" >/dev/null 2>&1; then
      opts=$("$cmd" --help 2>&1 | grep -oE "(^\\s+-[a-zA-Z]|(--[a-z][a-zA-Z0-9-]*|--help|--version))" | tr -d " " | sort -u | tr "\\n" " ")
      compgen -W "$opts" -- "$word"
    fi
  else
    # File/path completion
    compgen -f -- "$word"
  fi
fi
`;

  const runCompletion = (line: string): Promise<string[]> => {
    return new Promise((resolve) => {
      const child = execFile(
        "bash",
        ["-c", COMPLETION_SCRIPT, "--", line],
        { env: process.env, cwd: process.cwd() },
        (error, stdout) => {
          clearTimeout(timeout);
          if (error || !stdout) {
            resolve([]);
            return;
          }
          resolve(stdout.trim().split("\n").filter(Boolean));
        },
      );

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve([]);
      }, 150);
    });
  };

  completionService.register(
    (ctx: CompletionContext) => {
      // Only activate in shell mode when not typing a slash command
      const text = ctx.line.slice(0, ctx.cursorPos).trimStart();
      return shellModeEnabled && !text.startsWith("/");
    },
    async (ctx: CompletionContext) => {
      const line = ctx.line.slice(0, ctx.cursorPos).trimStart();
      if (!line) return [];

      const words = line.split(/\s+/);
      const firstWord = words[0];
      if (!firstWord || firstWord.length < MIN_CMD_LEN) return [];

      try {
        const completions = await runCompletion(line);
        return completions.map((c) => ({ value: c }));
      } catch (e) {
        logger.debug(
          `ui-interactive-cli: shell completion error: ${(e as Error).message}`,
        );
        return [];
      }
    },
    "ui-interactive-cli:shell",
  );
}

// ── Interactive Session Helpers ────────────────────────────────────────────

/**
 * Build the readline completer callback for the interactive session.
 */
export function buildReadlineCompleter(
  sessionManager: SessionManager,
  core: CoreContext,
  shellMode: boolean,
): (
  line: string,
  callback: (err: Error | null, result: [string[], string]) => void,
) => void {
  return (
    line: string,
    callback: (err: Error | null, result: [string[], string]) => void,
  ) => {
    const currentAgent = sessionManager.getAgent();
    if (!currentAgent) {
      callback(null, [[], line]);
      return;
    }

    const cursorPos = line.length;
    const ctx = parseCompletionContext(line, cursorPos, currentAgent);

    let prefix = "";
    const text = line.slice(0, cursorPos).trimStart();
    if (text.startsWith("/")) {
      const afterSlash = text.slice(1);
      const spaceIdx = afterSlash.indexOf(" ");
      if (spaceIdx === -1) {
        const colonIdx = afterSlash.indexOf(":");
        if (colonIdx !== -1) {
          prefix = afterSlash.slice(colonIdx + 1);
        } else {
          prefix = "/" + afterSlash;
        }
      } else {
        prefix = afterSlash.slice(spaceIdx + 1).trimStart();
      }
    } else if (shellMode) {
      const words = line.split(/\s+/);
      prefix = words[words.length - 1] ?? "";
    } else {
      prefix = line;
    }

    core.completion
      .request(ctx, 200)
      .then((options) => {
        const matches = options
          .map((o) => o.value)
          .filter((m) => m !== prefix);
        logger.debug(
          `[completion] "${line}" prefix="${prefix}" -> ${matches.length} matches`,
        );
        callback(null, [matches, prefix]);
      })
      .catch((e) => {
        logger.error(`[completion] error: ${(e as Error).message}`);
        callback(null, [[], prefix]);
      });
  };
}

/**
 * Build the onQuit handler for CliChannel.
 */
export function buildOnQuitHandler(
  sessionManager: SessionManager,
  extensions: CoreContext["extensions"],
): () => void {
  return () => {
    console.log("\nGoodbye!");
    const interactiveSessionId = sessionManager.sessionId();
    if (interactiveSessionId) {
      console.log(`Session: ${interactiveSessionId}`);
    }
    extensions.cleanup();
    process.exit(0);
  };
}

/**
 * Build an agent for the interactive CLI session.
 */
export async function buildInteractiveAgent(
  agentConfig: Record<string, unknown>,
  core: CoreContext,
  resolved: Record<string, unknown>,
  config: Record<string, unknown>,
  llmClient: LlmClient,
  cli: Record<string, unknown>,
): Promise<Agent> {
  const sessionId = (agentConfig.sessionId as string) || crypto.randomUUID();
  const agent = new Agent({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    llmClient: (agentConfig.llmClient as LlmClient | undefined) || llmClient,
    model: (agentConfig.model as string) || (resolved.model as string),
    maxIterations:
      (agentConfig.maxIterations as number) ||
      (resolved.maxIterations as number) ||
      100,
    contextLimit: 128000,
    hideTools:
      typeof agentConfig.hideTools === "boolean"
        ? agentConfig.hideTools
        : (resolved.hideTools as boolean | undefined),
    hideThinking:
      typeof agentConfig.hideThinking === "boolean"
        ? agentConfig.hideThinking
        : (resolved.hideThinking as boolean | undefined),
    showTokenUse:
      typeof agentConfig.showTokenUse === "boolean"
        ? agentConfig.showTokenUse
        : (resolved.showTokenUse as boolean | undefined),
    sink: null,
    modelRegistry:
      (agentConfig.modelRegistry as Record<string, ModelConfig>) ||
      (resolved.modelRegistry as Record<string, ModelConfig>) ||
      {},
    profileName:
      (agentConfig.profileName as string) || (resolved.profileName as string),
    role:
      (agentConfig.role as string) || (resolved.role as string | undefined),
    profileBody:
      (agentConfig.profileBody as string) ||
      (resolved.profileBody as string | undefined),
    stream:
      typeof agentConfig.stream === "boolean"
        ? agentConfig.stream
        : (resolved.stream as boolean | undefined),
    config: { ...config },
    sessionId,
    abortSignal: (agentConfig.abortSignal as AbortSignal) || null,
    toolWhitelist: (agentConfig.toolWhitelist as string[]) || null,
  });

  core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
    registry: agent.commandRegistry,
    agent,
  });

  // Restore session from disk if a session ID was explicitly provided
  const explicitSessionId = cli.sessionId as string | undefined;
  if (explicitSessionId && sessionId === explicitSessionId) {
    if (await sessionExists(explicitSessionId)) {
      const entries = await readSessionEntries(explicitSessionId);
      if (entries.length > 0) {
        agent.isRestoring = true;
        const replayed = replayEntriesIntoContext(agent, entries);
        agent.isRestoring = false;
        if (replayed > 0) {
          console.log(
            `Session restored: ${replayed} messages replayed from ${explicitSessionId}`,
          );
        }
      }
    }
  }

  return agent;
}

// ── Interactive Session ────────────────────────────────────────────────────

/**
 * Run the interactive CLI session.
 *
 * Sets up the readline interface, SessionManager, CliChannel, and task manager,
 * then enters the interactive loop.
 */
export async function runInteractiveSession(
  cli: Record<string, unknown>,
  core: CoreContext,
  options: InteractiveSessionOptions = {},
): Promise<void> {
  const { resolved, config } = core;

  if (!resolved) {
    throw ExtensionError.ConfigFailed(
      "ui-interactive-cli",
      "configuration must be resolved first",
    );
  }

  // Create output sink
  const palette = await CliOutputSink.resolve(
    cli.colors !== false,
    (resolved.theme as string) || "dark",
    (config.colors as Record<string, unknown>) || null,
  );

  const sink = new CliOutputSink({
    ...resolved,
    palette,
    thinkerFormat: resolved.thinkerFormat as string | undefined,
    toolFormat: resolved.toolFormat as string | undefined,
    toolOutputFmt: resolved.toolOutputFmt as string | undefined,
    hideUserMessage: true,
  });

  // Build LLM client — single instance owned by SessionManager
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl as string,
    apiKey: resolved.apiKey as string,
    stream: resolved.stream as boolean | undefined,
    chatTimeoutSecs: resolved.chatTimeout as number,
    maxRetries: resolved.maxRetries as number,
    providers: (config.providers as ProviderConfig[]) || [],
    markerMangler: new MarkerMangler(),
  });

  // Build agent function — uses llmClient from config (injected by SessionManager)
  const buildAgent = async (agentConfig: Record<string, unknown>) => {
    return buildInteractiveAgent(agentConfig, core, resolved, config, llmClient, cli);
  };

  // Create SessionManager — this owns the MessageBus and TaskManager internally
  const sessionManager = await SessionManager.create({
    hooks: core.hooks as unknown as {
      notifyHooks: (hookName: string, data: unknown) => void;
    },
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
    llmClient,
    modelRegistry: resolved.modelRegistry as Record<string, unknown>,
    coreConfig: config,
    taskConfig: {
      maxIterations: (resolved.maxIterations as number) || 100,
      taskProfile: (resolved.taskProfile as string) || "task-default",
      taskRole: (resolved.taskDefaultRole as string) || "",
    },
  });

  // Register the generic slash command name completion
  registerSlashCommandNameCompletion(core.completion);

  // Register completions from command definitions (extensions declare completions inline)
  // Hook into COMMANDS_REGISTER so completions are wired up as commands are registered
  core.hooks.on(HOOKS.COMMANDS_REGISTER, (payload: unknown) => {
    const { registry } = payload as { registry: { all: () => Map<string, unknown> } };
    registerCommandCompletions(core.completion, registry as any, "ui-interactive-cli");
  }, "ui-interactive-cli");

  // Print info
  const agent = sessionManager.getAgent();
  console.log(
    `hotdog ${(pkg as { version: string }).version} (interactive mode)`,
  );
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(
    `Session: ${(agent as { sessionId?: string })?.sessionId || "unknown"}`,
  );
  console.log("Type /quit or /exit to exit.\n");

  // Determine shell mode
  const shellMode = (config.uiInteractiveCli as Record<string, unknown>)
    ?.shellMode;

  // Create readline with tab completion
  const createReadline = options.createReadline || readline.createInterface;

  const rl = createReadline({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
    completer: buildReadlineCompleter(sessionManager, core, !!shellMode),
  });

  // Create CliChannel — handles the duplex between readline and SessionManager
  const channel = new CliChannel({
    sessionManager,
    sessionId: sessionManager.sessionId()!,
    sink,
    rl,
    onQuit: buildOnQuitHandler(sessionManager, core.extensions),
  });

  // Define the line handler
  let lineHandler: (line: string) => void;

  const addLineHandler = (handler: (line: string) => void) => {
    rl.on("line", handler);
  };

  // Listen for model changes and update the prompt
  core.hooks.on(HOOKS.MODEL_CHANGE, (data: { newModel: string }) => {
    rl.setPrompt(`(${data.newModel})> `);
  });

  // Re-display prompt after agent finishes
  core.hooks.on(HOOKS.TURN_END, (data: { stopped?: boolean }) => {
    if (data.stopped) {
      setImmediate(() => {
        console.log("");
        rl.prompt();
      });
    }
  });

  // Register shell mode completion if enabled
  registerShellCompletion(core.completion, !!shellMode);

  // Define and register the line handler
  lineHandler = async (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (trimmed.startsWith("/")) {
      const cmdText = trimmed.slice(1).trim();
      handleSlashCommand(cmdText, sessionManager, channel, rl);
      return;
    }

    // Shell mode gate
    if (shellMode) {
      const match = trimmed.match(SEND_TO_ASSISTANT_SUFFIX_RE);
      const sendToAssistant = !!match;
      const note = sendToAssistant ? (match[1] || "").trim() : "";
      const cmd = sendToAssistant
        ? trimmed.replace(SEND_TO_ASSISTANT_SUFFIX_RE, "").trim()
        : trimmed;

      const firstWord = cmd.split(/\s+/)[0];
      if (
        firstWord &&
        firstWord.length >= MIN_CMD_LEN &&
        !IGNORED_CMDS.has(firstWord) &&
        (await isSystemCommand(firstWord))
      ) {
        rl.pause();
        const result = await executeShellCommand(cmd, {
          captureOutput: sendToAssistant,
        });
        rl.resume();

        if (sendToAssistant) {
          // Send command and output to the assistant
          const notePart = note ? `Note: ${note}\n\n` : "";
          const msg = `I ran: ${cmd}\n\n${notePart}Output:\n${result.content || "(no output)"}`;
          await channel.send(msg);
        } else {
          if (result.content) {
            console.log(result.content);
          } else if (result.error) {
            console.log(`${result.error}`);
          }
          if (result.exitCode != 0) {
            console.log(`[exec: exit code ${result.exitCode}]`);
          }
        }
        rl.prompt();
        return;
      }
    }

    // Regular text input — enqueue via channel
    await channel.send(trimmed);
  };

  rl.on("line", lineHandler);

  // Create the input interface for question tool
  const setupInput =
    options.setupInput ||
    (() => {
      currentInput = new AsyncInteractiveCliInput(
        rl,
        lineHandler,
        addLineHandler,
      );
    });
  setupInput();

  // SIGINT handler
  const handleSigint =
    options.onSIGINT ||
    (() => {
      channel.interrupt();
      (rl as { line: string; cursor: number }).line = "";
      (rl as { line: string; cursor: number }).cursor = 0;
      console.log("\nInterrupted (/quit, /exit, or ctrl-d to exit)");
      rl.prompt();
    });

  rl.on("SIGINT", handleSigint);

  rl.prompt();

  // Run the message bus — awaited so the process stays alive until the user quits.
  const bus = sessionManager.getBus(sessionManager.sessionId()!);
  if (bus) {
    await bus.run();
  }
}

// ── Slash Command Handler ──────────────────────────────────────────────────

/**
 * Handle a slash command.
 * UI-only commands (quit, help) are handled directly; everything else
 * goes through the SessionManager.
 */
export function handleSlashCommand(
  cmdText: string,
  sessionManager: SessionManager,
  channel: CliChannel,
  rl: readline.Interface,
): void {
  const cmd = parseCommand(cmdText);

  // UI-only commands handled directly by the UI layer
  switch (cmd.type) {
    case Command.Help:
      console.log(HELP_TEXT);
      rl.prompt();
      return;

    case Command.Quit:
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
      return;
  }

  // All other commands go through the SessionManager
  sessionManager.executeCommand(sessionManager.sessionId()!, cmdText).then(
    (action: number | undefined) => {
      if (!action || !(action & ACTIONS.PROMPT)) {
        console.log("");
        rl.prompt();
      }
    },
    () => {
      console.log("");
      rl.prompt();
    },
  );
}

// ── Extension Entry Point ──────────────────────────────────────────────────

/**
 * Create the interactive-cli extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (payload: unknown) => {
            const registry = payload as {
              register: (name: string, opts: Record<string, unknown>) => void;
            };
            registry.register("cli", {
              description: "Interactive CLI session",
              handler: async (
                cli: Record<string, unknown>,
                core: CoreContext,
              ) => {
                await runInteractiveSession(cli, core);
              },
            });
          },

          [HOOKS.AGENT_TOOL_CONTEXT]: (payload: unknown) => {
            const toolCtx = (
              payload as {
                toolCtx: { set: (key: string, value: unknown) => void };
              }
            ).toolCtx;
            if (currentInput) {
              toolCtx.set("input", currentInput);
            }
          },
        }
      : undefined,

    cleanup: async () => {
      currentInput = null;
    },
  };
}
