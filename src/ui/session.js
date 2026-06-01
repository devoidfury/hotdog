// Interactive CLI session — thin readline loop.
//
// The UI layer is now a dumb terminal: it only knows how to
// read input and render output events. All business logic
// (command execution, state changes) lives in the core.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, Command } from "../core/commands.js";
import { lspClientCache } from "../../ext/lsp/client-cache.js";

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
  :!<command>  - Vim-like alias for shell commands (e.g., :!ls)
`;

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
 * @param {Function} [setPromptFn] - Optional callback to set the prompt function for onMessageProcessed
 */
export function runInteractiveSession({
  rl,
  bus,
  sink,
  resolved,
  setPromptFn,
}) {
  // Set the prompt function so the bus can call it after each message
  if (setPromptFn) {
    setPromptFn(() => rl.prompt());
  }

  rl.prompt();

  process.on("SIGINT", () => {
    console.log("\nInterrupted. Cancelling...");
    bus.cancel();
    console.log("Cancelled.");
    rl.prompt();
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle shell commands directly (UI-specific, doesn't go through agent)
    if (trimmed.startsWith("/sh ") || trimmed.startsWith("sh ") ||
        trimmed.startsWith(":!") || trimmed.startsWith("!")) {
      handleShellCommand(trimmed, rl);
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

  rl.on("close", () => {
    console.log("\nGoodbye!");
    // Quick cleanup: force-kill all LSP clients synchronously
    for (const [, client] of lspClientCache) {
      if (client.process && client.process.kill) {
        try {
          client.process.kill("SIGKILL");
        } catch {}
      }
    }
    lspClientCache.clear();
    process.exit(0);
  });
}

/**
 * Handle shell commands directly (UI-specific, terminal-bound).
 */
function handleShellCommand(line, rl) {
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
  const proc = spawn(cmd, [], {
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
    console.log(output);
    if (output) console.log("\n");
    console.log(`[exited with code ${code}]\n`);
    rl.prompt();
  });
  proc.on("error", (err) => {
    console.log(`Error: ${err.message}\n`);
    rl.prompt();
  });
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
