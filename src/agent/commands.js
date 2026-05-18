// Slash command dispatch for the agent.
// Handles parsing and execution of slash commands from the CLI.

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
  Compact: 'compact',
  Prompt: 'prompt',
  Regenerate: 'regenerate',
  Skill: 'skill',
  Shell: 'shell',
  Unknown: 'unknown',
};

/**
 * Parse a raw command string (without leading `/`) into a typed command object.
 */
export function parseCommand(cmd) {
  if (!cmd) return { type: Command.Unknown, value: null };

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

  // compact [n] [--compact-debug]
  if (cmd.startsWith('compact')) {
    const parts = cmd.split(/\s+/);
    let keep = null;
    let debug = false;
    for (const part of parts.slice(1)) {
      if (part === '--compact-debug') {
        debug = true;
      } else if (!Number.isNaN(Number(part))) {
        keep = parseInt(part, 10);
      }
    }
    return { type: Command.Compact, value: { keep, debug } };
  }

  // sh <command>
  if (cmd.startsWith('sh ')) {
    const command = cmd.slice(3).trim();
    return {
      type: command ? Command.Shell : Command.Shell,
      value: command || null,
    };
  }

  // !<command> or :!<command> (vim-like shell escape)
  if (cmd.startsWith('!') || cmd.startsWith(':!')) {
    const command = cmd.startsWith(':!') ? cmd.slice(2).trim() : cmd.slice(1).trim();
    return {
      type: Command.Shell,
      value: command || null,
    };
  }

  // prompt:<name> [args]
  if (cmd.startsWith('prompt:')) {
    const rest = cmd.slice(7);
    const spaceIdx = rest.indexOf(' ');
    const name = spaceIdx >= 0 ? rest.slice(0, spaceIdx).trim() : rest.trim();
    const args = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';
    return { type: Command.Prompt, value: { name, args: args || undefined } };
  }

  if (cmd === 'regenerate') {
    return { type: Command.Regenerate, value: null };
  }

  // skill:<name> or skill:
  if (cmd.startsWith('skill:')) {
    const name = cmd.slice(6).trim();
    if (!name) {
      return { type: Command.Skill, value: null }; // List skills
    }
    return { type: Command.Skill, value: name };
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
    Command.Shell,
  ].includes(type);
}
