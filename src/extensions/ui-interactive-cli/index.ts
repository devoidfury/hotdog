// Interactive CLI Extension
// Provides the interactive CLI session with readline loop.
// Registers a default subcommand (empty name) that main.ts dispatches to
// when no subcommand is provided.
//
// This extension implements "slash commands" as the UI syntax for invoking
// agent commands. The `/` prefix is a UI convention — commands themselves
// are defined in the core and registered by extensions via COMMANDS_REGISTER.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, Command, ACTIONS, ParsedCommand } from "../../core/commands.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { LlmClient, type ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { TaskManager } from "../../core/session/task-manager.ts";
import { SessionManager } from "../../core/session/index.ts";
import { MessageBus } from "../../core/session/message-bus.ts";
import { Agent } from "../../core/agent.ts";
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

interface MessageBusRef {
  executeCommand(cmd: string): Promise<number>;
  interrupt(): void;
  run(): Promise<void>;
}

// ── System Command Helpers ─────────────────────────────────────────────────

/**
 * Check if a command name resolves to an executable on the system.
 * Uses `which` on Unix-like systems.
 */
export async function isSystemCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [cmd], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("close", (code: number) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

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
 *
 * This does NOT create a separate readline instance. Instead, it takes over
 * the existing readline by temporarily removing the main 'line' handler,
 * collecting answers via rl.question(), then restoring the handler.
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
   * Temporarily takes over readline input, collects answers, then restores.
   */
  async collectAnswers(questions: QuestionDef[]): Promise<Record<string, string>> {
    const rl = this.#rl;

    // Temporarily take over readline by removing the main line handler
    rl.removeListener("line", this.#onLine);

    const answers: Record<string, string> = {};
    try {
      for (const q of questions) {
        const key = q.key;
        const promptText = q.prompt || "";
        const options = q.options || [];
        const defaultValue = q.default ?? "";
        const required = q.required !== false;
        // Handle both snake_case (from JSON) and camelCase
        const allowOther = (q.allowOther ?? q.allow_other) !== false;

        // Display the question
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
            // User pressed enter, use default
            answer = defaultValue;
          } else if (options.length > 0) {
            // Try to parse as a number index
            const idx = parseInt(trimmed, 10);
            if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
              answer = options[idx - 1] ?? "";
            } else if (options.includes(trimmed)) {
              // Exact match on option text
              answer = trimmed;
            } else if (allowOther) {
              // Free text accepted alongside options
              answer = trimmed;
            } else {
              // Strict mode: reject unknown values
              process.stderr.write(
                `  Invalid option. Please enter a number 1-${options.length} or one of: ${JSON.stringify(options)}\n`,
              );
              continue;
            }
          } else {
            // Free text question
            answer = trimmed;
          }

          // Check required
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
      // Always restore the main line handler
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
 * Sets up the readline interface, message bus, task manager, and session
 * manager, then enters the interactive loop. This is the main entry point
 * for the interactive CLI subcommand.
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
    // Readline already echoes user input, so skip the sink's user message display.
    // One-shot and websocket modes still need it (no readline echo).
    hideUserMessage: true,
  });

  // Build LLM client
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl as string,
    apiKey: resolved.apiKey as string,
    stream: resolved.stream as boolean | undefined,
    chatTimeoutSecs: resolved.chatTimeout as number,
    maxRetries: resolved.maxRetries as number,
    providers: (config.providers as ProviderConfig[]) || [],
    markerMangler: new MarkerMangler(),
  });

  // Build agent function
  const buildAgent = async (agentConfig: Record<string, unknown>) => {
    const sessionId = (agentConfig.sessionId as string) || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient,
      model: (agentConfig.model as string) || (resolved.model as string),
      maxIterations:
        (agentConfig.maxIterations as number) || (resolved.maxIterations as number) || 100,
      maxTokens: (resolved.maxTokens as number) || 4096,
      hideTools: typeof agentConfig.hideTools === "boolean" ? agentConfig.hideTools : (resolved.hideTools as boolean | undefined),
      hideThinking: typeof agentConfig.hideThinking === "boolean" ? agentConfig.hideThinking : (resolved.hideThinking as boolean | undefined),
      showTokenUse: typeof agentConfig.showTokenUse === "boolean" ? agentConfig.showTokenUse : (resolved.showTokenUse as boolean | undefined),
      sink: (agentConfig.sink as { emit: (event: unknown) => void } | undefined) || sink,
      modelRegistry: (resolved.modelRegistry as unknown as { [key: string]: { maxTokens?: number; reasoningEffort?: string; [key: string]: unknown } }) || {},
      profileName: (agentConfig.profileName as string) || (resolved.profileName as string),
      role: (agentConfig.role as string) || (resolved.role as string | undefined),
      profileBody: (agentConfig.profileBody as string) || (resolved.profileBody as string | undefined),
      stream: typeof agentConfig.stream === "boolean" ? agentConfig.stream : (resolved.stream as boolean | undefined),
      config,
      sessionId,
      abortSignal: (agentConfig.abortSignal as AbortSignal) || null,
      toolWhitelist: (agentConfig.toolWhitelist as string[]) || null,
    });

    await agent.ensureSystemPrompt();

    // Emit hook for extensions to register commands
    core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
      registry: agent.getCommandRegistry(),
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

  // Create TaskManager
  const taskManager = new TaskManager({
    buildAgent,
    llmClient,
    modelRegistry: resolved.modelRegistry as Record<string, unknown>,
    config,
    hooks: core.hooks,
    maxIterations: (resolved.maxIterations as number) || 100,
    taskProfile: (resolved.taskProfile as string) || "task-default",
    taskRole: (resolved.taskDefaultRole as string) || "",
  });

  // Create SessionManager
  const sessionManager = await SessionManager.create({
    hooks: core.hooks as unknown as { notifyHooksAsync: (hookName: string, data: unknown) => Promise<void>; notifyHooks: (hookName: string, data: unknown) => void },
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
  });

  // Wire taskManager to sessionManager
  taskManager.setSessionManager(sessionManager as { getAgent: () => { abortSignal: AbortSignal | null; run: (description: string) => Promise<string | undefined>; notifyCompletion: (result: string) => void; addMessage: (msg: unknown) => void; followQueue?: string[] } | undefined });

  // Create MessageBus
  const bus = new MessageBus({
    sessionManager: sessionManager as unknown as { getAgent: () => { hooks: { runHookPipeline: (hookName: string, data: unknown, opts?: { shouldStop?: (result: unknown) => boolean }) => Promise<unknown> }; run: (text: string) => Promise<unknown>; resetCancel: () => void; cancel: () => void; getCommandRegistry: () => unknown; executeCommand: (cmd: unknown) => Promise<unknown> } | undefined },
    sink,
  });

  // Wire up task completion
  taskManager.setBus(bus);

  // Print info
  const agent = sessionManager.getAgent();
  console.log(`hotdog ${(pkg as { version: string }).version} (interactive mode)`);
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${(agent as { sessionId?: string })?.sessionId || "unknown"}`);
  console.log("Type /quit or /exit to exit.\n");

  // Start interactive session
  const createReadline = options.createReadline || readline.createInterface;
  const rl = createReadline({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
  });

  // Define the line handler so we can reference it for the input interface
  let lineHandler: (line: string) => void;

  // Helper to add line handler (used by AsyncInteractiveCliInput to restore)
  const addLineHandler = (handler: (line: string) => void) => {
    rl.on("line", handler);
  };

  // Listen for model changes and update the readline prompt
  core.hooks.on(HOOKS.MODEL_CHANGE, (data: { newModel: string }) => {
    rl.setPrompt(`(${data.newModel})> `);
  });

  // Re-display prompt after agent finishes processing
  core.hooks.on(HOOKS.TURN_END, (data: { stopped?: boolean }) => {
    if (data.stopped) {
      setImmediate(() => {
        console.log("");
        rl.prompt();
      });
    }
  });

  // Resolve shell mode flag: CLI flag > config > default
  const shellMode = (config.uiInteractiveCli as Record<string, unknown>)?.shellMode ?? false;

  // Define and register the line handler
  lineHandler = async (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle slash commands — delegate to bus for execution
    if (trimmed.startsWith("/")) {
      const cmdText = trimmed.slice(1).trim().toLowerCase();
      handleSlashCommand(cmdText, bus as MessageBusRef, rl);
      return;
    }

    // Shell mode gate: check if the first word is a system command.
    // If it is, execute it directly and skip the user input message.
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

    // Regular text input — enqueue for agent processing
    (bus as { enqueue: (text: string) => void }).enqueue(trimmed);
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

  // Close handler
  const handleClose =
    options.onClose ||
    (() => {
      console.log("\nGoodbye!");
      const interactiveSessionId = sessionManager.sessionId();
      if (interactiveSessionId) {
        console.log(`Session: ${interactiveSessionId}`);
      }
      core.extensions.cleanup();
      process.exit(0);
    });

  rl.on("close", handleClose);

  // SIGINT handler
  const handleSigint =
    options.onSIGINT ||
    (() => {
      (bus as MessageBusRef).interrupt();
      // Clear the input buffer so any typed-but-unsubmitted text is discarded
      (rl as { line: string; cursor: number }).line = "";
      (rl as { line: string; cursor: number }).cursor = 0;
      console.log("\nInterrupted (/quit, /exit, or ctrl-d to exit)");
      rl.prompt();
    });

  rl.on("SIGINT", handleSigint);

  rl.prompt();

  // Run the message bus — awaited so the process stays alive until the user quits.
  await (bus as MessageBusRef).run();
}

// ── Slash Command Handler ──────────────────────────────────────────────────

/**
 * Handle a slash command by delegating to the bus.
 */
export function handleSlashCommand(
  cmdText: string,
  bus: MessageBusRef,
  rl: readline.Interface,
): void {
  const cmd = parseCommand(cmdText) as ParsedCommand;

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

  // All other commands go through the bus → agent → COMMAND_RESULT event
  bus.executeCommand(cmdText).then(
    (action: number) => {
      if (!(action & ACTIONS.PROMPT)) {
        console.log("");
        rl.prompt();
      }
    },
    () => {
      // On error, always re-display the prompt so the CLI stays responsive.
      console.log("");
      rl.prompt();
    },
  );
}

// ── Extension Entry Point ──────────────────────────────────────────────────

/**
 * Create the interactive-cli extension.
 * Registers a "cli" subcommand for interactive mode.
 * main.ts dispatches to "cli" when no subcommand is provided.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          // Register "cli" subcommand via hook
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (payload: unknown) => {
            const registry = (payload as { register: (name: string, opts: Record<string, unknown>) => void });
            registry.register("cli", {
              description: "Interactive CLI session",
              handler: async (cli: Record<string, unknown>, core: CoreContext) => {
                await runInteractiveSession(cli, core);
              },
            });
          },

          // Provide input interface to tool context
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
