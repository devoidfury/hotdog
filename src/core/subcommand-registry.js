// CLI Subcommand Registry
// Allows extensions to register CLI subcommands without being explicitly wired up in main.js.

/**
 * Registry for CLI subcommands.
 * Extensions register subcommands via the cli:subcommandsRegister hook.
 */
export class CliSubcommandRegistry {
  constructor() {
    /** @type {Map<string, SubcommandDefinition>} */
    this._subcommands = new Map();
  }

  /**
   * Register a subcommand.
   *
   * @param {string} name - The subcommand name (e.g., "info", "show-prompt").
   * @param {Object} definition - Subcommand definition.
   * @param {Function} definition.handler - Async function(cliArgs, config) => void
   * @param {string} [definition.description] - Short description for help text.
   * @param {Object} [definition.options] - Subcommand-specific options (for help text).
   * @param {boolean} [definition.requiresConfig=true] - Whether this subcommand needs config loaded.
   * @param {boolean} [definition.requiresCore=false] - Whether this subcommand needs the full core.
   */
  register(name, definition) {
    if (this._subcommands.has(name)) {
      const existing = this._subcommands.get(name);
      // Only warn if we're overwriting an existing handler (not just populating from metadata)
      if (existing.handler) {
        console.warn(
          `[subcommand-registry] Subcommand "${name}" already registered, overwriting.`,
        );
      }
      // If the existing entry has no handler (metadata placeholder), keep its metadata
      // but replace the handler
      if (!existing.handler && definition.handler) {
        definition = {
          ...existing,
          ...definition,
          requiresConfig: definition.requiresConfig !== false,
          requiresCore: definition.requiresCore === true,
        };
      }
    }
    this._subcommands.set(name, {
      ...definition,
      requiresConfig: definition.requiresConfig !== false,
      requiresCore: definition.requiresCore === true,
    });
  }

  /**
   * Check if a subcommand is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._subcommands.has(name);
  }

  /**
   * Get all registered subcommand names.
   * @returns {string[]}
   */
  names() {
    return Array.from(this._subcommands.keys());
  }

  /**
   * Get a subcommand definition by name.
   * @param {string} name
   * @returns {Object|undefined}
   */
  get(name) {
    return this._subcommands.get(name);
  }

  /**
   * Get all subcommand definitions.
   * @returns {Map<string, Object>}
   */
  all() {
    return this._subcommands;
  }

  /**
   * Generate help text for all registered subcommands.
   * @returns {string}
   */
  generateHelpText() {
    const lines = [];
    for (const [name, def] of this._subcommands) {
      const desc = def.description || "";
      lines.push(`  ${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

/**
 * Create a new CLI subcommand registry.
 * @returns {CliSubcommandRegistry}
 */
export function createSubcommandRegistry() {
  return new CliSubcommandRegistry();
}
