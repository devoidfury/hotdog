// Registries for agent commands and CLI subcommands.

import { logger } from "../logger.ts";

// ── Type Definitions ─────────────────────────────────────────────────────────

/**
 * Minimal Agent interface for command handlers.
 * Defines the public API surface that command handlers need from Agent.
 * Avoids circular imports by describing only what's used.
 */
export interface CommandAgent {
  cancelled: boolean;
  clearContext(): Promise<void>;
  enqueue(text: string): void;
  getTokenUsage(): {
    turns: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    totalTokens: number;
    lastPromptTokens?: number;
    lastCachedTokens?: number;
    lastCompletionTokens?: number;
    lastTotalTokens?: number;
  };
  hideTools: boolean;
  hideThinking: boolean;
  systemPrompt: string | null;
  reasoningEffort: string | undefined;
  ensureSystemPrompt(): Promise<void>;
  emitOutput(type: string, data: Record<string, unknown>): void;
}

/**
 * Minimal Core interface for CLI subcommand handlers.
 * Structurally compatible with CoreInfrastructure (from main.ts) and
 * CoreContext (from types.ts) so that real core instances can be
 * passed to subcommand handlers without casts.
 *
 * Avoids circular imports by defining only the shape needed.
 */
export interface SubcommandCore {
  hooks: {
    notifyHooks(hookName: string, data: unknown): void;
  };
  toolRegistry: {
    register(name: string, tool: unknown): void;
    getAll(): [string, unknown][];
  };
  services: {
    get(name: string): unknown;
  };
  config?: Record<string, unknown>;
  configRegistry: {
    registerCliFlags(flags: unknown[]): void;
    registerConfigParams(params: unknown[]): void;
  };
  cliSubcommandRegistry: {
    register(name: string, definition: SubcommandDefinition): void;
    get(name: string): SubcommandDefinition | undefined;
    names(): string[];
  };
  service(name: string): unknown;
  resolved?: Record<string, unknown>;
  buildConfig?: (cli: Record<string, unknown>) => Promise<{
    resolved: Record<string, unknown>;
    modelRegistry: Record<string, unknown>;
    providers: unknown[];
  }>;
}

// ── CLI Argument Type ────────────────────────────────────────────────────────

/**
 * CLI argument values parsed from the command line.
 * Keys match the config schema property names (camelCase).
 * Structurally identical to CliArgv in config/index.ts.
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
 * Command handler function type.
 */
export type CommandHandler = (
  agent: CommandAgent,
  value: string | null,
  cmd?: ParsedCommand,
) => { content?: string; error?: string } | Promise<{ content?: string; error?: string }>;

// ── Agent Command Registry ───────────────────────────────────────────────────

export interface CommandDefinition {
  description?: string;
  handler?: CommandHandler;
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
  handler?: (cliArgs: CliArgv, core: SubcommandCore) => number | Promise<number>;
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
