// Registries for agent commands and CLI subcommands.
// "Commands" are the abstract concept —
// slash commands (/cmd) are one UI implementation for invoking them.

import { logger } from "../logger.js";

// ── Agent Command Registry ───────────────────────────────────────────────────

/**
 * Registry for agent-level commands (e.g., /compact, /model, /clear).
 *
 * Commands are dispatched by the agent at runtime. Extensions register
 * commands via the COMMANDS_REGISTER hook.
 *
 * Definition shape:
 *   {
 *     description?: string,
 *     handler?: (agent, value, cmd) => { content?, error? },
 *     isUiCommand?: boolean,      // handled by UI layer instead of agent
 *     matches?: (cmd: string) => boolean  // custom pattern matching
 *   }
 */
export class AgentCommandRegistry {
  constructor() {
    /** @type {Map<string, Object>} */
    this._commands = new Map();
  }

  /**
   * Register an agent command.
   *
   * @param {string} name - The command name.
   * @param {Object} definition - Command definition with handler, description, etc.
   */
  register(name, definition) {
    if (this._commands.has(name)) {
      logger.warn(
        `[command-registry] Command "${name}" already registered, overwriting.`,
      );
    }

    const normalized = {
      ...definition,
      isUiCommand: definition.isUiCommand === true,
    };

    this._commands.set(name, normalized);
  }

  /** Check if a command is registered. */
  has(name) {
    return this._commands.has(name);
  }

  /** Get all registered command names. */
  names() {
    return Array.from(this._commands.keys());
  }

  /** Get a command definition by name. */
  get(name) {
    return this._commands.get(name);
  }

  /** Get all command definitions. */
  all() {
    return this._commands;
  }

  /**
   * Check if a raw command string matches any registered custom command.
   * Iterates registered commands and calls their `matches` function.
   *
   * @param {string} cmd - Raw command string
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
   * Agent commands are prefixed with `/` (for slash command UI).
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
 * Create a new agent command registry.
 * @returns {AgentCommandRegistry}
 */
export function createCommandRegistry() {
  return new AgentCommandRegistry();
}

// ── CLI Subcommand Registry ──────────────────────────────────────────────────

/**
 * Registry for CLI subcommands (e.g., `hotdog info`, `hotdog review`).
 *
 * Subcommands are dispatched by main.js after CLI parsing. Extensions register
 * subcommands via the CLI_SUBCOMMANDS_REGISTER hook.
 *
 * Metadata (description, options) is pre-registered from extension.json by the
 * extension loader. The hook then attaches the actual handler function.
 *
 * Definition shape:
 *   {
 *     handler?: (cliArgs, core) => number,  // returns exit code
 *     description?: string,
 *     options?: Object,  // subcommand-specific options for help text
 *   }
 */
export class CliSubcommandRegistry {
  constructor() {
    /** @type {Map<string, Object>} */
    this._commands = new Map();
  }

  /**
   * Register a CLI subcommand.
   *
   * If an entry already exists without a handler (metadata placeholder from
   * extension.json), merges the new handler with existing metadata.
   *
   * @param {string} name - The subcommand name (e.g., "info", "show-prompt").
   * @param {Object} definition - Subcommand definition with handler, description, etc.
   */
  register(name, definition) {
    if (this._commands.has(name)) {
      const existing = this._commands.get(name);
      // If existing has no handler (metadata placeholder from extension.json),
      // merge the new handler with existing metadata.
      if (!existing.handler && definition.handler) {
        definition = {
          ...existing,
          ...definition,
        };
      } else {
        logger.warn(
          `[subcommand-registry] Subcommand "${name}" already registered, overwriting.`,
        );
      }
    }

    this._commands.set(name, { ...definition });
  }

  /** Check if a subcommand is registered. */
  has(name) {
    return this._commands.has(name);
  }

  /** Get all registered subcommand names. */
  names() {
    return Array.from(this._commands.keys());
  }

  /** Get a subcommand definition by name. */
  get(name) {
    return this._commands.get(name);
  }

  /** Get all subcommand definitions. */
  all() {
    return this._commands;
  }

  /**
   * Generate help text for all registered subcommands.
   * CLI subcommands are NOT prefixed with `/`.
   */
  generateHelpText() {
    const lines = [];
    for (const [name, def] of this._commands) {
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
