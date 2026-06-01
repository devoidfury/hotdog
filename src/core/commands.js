// Slash command dispatch for the agent.
// Handles parsing and execution of slash commands from the CLI.

import { createSlashCommandRegistry } from "./slash-command-registry.js";

/**
 * Parsed slash command (without the leading `/`).
 */
export const Command = {
  Help: 'help',
  Quit: 'quit',
  Clear: 'clear',
  ClearProfile: 'clearProfile',
  Tools: 'tools',
  Thinking: 'thinking',
  Models: 'models',
  Model: 'model',
  Tokens: 'tokens',
  Regenerate: 'regenerate',
  Unknown: 'unknown',
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
    case 'help':
      return { type: Command.Help, value: null };
    case 'quit':
    case 'exit':
      return { type: Command.Quit, value: null };
    case 'clear':
      return { type: Command.Clear, value: null };
  }

  // clear <profile>
  if (cmd.startsWith('clear ')) {
    const profileName = cmd.slice(6).trim();
    return {
      type: profileName ? Command.ClearProfile : Command.Clear,
      value: profileName || null,
    };
  }

  switch (cmd) {
    case 'tools':
      return { type: Command.Tools, value: null };
    case 'thinking':
      return { type: Command.Thinking, value: null };
    case 'models':
    case 'model':
      return { type: Command.Models, value: null };
  }

  // model <name>
  if (cmd.startsWith('model ')) {
    const modelName = cmd.slice(6).trim();
    return {
      type: modelName ? Command.Model : Command.Models,
      value: modelName || null,
    };
  }

  if (cmd === 'tokens') {
    return { type: Command.Tokens, value: null };
  }

  if (cmd === 'regenerate') {
    return { type: Command.Regenerate, value: null };
  }

  return { type: Command.Unknown, value: cmd };
}

/**
 * Check if a command is handled by the UI layer (not delegated to agent).
 */
export function isUiCommand(type) {
  return [
    Command.Help,
    Command.Quit,
    Command.Tools,
    Command.Thinking,
  ].includes(type);
}
