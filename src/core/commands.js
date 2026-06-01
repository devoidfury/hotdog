// Slash command dispatch for the agent.
// Handles parsing and execution of slash commands from the CLI.

/**
 * Parsed slash command (without the leading `/`).
 */
export const Command = {
  Help: "help",
  Quit: "quit",
  Clear: "clear",
  Tools: "tools",
  Thinking: "thinking",
  Tokens: "tokens",
  Regenerate: "regenerate",
  Unknown: "unknown",
};

/**
 * Parse a raw command string (without leading `/`) into a typed command object.
 *
 * @param {string} cmd - Raw command string (without leading `/`)
 * @param {Object} [registry] - Optional SlashCommandRegistry for custom commands
 * @returns {Object} Parsed command object { type, value }
 */
export function parseCommand(cmd, registry) {
  if (!cmd) return { type: Command.Unknown, value: null };

  // Check custom commands first (via registry)
  if (registry) {
    const customName = registry.match(cmd);
    if (customName) {
      const def = registry.get(customName);
      return {
        type: customName,
        value: cmd,
        _customCommand: customName,
        _handler: def.handler || null,
      };
    }
  }

  switch (cmd) {
    case "help":
      return { type: Command.Help, value: null };
    case "quit":
    case "exit":
      return { type: Command.Quit, value: null };
    case "clear":
      return { type: Command.Clear, value: null };
  }

  // clear <profile> — profile name stored in value, handler decides what to do
  if (cmd.startsWith("clear ")) {
    const profileName = cmd.slice(6).trim();
    return {
      type: Command.Clear,
      value: profileName || null,
    };
  }

  switch (cmd) {
    case "tools":
      return { type: Command.Tools, value: null };
    case "thinking":
      return { type: Command.Thinking, value: null };
  }

  if (cmd === "tokens") {
    return { type: Command.Tokens, value: null };
  }

  if (cmd === "regenerate") {
    return { type: Command.Regenerate, value: null };
  }

  return { type: Command.Unknown, value: cmd };
}
