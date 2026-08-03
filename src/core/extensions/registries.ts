// Registries for agent commands and CLI subcommands.

import { logger } from "../logger.ts";
import { CoreContext } from "./types.ts";
import type { CompletionHandler } from "../completion.ts";
import type { Agent } from "../agent.ts";

// ── CLI Argument Type ────────────────────────────────────────────────────────

/**
 * CLI argument values parsed from the command line.
 * Keys match the config schema property names (camelCase).
 * Note: nullable string properties accept both null and undefined
 * because the CLI parser produces null for missing values.
 */
export interface CliArgv {
  config?: string | null;
  configDir?: string | null;
  profilesPath?: string | null;
  model?: string | null;
  prompt?: string | null;
  systemPromptTemplate?: string | null;
  [key: string]: unknown;
}

// ── Parsed Command Type ──────────────────────────────────────────────────────

/**
 * Parsed command object from command text.
 */
export interface ParsedCommand {
  type: string;
  value: string | null;
  _customCommand?: string;
  _handler?: CommandHandler | null;
}

/**
 * Result returned by command handlers.
 * The `action` field is optional for backward compatibility;
 * when omitted, DISPLAY is assumed.
 */
export interface CommandResult {
  content?: string;
  error?: string;
  action?: number; // bitflags from ACTIONS
}

/**
 * Command handler function type.
 */
export type CommandHandler = (
  agent: Agent,
  value: string | null,
  cmd?: ParsedCommand,
) => CommandResult | Promise<CommandResult>;

// ── Agent Command Registry ───────────────────────────────────────────────────

export interface CommandDefinition {
  description?: string;
  handler?: CommandHandler;
  matches?: (cmd: string) => boolean;
  /**
   * Optional completion handler for tab completion of this command's arguments.
   * Called when the user is typing arguments for this specific command.
   * The CompletionContext.command will be set to this command's name.
   */
  completion?: CompletionHandler;
}

/**
 * Registry for agent-level commands (e.g., /compact, /model, /clear).
 */
export class AgentCommandRegistry {
  #commands: Map<string, CommandDefinition>;

  constructor() {
    this.#commands = new Map();
  }

  /**
   * Register an agent command.
   */
  register(name: string, definition: CommandDefinition): void {
    if (this.#commands.has(name)) {
      logger.warn(
        `[command-registry] Command "${name}" already registered, overwriting.`,
      );
    }

    this.#commands.set(name, { ...definition });
  }

  has(name: string): boolean {
    return this.#commands.has(name);
  }

  names(): string[] {
    return Array.from(this.#commands.keys());
  }

  get(name: string): CommandDefinition | undefined {
    return this.#commands.get(name);
  }

  all(): Map<string, CommandDefinition> {
    return this.#commands;
  }

  /**
   * Check if a raw command string matches any registered custom command.
   */
  match(cmd: string | null | undefined): string | null {
    if (!cmd) return null;
    for (const [name, def] of this.#commands) {
      if (def.matches && def.matches(cmd)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Generate help text for all registered commands.
   */
  generateHelpText(): string {
    const lines: string[] = [];
    for (const [name, def] of this.#commands) {
      const desc = def.description || "";
      lines.push(`  /${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

/**
 * Create a new agent command registry.
 */
export function createCommandRegistry(): AgentCommandRegistry {
  return new AgentCommandRegistry();
}

// ── CLI Subcommand Registry ──────────────────────────────────────────────────

export interface SubcommandDefinition {
  handler?: (cliArgs: CliArgv, core: CoreContext) => number | Promise<number>;
  description?: string;
  options?: Record<string, unknown>;
}

/**
 * Registry for CLI subcommands (e.g., `hotdog info`, `hotdog sessions`).
 */
export class CliSubcommandRegistry {
  #commands: Map<string, SubcommandDefinition>;

  constructor() {
    this.#commands = new Map();
  }

  /**
   * Register a CLI subcommand.
   */
  register(name: string, definition: SubcommandDefinition): void {
    if (this.#commands.has(name)) {
      const existing = this.#commands.get(name)!;
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

    this.#commands.set(name, { ...definition });
  }

  has(name: string): boolean {
    return this.#commands.has(name);
  }

  names(): string[] {
    return Array.from(this.#commands.keys());
  }

  get(name: string): SubcommandDefinition | undefined {
    return this.#commands.get(name);
  }

  all(): Map<string, SubcommandDefinition> {
    return this.#commands;
  }

  /**
   * Generate help text for all registered subcommands.
   */
  generateHelpText(): string {
    const lines: string[] = [];
    for (const [name, def] of this.#commands) {
      const desc = def.description || "";
      lines.push(`  ${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

/**
 * Create a new CLI subcommand registry.
 */
export function createSubcommandRegistry(): CliSubcommandRegistry {
  return new CliSubcommandRegistry();
}
