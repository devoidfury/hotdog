// Interactive CLI session — thin readline loop.
//
// The UI layer is now a dumb terminal: it only knows how to
// read input and render output events. All business logic
// (command execution, state changes) lives in the core.

import readline from "node:readline";
import { parseCommand, Command } from "../core/commands.js";
import { HOOKS } from "../hooks.js";
import { create } from "../../extensions/run-shell-command/index.js";

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

// Create shell command extension instance
const shellCommandExt = create({});

/**
 * Create and run an interactive CLI session.
 *
 * The UI is thin: it only reads input, dispatches to the bus,
 * and renders events from the sink. No agent state manipulation.
 *
 * @param {object} options
 * @param {readline.Interface} rl - readline interface
 * @param {import("../agent/message_bus.js").MessageBus} bus - The MessageBus instance
 * @param {import("../context/output.js").OutputSink} sink - The CliOutputSink instance
 * @param {object} resolved - resolved agent config (from buildConfig().resolved)
 * @param {Object} [hooks] - Optional HookSystem instance for listening to model changes
 */
export function runInteractiveSession({ bus, sink, resolved, onClose, hooks }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
  });

  // Listen for model changes and update the readline prompt
  if (hooks) {
    const agent = bus?.sessionManager?.getAgent();
    if (agent) {
      hooks.on(HOOKS.MODEL_CHANGE, (data) => {
        rl.setPrompt(`(${data.newModel})> `);
      });

      // Re-display prompt after agent finishes running
      hooks.on(HOOKS.AGENT_AFTER_RUN, () => {
        setImmediate(() => rl.prompt());
      });
    }
  }

  rl.on("line", async (line) => {
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
  });

  rl.on("close", async () => {
    console.log("\nGoodbye!");
    if (onClose) {
      try {
        await onClose();
      } catch (e) {
        console.error(`[session] cleanup error: ${e.message}`);
      }
    }
    process.exit(0);
  });

  rl.on("SIGINT", () => {
    // Override readline's default SIGINT behavior (which calls rl.close()).
    // Just return to the prompt and cancel any running agent operation.
    bus.cancel();
    console.log("Interrupted (/quit, /exit, or ctrl-d to exit)");
    rl.prompt();
  });

  rl.prompt();
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
  const result = await shellCommandExt.execute(cmd);
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
 *
 * UI-only commands (Help, Quit) are handled here directly.
 * All other commands go through bus.executeCommand().
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
      // Shell is handled at the top-level line handler, shouldn't reach here
      console.log("Shell commands are handled directly.\n");
      rl.prompt();
      return;
  }

  // All other commands go through the bus → agent → COMMAND_RESULT event
  bus.executeCommand(cmdText).then(() => rl.prompt());
}
