// Command parsing for the agent.
// Commands are the abstract concept — how they are invoked (slash commands,
// menu items, API calls) is a UI implementation detail.
// This module handles parsing raw command text into typed command objects.

import type { CommandHandler, ParsedCommand as TypedParsedCommand } from "./extensions/registries.ts";

// Re-export the typed ParsedCommand so consumers use the canonical definition
export type { ParsedCommand } from "./extensions/registries.ts";

/**
 * Built-in command type constants.
 * These are core commands that the agent always understands.
 */
export const Command = {
  Help: "help",
  Quit: "quit",
  Clear: "clear",
  Tools: "tools",
  Thinking: "thinking",
  Tokens: "tokens",
  Regenerate: "regenerate",
  Reasoning: "reasoning",
  Unknown: "unknown",
} as const;

export type CommandType = (typeof Command)[keyof typeof Command];

/**
 * Action constants — returned by command handlers to tell the core
 * how to proceed after executing a command.
 *
 *   DISPLAY — show the result content as a command response (default)
 *   PROMPT  — enqueue the content as a user message for LLM processing
 *   ERROR   — show the error as a command response
 */
export const ACTIONS = {
  DISPLAY: 1 << 0, // 1
  PROMPT: 1 << 1,  // 2
  ERROR: 1 << 2,   // 4
} as const;

export type ActionFlag = (typeof ACTIONS)[keyof typeof ACTIONS];

// ── Command Registry Interface ───────────────────────────────────────────────

/**
 * Minimal command registry interface for parseCommand.
 * Allows passing any registry that has match() and get() methods.
 */
export interface CommandRegistryLike {
  match(cmd: string): string | null;
  get(name: string): { handler?: CommandHandler } | undefined;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a raw command string into a typed command object.
 *
 * @param cmd - Raw command string.
 * @param registry - Optional CommandRegistry for custom commands.
 * @returns Parsed command object { type, value }.
 */
export function parseCommand(
  cmd: string | null | undefined,
  registry?: CommandRegistryLike,
): TypedParsedCommand {
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
        _handler: (def?.handler as CommandHandler | null) ?? null,
      };
    }
  }

  switch (cmd) {
    case "help":
      return { type: Command.Help, value: null };
    case "quit":
    case "exit":
      return { type: Command.Quit, value: null };
    case "clear":
      return { type: Command.Clear, value: null };
  }

  // clear <profile> — profile name stored in value, handler decides what to do
  if (cmd.startsWith("clear ")) {
    const profileName = cmd.slice(6).trim();
    return {
      type: Command.Clear,
      value: profileName || null,
    };
  }

  switch (cmd) {
    case "tools":
      return { type: Command.Tools, value: null };
    case "thinking":
      return { type: Command.Thinking, value: null };
  }

  if (cmd === "tokens") {
    return { type: Command.Tokens, value: null };
  }

  if (cmd === "regenerate") {
    return { type: Command.Regenerate, value: null };
  }

  // reasoning — set reasoning effort level
  if (cmd === "reasoning" || cmd.startsWith("reasoning ")) {
    const parts = cmd.split(/\s+/);
    const effort = parts.slice(1).join(" ").trim();
    return { type: Command.Reasoning, value: effort || null };
  }

  return { type: Command.Unknown, value: cmd };
}
