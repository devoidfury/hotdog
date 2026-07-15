// Registries for agent commands and CLI subcommands.

import { logger } from "../logger.ts";

// ── Agent Command Registry ───────────────────────────────────────────────────

export interface CommandDefinition {
  description?: string;
  handler?: (agent: unknown, value?: string | null, cmd?: unknown) => { content?: string; error?: string } | Promise<{ content?: string; error?: string }>;
  isUiCommand?: boolean;
  matches?: (cmd: string) => boolean;
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

    const normalized: CommandDefinition = {
      ...definition,
      isUiCommand: definition.isUiCommand === true,
    };

    this.#commands.set(name, normalized);
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
  match(cmd: string): string | null {
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
  handler?: (cliArgs: unknown, core: unknown) => number | Promise<number>;
  description?: string;
  options?: Record<string, unknown>;
}

/**
 * Registry for CLI subcommands (e.g., `hotdog info`, `hotdog review`).
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
