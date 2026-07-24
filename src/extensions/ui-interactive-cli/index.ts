// Interactive CLI Extension - Provides the interactive CLI session with readline loop.
//
// This extension implements "slash commands" as the UI syntax for invoking
// agent commands. The `/` prefix is a UI convention — commands themselves
// are defined in the core and registered by extensions via COMMANDS_REGISTER.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, Command, ACTIONS } from "../../core/commands.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { LlmClient, type ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { SessionManager } from "../../core/session/index.ts";
import { Agent } from "../../core/agent.ts";
import { CliChannel } from "./cli-channel.ts";
import pkg from "../../../package.json" with { type: "json" };
import {
  readSessionEntries,
  sessionExists,
  replayEntriesIntoContext,
} from "../../core/session/session-log.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

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
 * Execute a shell command and return the output.
 */
export async function executeShellCommand(command: string): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (exitCode: number) => {
      const output = [stdout, stderr].filter(Boolean).join("\n");
      resolve({
        content: output,
        exitCode,
      });
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
  async collectAnswers(questions: QuestionDef[]): Promise<Record<string, string>> {
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
    throw new Error("configuration must be resolved first")
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
    const sessionId = (agentConfig.sessionId as string) || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: (agentConfig.llmClient as LlmClient | undefined) || llmClient,
      model: (agentConfig.model as string) || (resolved.model as string),
      maxIterations:
        (agentConfig.maxIterations as number) || (resolved.maxIterations as number) || 100,
      contextLimit: 128000,
      hideTools: typeof agentConfig.hideTools === "boolean" ? agentConfig.hideTools : (resolved.hideTools as boolean | undefined),
      hideThinking: typeof agentConfig.hideThinking === "boolean" ? agentConfig.hideThinking : (resolved.hideThinking as boolean | undefined),
      showTokenUse: typeof agentConfig.showTokenUse === "boolean" ? agentConfig.showTokenUse : (resolved.showTokenUse as boolean | undefined),
      sink: null, // Sink is managed by CliChannel via SessionManager
      modelRegistry: (agentConfig.modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } }) ||
        (resolved.modelRegistry as unknown as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } }) || {},
      profileName: (agentConfig.profileName as string) || (resolved.profileName as string),
      role: (agentConfig.role as string) || (resolved.role as string | undefined),
      profileBody: (agentConfig.profileBody as string) || (resolved.profileBody as string | undefined),
      stream: typeof agentConfig.stream === "boolean" ? agentConfig.stream : (resolved.stream as boolean | undefined),
      config,
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
  };

  // Create SessionManager — this owns the MessageBus and TaskManager internally
  const sessionManager = await SessionManager.create({
    hooks: core.hooks as unknown as { notifyHooks: (hookName: string, data: unknown) => void },
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

  // Print info
  const agent = sessionManager.getAgent();
  console.log(`hotdog ${(pkg as { version: string }).version} (interactive mode)`);
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${(agent as { sessionId?: string })?.sessionId || "unknown"}`);
  console.log("Type /quit or /exit to exit.\n");

  // Create readline
  const createReadline = options.createReadline || readline.createInterface;
  const rl = createReadline({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
  });

  // Create CliChannel — handles the duplex between readline and SessionManager
  const channel = new CliChannel({
    sessionManager,
    sessionId: sessionManager.sessionId()!,
    sink,
    rl,
    onQuit: () => {
      console.log("\nGoodbye!");
      const interactiveSessionId = sessionManager.sessionId();
      if (interactiveSessionId) {
        console.log(`Session: ${interactiveSessionId}`);
      }
      core.extensions.cleanup();
      process.exit(0);
    },
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

  const shellMode = (config.uiInteractiveCli as Record<string, unknown>)?.shellMode ?? false;

  // Define and register the line handler
  lineHandler = async (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (trimmed.startsWith("/")) {
      const cmdText = trimmed.slice(1).trim().toLowerCase();
      handleSlashCommand(cmdText, sessionManager, channel, rl);
      return;
    }

    // Shell mode gate
    if (shellMode) {
      const firstWord = trimmed.split(/\s+/)[0];
      if (
        firstWord &&
        firstWord.length >= MIN_CMD_LEN &&
        !IGNORED_CMDS.has(firstWord) &&
        (await isSystemCommand(firstWord))
      ) {
        console.log(`[exec: ${trimmed}]\n`);
        const result = await executeShellCommand(trimmed);
        if (result.content) {
          console.log(result.content);
        } else if (result.error) {
          console.log(`${result.error}`);
        }
        console.log(`[exec: exit code ${result.exitCode}]`);
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
            const registry = (payload as { register: (name: string, opts: Record<string, unknown>) => void });
            registry.register("cli", {
              description: "Interactive CLI session",
              handler: async (cli: Record<string, unknown>, core: CoreContext) => {
                await runInteractiveSession(cli, core);
              },
            });
          },

          [HOOKS.AGENT_TOOL_CONTEXT]: (payload: unknown) => {
            const toolCtx = (payload as { toolCtx: { set: (key: string, value: unknown) => void } }).toolCtx;
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
