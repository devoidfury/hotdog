// Slash Command Registry
// Allows extensions to register slash commands without being explicitly wired up in commands.js.
// Commands are registered via the slashCommandsRegister hook on the agent.

/**
 * Registry for slash commands.
 * Extensions register slash commands via the slashCommandsRegister hook.
 */
export class SlashCommandRegistry {
  constructor() {
    /** @type {Map<string, SlashCommandDefinition>} */
    this._commands = new Map();
  }

  /**
   * Register a slash command.
   *
   * @param {string} name - The command name (without leading `/`).
   * @param {Object} definition - Command definition.
   * @param {string} [definition.description] - Short description for help text.
   * @param {Function} [definition.handler] - Async function(agent, value, cmd) => { content?, error? }
   *   If not provided, falls back to COMMAND_DISPATCH hook.
   * @param {boolean} [definition.isUiCommand=false] - If true, handled by UI layer (not agent).
   * @param {Function} [definition.matches] - Custom matching function(cmd: string) => boolean
   *   Used to determine if this handler should parse the command. Called before parseCommand.
   */
  register(name, definition) {
    if (this._commands.has(name)) {
      console.warn(
        `[slash-command-registry] Command "${name}" already registered, overwriting.`,
      );
    }
    this._commands.set(name, {
      ...definition,
      isUiCommand: definition.isUiCommand === true,
    });
  }

  /**
   * Check if a command is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._commands.has(name);
  }

  /**
   * Get all registered command names.
   * @returns {string[]}
   */
  names() {
    return Array.from(this._commands.keys());
  }

  /**
   * Get a command definition by name.
   * @param {string} name
   * @returns {Object|undefined}
   */
  get(name) {
    return this._commands.get(name);
  }

  /**
   * Get all command definitions.
   * @returns {Map<string, Object>}
   */
  all() {
    return this._commands;
  }

  /**
   * Check if a raw command string matches any registered custom command.
   * @param {string} cmd - Raw command string (without leading `/`)
   * @returns {string|null} - The registered command name if matched, null otherwise
   */
  match(cmd) {
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
   * @returns {string}
   */
  generateHelpText() {
    const lines = [];
    for (const [name, def] of this._commands) {
      const desc = def.description || "";
      lines.push(`  /${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

/**
 * Create a new slash command registry.
 * @returns {SlashCommandRegistry}
 */
export function createSlashCommandRegistry() {
  return new SlashCommandRegistry();
}
