// Unified command registries for extensions.
// Supports both agent-level commands and CLI subcommands.
// "Commands" are the abstract concept — slash commands (/cmd) are one
// UI implementation for invoking them in the interactive CLI.

/**
 * Registry for agent-level commands and CLI subcommands.
 *
 * @param {'command' | 'cli'} type - Registry type that determines behavior.
 */
export class CommandRegistry {
  constructor(type) {
    this._type = type;
    /** @type {Map<string, Object>} */
    this._commands = new Map();
  }

  /**
   * Register a command.
   *
   * For agent-level commands:
   * @param {string} name - The command name.
   * @param {Object} definition - Command definition.
   * @param {string} [definition.description] - Short description for help text.
   * @param {Function} [definition.handler] - Async function(agent, value, cmd) => { content?, error? }
   * @param {boolean} [definition.isUiCommand=false] - If true, handled by UI layer.
   * @param {Function} [definition.matches] - Custom matching function(cmd: string) => boolean
   *
   * For CLI subcommands:
   * @param {string} name - The subcommand name (e.g., "info", "show-prompt").
   * @param {Object} definition - Subcommand definition.
   * @param {Function} definition.handler - Async function(cliArgs, config) => void
   * @param {string} [definition.description] - Short description for help text.
   * @param {Object} [definition.options] - Subcommand-specific options (for help text).
    */
  register(name, definition) {
    if (this._commands.has(name)) {
      const existing = this._commands.get(name);
      // For CLI subcommands: if existing has no handler (metadata placeholder),
      // merge the new handler with existing metadata
      if (this._type === 'cli' && !existing.handler && definition.handler) {
        definition = {
          ...existing,
          ...definition,
        };
      } else {
        console.warn(
          `[${this._type}-registry] Command "${name}" already registered, overwriting.`,
        );
      }
    }

    const normalized = { ...definition };

    if (this._type === 'command') {
      normalized.isUiCommand = definition.isUiCommand === true;
    }

    this._commands.set(name, normalized);
  }

  /**
   * Check if a command is registered.
   */
  has(name) {
    return this._commands.has(name);
  }

  /**
   * Get all registered command names.
   */
  names() {
    return Array.from(this._commands.keys());
  }

  /**
   * Get a command definition by name.
   */
  get(name) {
    return this._commands.get(name);
  }

  /**
   * Get all command definitions.
   */
  all() {
    return this._commands;
  }

  /**
   * Check if a raw command string matches any registered custom command.
   * Only applicable for command registry type.
   * @param {string} cmd - Raw command string
   * @returns {string|null} - The registered command name if matched, null otherwise
   */
  match(cmd) {
    if (this._type !== 'command') return null;
    if (!cmd) return null;
    for (const [name, def] of this._commands) {
      if (def.matches && def.matches(cmd)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Generate help text for all registered commands.
   * Agent commands are prefixed with `/` (for slash command UI), CLI subcommands are not.
   */
  generateHelpText() {
    const lines = [];
    const prefix = this._type === 'command' ? '/' : '';
    for (const [name, def] of this._commands) {
      const desc = def.description || "";
      lines.push(`  ${prefix}${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

/**
 * Create a new command registry for agent-level commands.
 * Commands are the abstract concept — slash commands (/cmd) are one
 * UI implementation for invoking them in the interactive CLI.
 * @returns {CommandRegistry}
 */
export function createCommandRegistry() {
  return new CommandRegistry('command');
}

/**
 * @deprecated Use createCommandRegistry() instead.
 * Kept for backward compatibility.
 */
export function createSlashCommandRegistry() {
  return createCommandRegistry();
}

/**
 * Create a new CLI subcommand registry.
 * @returns {CommandRegistry}
 */
export function createSubcommandRegistry() {
  return new CommandRegistry('cli');
}
