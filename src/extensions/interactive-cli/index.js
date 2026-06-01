// Interactive CLI Extension
// Provides the interactive CLI session with readline loop.
// Registers a default subcommand (empty name) that main.js dispatches to
// when no subcommand is provided.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, Command } from "../../core/commands.js";
import { HOOKS } from "../../core/hooks.js";
import { CliOutputSink } from "../../core/ui/cli.js";
import { LlmClient } from "../../core/llm-client/client.js";
import { MarkerMangler } from "../../core/marker-mangler.js";
import { TaskManager } from "../../core/session/task-manager.js";
import { SessionManager } from "../../core/session/index.js";
import { MessageBus } from "../../core/index.js";
import { Agent } from "../../core/agent.js";
import { readSessionEntries, sessionExists, replayEntriesIntoContext } from "../../core/session/session-log.js";
import { Message } from "../../core/context/message.js";

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
  /sh <command> - Run a shell command and display output
  :!<command>   - Vim-like alias for shell commands (e.g., :!ls)
`;

/**
 * AsyncInteractiveCliInput — collects answers using the CLI's readline interface.
 * Implements the Input interface for question/answer collection.
 *
 * This does NOT create a separate readline instance. Instead, it takes over
 * the existing readline by temporarily removing the main 'line' handler,
 * collecting answers via rl.question(), then restoring the handler.
 */
export class AsyncInteractiveCliInput {
  /**
   * @param {readline.Interface} rl - The readline interface to use for input
   * @param {Function} onLine - The main 'line' handler to temporarily remove
   * @param {Function} addLineHandler - Function to re-add the line handler
   */
  constructor(rl, onLine, addLineHandler) {
    this._rl = rl;
    this._onLine = onLine;
    this._addLineHandler = addLineHandler;
  }

  isInteractive() {
    return true;
  }

  /**
   * Collect answers to questions using the readline interface.
   * Temporarily takes over readline input, collects answers, then restores.
   *
   * @param {Array} questions - Array of question definitions
   * @returns {Object} Answers keyed by question key
   */
  async collectAnswers(questions) {
    const rl = this._rl;

    // Temporarily take over readline by removing the main line handler
    rl.removeListener("line", this._onLine);

    const answers = {};
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
          const line = await new Promise((resolve) => {
            rl.question(prompt, (response) => {
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
            if (
              !isNaN(idx) &&
              idx >= 1 &&
              idx <= options.length
            ) {
              answer = options[idx - 1];
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
      this._addLineHandler(this._onLine);
    }

    return answers;
  }
}

/**
 * Create the interactive-cli extension.
 * Registers a "cli" subcommand for interactive mode.
 * main.js dispatches to "cli" when no subcommand is provided.
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @returns {Object} Extension instance.
 */
export function create(core) {
  // Lazily load shell command extension when needed
  let shellCommandExt = null;

  // Store reference for tool context
  let currentInput = null;

  // Register the "cli" subcommand
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("cli", {
      description: "Interactive CLI session",
      requiresConfig: true,
      handler: async (cli, core) => {
        await runInteractiveSession(cli, core);
      },
    });
  }

  return {
    hooks: core.hooks
      ? {
          // Register "cli" subcommand via hook
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
            registry.register("cli", {
              description: "Interactive CLI session",
              requiresConfig: true,
              handler: async (cli, core) => {
                await runInteractiveSession(cli, core);
              },
            });
          },

          // Provide input interface to tool context
          [HOOKS.AGENT_TOOL_CONTEXT]: ({ toolCtx }) => {
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

  /**
   * Run the interactive CLI session.
   */
  async function runInteractiveSession(cli, core) {
    const { resolved, config } = core;

    // Create output sink
    const palette = CliOutputSink.resolve(
      cli.colors !== false,
      resolved.theme || "dark",
      config.colors || null,
    );

    const sink = new CliOutputSink({
      ...resolved,
      palette,
      thinkerFormat: cli.thinker ?? config.thinker ?? "[Thinking: {}]",
      toolFormat: cli.toolfmt ?? config.toolfmt ?? "  → {} {}",
      toolOutputFmt:
        cli.toolOutputFmt ?? config.toolOutputFmt ?? "----\n{}\n----",
    });

    // Build LLM client
    const llmClient = new LlmClient({
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      stream: resolved.stream,
      chatTimeoutSecs: resolved.chatTimeout,
      providers: config.providers || [],
      markerMangler: new MarkerMangler(),
    });

    // Build agent function
    const buildAgent = async (agentConfig) => {
      const sessionId = agentConfig.sessionId || crypto.randomUUID();
      const agent = new Agent({
        hooks: core.hooks,
        toolRegistry: core.toolRegistry,
        llmClient,
        model: agentConfig.model || resolved.model,
        maxIterations: agentConfig.maxIterations || config.maxIterations || 1000,
        maxTokens: config.maxTokens || 32000,
        hideTools: agentConfig.hideTools ?? resolved.hideTools,
        hideThinking: agentConfig.hideThinking ?? resolved.hideThinking,
        showTokenUse: agentConfig.showTokenUse ?? resolved.showTokenUse,
        sink: agentConfig.sink || sink,
        modelRegistry: resolved.modelRegistry || {},
        profileName: agentConfig.profileName || resolved.profileName,
        role: agentConfig.role || resolved.role,
        profileBody: agentConfig.profileBody || resolved.profileBody,
        stream: agentConfig.stream ?? resolved.stream,
        config,
        sessionId,
        abortSignal: agentConfig.abortSignal || null,
        toolWhitelist: agentConfig.toolWhitelist || null,
      });

      await agent.ensureSystemPrompt();

      // Emit hook for extensions to register slash commands
      core.hooks.emit(HOOKS.SLASH_COMMANDS_REGISTER, {
        registry: agent.getSlashCommandRegistry(),
        agent,
      });

      // Restore session from disk if a session ID was explicitly provided
      const explicitSessionId = cli.sessionId;
      if (explicitSessionId && sessionId === explicitSessionId) {
        if (sessionExists(explicitSessionId)) {
          const entries = readSessionEntries(explicitSessionId);
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
      modelRegistry: resolved.modelRegistry,
      config,
      hooks: core.hooks,
      maxIterations: config.maxIterations || 1000,
    });

    // Create SessionManager
    const sessionManager = await SessionManager.create({
      hooks: core.hooks,
      extensions: core.extensions,
      buildAgent,
      initialConfig: { sessionId: cli.sessionId || null },
    });

    // Wire taskManager to sessionManager
    taskManager.setSessionManager(sessionManager);

    // Create MessageBus
    const bus = new MessageBus({ sessionManager, sink });

    // Wire up task completion
    taskManager.setBus(bus);

    // Print info
    const agent = sessionManager.getAgent();
    console.log("oa-agent 0.1.0 (interactive mode)");
    console.log(`Model: ${resolved.model}`);
    console.log(`Profile: ${resolved.profileName}`);
    console.log(`Session: ${agent?.sessionId || "unknown"}`);
    console.log("Type /quit or /exit to exit.\n");

    // Start interactive session
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `(${resolved.model})> `,
    });

    // Define the line handler so we can reference it for the input interface
    /** @type {Function} */
    let lineHandler;

    // Helper to add line handler (used by AsyncInteractiveCliInput to restore)
    const addLineHandler = (handler) => {
      rl.on("line", handler);
    };

    // Create the input interface for question tool
    // We need to set it up after defining lineHandler
    const setupInput = () => {
      currentInput = new AsyncInteractiveCliInput(rl, lineHandler, addLineHandler);
    };

    // Listen for model changes and update the readline prompt
    core.hooks.on(HOOKS.MODEL_CHANGE, (data) => {
      rl.setPrompt(`(${data.newModel})> `);
    });

    // Re-display prompt after agent finishes processing
    core.hooks.on(HOOKS.TURN_END, (data) => {
      if (data.stopped) {
        setImmediate(() => rl.prompt());
      }
    });

    // Define and register the line handler
    lineHandler = async (line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        rl.prompt();
        return;
      }

      // Handle shell commands directly (UI-specific, doesn't go through agent)
      if (
        trimmed.startsWith("/sh ") ||
        trimmed.startsWith("/shell ") ||
        trimmed.startsWith(":!") ||
        trimmed.startsWith("!")
      ) {
        await handleShellCommand(trimmed, rl);
        return;
      }

      // Handle slash commands — delegate to bus for execution
      if (trimmed.startsWith("/")) {
        const cmdText = trimmed.slice(1).trim().toLowerCase();
        handleSlashCommand(cmdText, bus, rl);
        return;
      }

      // Regular text input — enqueue for agent processing
      bus.enqueue(trimmed);
    };

    rl.on("line", lineHandler);

    // Now set up the input interface with the line handler
    setupInput();

    rl.on("close", async () => {
      console.log("\nGoodbye!");
      const interactiveSessionId = sessionManager.sessionId();
      if (interactiveSessionId) {
        console.log(`Session: ${interactiveSessionId}`);
      }
      currentInput = null;
      await core.extensions.cleanup();
      process.exit(0);
    });

    rl.on("SIGINT", () => {
      bus.cancel();
      console.log("Interrupted (/quit, /exit, or ctrl-d to exit)");
      rl.prompt();
    });

    rl.prompt();

    // Run the message bus (non-awaited, fire-and-forget)
    bus.run();
  }

  /**
   * Handle shell commands directly (UI-specific, terminal-bound).
   */
  async function handleShellCommand(line, rl) {
    let cmd;
    if (line.startsWith("/sh ") || line.startsWith("sh ")) {
      cmd = line.replace(/^\/?sh\s+/, "");
    } else if (line.startsWith(":!") || line.startsWith("!")) {
      cmd = line.replace(/^:?!/, "");
    }

    if (!cmd) {
      console.log("Usage: /sh <command>\n");
      rl.prompt();
      return;
    }

    console.log(`\n$ ${cmd}\n`);
    const result = await getShellCommandExt().execute(cmd);
    if (result.content) {
      console.log(result.content);
    } else if (result.error) {
      console.log(`${result.error}\n`);
    }
    console.log("");
    rl.prompt();
  }

  /**
   * Handle a slash command by delegating to the bus.
   */
  function handleSlashCommand(cmdText, bus, rl) {
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

      case Command.Shell:
        console.log("Shell commands are handled directly.\n");
        rl.prompt();
        return;
    }

    // All other commands go through the bus → agent → COMMAND_RESULT event
    bus.executeCommand(cmdText).then(() => rl.prompt());
  }

  /**
   * Lazily load the shell command extension.
   * @returns {Promise<Object>}
   */
  async function getShellCommandExt() {
    if (!shellCommandExt) {
      // Try to get from core extensions if available
      if (core.extensions?.has("run-shell-command")) {
        shellCommandExt = core.extensions.get("run-shell-command");
      } else {
        // Fallback: create inline shell command handler
        shellCommandExt = createInlineShellCommand();
      }
    }
    return shellCommandExt;
  }
}

/**
 * Create an inline shell command handler as fallback.
 * @returns {Object}
 */
function createInlineShellCommand() {
  return {
    execute(command) {
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

        proc.on("close", (code) => {
          const output = [stdout, stderr].filter(Boolean).join("\n");
          resolve({
            content: output
              ? `${output}\n\n[exited with code ${code}]`
              : `[exited with code ${code}]`,
          });
        });

        proc.on("error", (err) => {
          resolve({ error: `Error: ${err.message}` });
        });
      });
    },
  };
}
