import { ACTIONS } from "../commands.ts";
import { HOOKS } from "../hooks.ts";
import { isPromise } from "../../utils/promise.ts";
import { logger } from "../logger.ts";
import type { CoreContext } from "./types.ts";
import type { CompletionHandler } from "../completion.ts";
import type { Agent } from "../agent.ts";
import type { HookSystem } from "../hooks.ts";
import { CliArgv } from "../config/index.ts";

// ── Parsed Command Type ──────────────────────────────────────────────────────

export interface ParsedCommand {
  type: string;
  value: string | null;
  _customCommand?: string;
  _handler?: CommandHandler | null;
}

/**
 * The `action` field is optional for backward compatibility;
 * when omitted, DISPLAY is assumed.
 */
export interface CommandResult {
  content?: string;
  error?: string;
  action?: number; // bitflags from ACTIONS
}

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
  /** The CompletionContext.command will be set to this command's name. */
  completion?: CompletionHandler;
}

export class AgentCommandRegistry {
  #commands: Map<string, CommandDefinition>;

  constructor() {
    this.#commands = new Map();
  }

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

  match(cmd: string | null | undefined): string | null {
    if (!cmd) return null;
    for (const [name, def] of this.#commands) {
      if (def.matches && def.matches(cmd)) {
        return name;
      }
    }
    return null;
  }

  generateHelpText(): string {
    const lines: string[] = [];
    for (const [name, def] of this.#commands) {
      const desc = def.description || "";
      lines.push(`  /${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }

  /**
   * Resolution chain:
   * 1. Custom inline handler (from parseCommand registry match)
   * 2. COMMAND_DISPATCH hook -- extensions can handle specific commands
   * 3. Registered handler from this registry by command type
   */
  async dispatch(
    cmd: ParsedCommand,
    agent: Agent,
    hooks: HookSystem,
  ): Promise<CommandResult> {
    if (cmd._customCommand && cmd._handler) {
      const result = await cmd._handler(agent, cmd.value, cmd);
      if (result) return result;
    }

    const pipelineResult = await hooks.runHookPipeline<CommandResult>(
      HOOKS.COMMAND_DISPATCH,
      { command: cmd, agent },
    );
    const lastResult = pipelineResult.lastResult;
    if (isPromise(lastResult)) {
      const awaited = await lastResult;
      if (awaited) return awaited;
    } else if (lastResult) {
      return lastResult;
    }

    const registered = this.get(cmd.type);
    if (registered && registered.handler) {
      return await registered.handler(agent, cmd.value, cmd);
    }

    return { action: ACTIONS.ERROR, error: `Unknown command: ${cmd.type}` };
  }
}

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
 * Minimal interface for CLI subcommand registration.
 * Used by hook handlers so they don't depend on the concrete class.
 */
export interface CliSubcommandRegistryLike {
  register(name: string, definition: SubcommandDefinition): void;
}

export class CliSubcommandRegistry implements CliSubcommandRegistryLike {
  #commands: Map<string, SubcommandDefinition>;

  constructor() {
    this.#commands = new Map();
  }

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

  generateHelpText(): string {
    const lines: string[] = [];
    for (const [name, def] of this.#commands) {
      const desc = def.description || "";
      lines.push(`  ${name.padEnd(20)} ${desc}`);
    }
    return lines.join("\n");
  }
}

export function createSubcommandRegistry(): CliSubcommandRegistry {
  return new CliSubcommandRegistry();
}
