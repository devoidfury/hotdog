// Commands are the abstract concept — how they are invoked (slash commands,
// menu items, API calls) is a UI implementation detail.

import type { CommandHandler, ParsedCommand as TypedParsedCommand } from "./extensions/registries.ts";

// Re-export the typed ParsedCommand so consumers use the canonical definition
export type { ParsedCommand } from "./extensions/registries.ts";

export const Command = {
  Help: "help",
  Quit: "quit",
  Clear: "clear",
  Tools: "tools",
  Thinking: "thinking",
  Tokens: "tokens",
  Regenerate: "regenerate",
  Reasoning: "reasoning",
  Sessions: "sessions",
  Attach: "attach",
  Detach: "detach",
  Switch: "switch",
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
  DISPLAY: 1 << 0,
  PROMPT: 1 << 1,
  ERROR: 1 << 2,
} as const;

export type ActionFlag = (typeof ACTIONS)[keyof typeof ACTIONS];

// ── Command Registry Interface ───────────────────────────────────────────────

export interface CommandRegistryLike {
  match(cmd: string): string | null;
  get(name: string): { handler?: CommandHandler } | undefined;
  names(): string[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parseCommand(
  cmd: string | null | undefined,
  registry?: CommandRegistryLike | null,
): TypedParsedCommand {
  if (!cmd) return { type: Command.Unknown, value: null };

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

  if (cmd === "reasoning" || cmd.startsWith("reasoning ")) {
    const parts = cmd.split(/\s+/);
    const effort = parts.slice(1).join(" ").trim();
    return { type: Command.Reasoning, value: effort || null };
  }

  if (cmd === "sessions") {
    return { type: Command.Sessions, value: null };
  }
  if (cmd === "attach" || cmd.startsWith("attach ")) {
    const sessionId = cmd.replace(new RegExp(`^attach\\s+`, "i"), "").trim();
    return { type: Command.Attach, value: sessionId || null };
  }
  if (cmd === "detach" || cmd.startsWith("detach ")) {
    const sessionId = cmd.replace(new RegExp(`^detach\\s+`, "i"), "").trim();
    return { type: Command.Detach, value: sessionId || null };
  }
  if (cmd === "switch" || cmd.startsWith("switch ")) {
    const sessionId = cmd.replace(new RegExp(`^switch\\s+`, "i"), "").trim();
    return { type: Command.Switch, value: sessionId || null };
  }

  return { type: Command.Unknown, value: cmd };
}
