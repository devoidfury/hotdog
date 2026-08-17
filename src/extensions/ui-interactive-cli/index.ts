// Interactive CLI session (readline loop).

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, Command, ACTIONS } from "@core/commands.ts";
import { HOOKS } from "@core/hooks.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { LlmClient } from "@core/llm-client/client.ts";
import { MarkerMangler } from "@core/marker-mangler.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { Agent } from "@core/agent.ts";
import { CliChannel } from "./cli-channel.ts";
import pkg from "@package.json" with { type: "json" };
import {
  readSessionEntries,
  sessionExists,
  replayEntriesIntoContext,
} from "@core/session/session-log.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { ExtensionError } from "@core/error.ts";
import {
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  buildReadlineCompleter,
} from "./completions.ts";
import type { CliArgv } from "@core/config/index.ts";
import type { ModelConfig, ProviderDef } from "@core/config/providers.ts";

export {
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  buildReadlineCompleter,
};

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
  /compact <strategy>             - Switch compaction strategy
  /compact:<strategy>             - Switch compaction strategy
  /cancel       - Cancel current run
  /prompt:name [args] - Execute saved prompt
  /skill        - List skills
  /skill:<name> - Activate skill
  /thinking     - Toggle thinking display
  /theme <name> - Set theme (dark, light, monochrome)
  /regenerate   - Regenerate system prompt
  /reasoning none|minimal|low|high|xhigh|max|unset - Set reasoning effort level
`;

// In shellMode, first words that look like common conversational openers are
// never treated as commands to execute.
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

// Resolves via `which`; cached per command name.
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
const cmdLookupCache = new Map<string, boolean>();

// Deterministic aliases applied before execution (no user bashrc sourcing).
const COMMAND_REPLACEMENTS: [string, (cmd: string) => string][] = [
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

// "cmd |@" pipes the output to the assistant; an optional note follows after a space.
export const SEND_TO_ASSISTANT_SUFFIX_RE = /\|\s*@(?:\s+(.*))?$/;

export function applyCommandReplacements(command: string): string {
  let result = command;
  for (const [pattern, transform] of COMMAND_REPLACEMENTS) {
    if (
      result.startsWith(pattern) &&
      (result[pattern.length] === " " || result[pattern.length] === "\t" || result.length === pattern.length)
    ) {
      result = transform(result);
    }
  }
  return result;
}

// Runs via bash; with captureOutput, output is still streamed but also collected.
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

    let captured = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      captured += text;
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
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

// Question/answer collection over the CLI's readline interface.
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

  async collectAnswers(questions: QuestionDef[]): Promise<Record<string, string>> {
    const rl = this.#rl;

    // Take over readline for the duration of the prompt.
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
            process.stderr.write("  This question is required. Please enter a value.\n");
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

// Shared with the question tool via AGENT_TOOL_CONTEXT.
let currentInput: InputInterface | null = null;

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
    maxIterations: (agentConfig.maxIterations as number) || (resolved.maxIterations as number) || 100,
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
    profileName: (agentConfig.profileName as string) || (resolved.profileName as string),
    role: (agentConfig.role as string) || (resolved.role as string | undefined),
    profileBody: (agentConfig.profileBody as string) || (resolved.profileBody as string | undefined),
    stream:
      typeof agentConfig.stream === "boolean" ? agentConfig.stream : (resolved.stream as boolean | undefined),
    config: {
      ...config,
      maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
      maxRetries: resolved.maxRetries as number,
      toolRetryDelay: resolved.toolRetryDelay as number,
    },
    sessionId,
    abortSignal: (agentConfig.abortSignal as AbortSignal) || null,
    toolWhitelist: (agentConfig.toolWhitelist as string[]) || null,
  });

  core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
    registry: agent.commandRegistry,
    agent,
  });

  const explicitSessionId = cli.sessionId as string | undefined;
  if (explicitSessionId && sessionId === explicitSessionId) {
    if (await sessionExists(explicitSessionId)) {
      const entries = await readSessionEntries(explicitSessionId);
      if (entries.length > 0) {
        agent.isRestoring = true;
        const replayed = replayEntriesIntoContext(agent, entries);
        agent.isRestoring = false;
        if (replayed > 0) {
          console.log(`Session restored: ${replayed} messages replayed from ${explicitSessionId}`);
        }
      }
    }
  }

  return agent;
}

// Wires up readline + SessionManager + CliChannel and runs until quit.
export async function runInteractiveSession(
  cli: Record<string, unknown>,
  core: CoreContext,
  options: InteractiveSessionOptions = {},
): Promise<void> {
  const { resolved, config } = core;

  if (!resolved) {
    throw ExtensionError.ConfigFailed("ui-interactive-cli", "configuration must be resolved first");
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
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolFormat,
    toolOutputFmt: resolved.toolOutputFmt,
    hideUserMessage: true,
  });

  // Build LLM client — single instance owned by SessionManager
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    maxRetries: resolved.maxRetries,
    providers: (config.providers as ProviderDef[]) || [],
    markerMangler: new MarkerMangler(),
  });

  // Build agent function — uses llmClient from config (injected by SessionManager)
  const buildAgent = async (agentConfig: Record<string, unknown>): Promise<AgentLike> => {
    return buildInteractiveAgent(agentConfig, core, resolved, config, llmClient, cli);
  };

  // Create SessionManager — this owns the MessageBus and TaskManager internally
  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: cli,
    llmClient,
    modelRegistry: resolved.modelRegistry,
    coreConfig: config,
    taskConfig: {
      maxIterations: resolved.maxIterations || 100,
      taskProfile: resolved.taskProfile || "task-default",
      taskRole: resolved.taskDefaultRole || "",
    },
    profileManager: resolved.profileManager,
  });

  // Register the generic slash command name completion
  registerSlashCommandNameCompletion(core.completion);

  // Register completions from command definitions (extensions declare completions inline)
  // Hook into COMMANDS_REGISTER so completions are wired up as commands are registered
  core.hooks.on(
    HOOKS.COMMANDS_REGISTER,
    ({ registry }) => {
      registerCommandCompletions(core.completion, registry, "ui-interactive-cli");
    },
    "ui-interactive-cli",
  );

  // Print info
  const agent = sessionManager.getAgent();
  console.log(`hotdog ${pkg.version} (interactive mode)`);
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${agent?.sessionId || "unknown"}`);
  console.log("Type /quit or /exit to exit.\n");

  // Determine shell mode
  const shellMode = (config.uiInteractiveCli as Record<string, unknown>)?.shellMode;

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
  core.hooks.on(HOOKS.MODEL_CHANGE, ({ newModel }) => {
    rl.setPrompt(`(${newModel})> `);
  });

  // Re-display prompt after agent finishes
  core.hooks.on(HOOKS.TURN_END, ({ stopped }) => {
    if (stopped) {
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
      const cmd = sendToAssistant ? trimmed.replace(SEND_TO_ASSISTANT_SUFFIX_RE, "").trim() : trimmed;

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
      currentInput = new AsyncInteractiveCliInput(rl, lineHandler, addLineHandler);
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

/** Create the interactive-cli extension. */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("cli", {
          description: "Interactive CLI session",
          handler: async (cli: CliArgv, core: CoreContext) => {
            await runInteractiveSession(cli, core);
            return 0;
          },
        });
      },

      [HOOKS.AGENT_TOOL_CONTEXT]: (payload) => {
        const toolCtx = payload.toolCtx;
        if (currentInput) {
          toolCtx.set("input", currentInput);
        }
      },
    },

    cleanup: async () => {
      currentInput = null;
    },
  };
}
