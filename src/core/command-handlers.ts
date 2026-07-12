// Built-in command handlers for the agent.
// These are extracted from agent.ts so that agent.ts only does generic dispatch.
// Each handler is a function (agent, value, cmd) => { content?, error? }.

import { Command, ACTIONS, ParsedCommand } from "./commands.ts";

export interface CommandResult {
  action?: number;
  content?: string;
  error?: string;
}

export interface CommandHandlerDef {
  handler: (agent: unknown, value?: string | null, cmd?: ParsedCommand) => CommandResult | Promise<CommandResult>;
  description: string;
  isUiCommand?: boolean;
}

/**
 * Handler for /clear — clears context and resets system prompt.
 *
 * @param agent - Agent instance.
 * @param value - Optional value (ignored).
 */
export async function handleClear(agent: unknown, _value?: string | null): Promise<CommandResult> {
  const a = agent as { clearContext: () => Promise<void> };
  await a.clearContext();
  return { action: ACTIONS.DISPLAY, content: "Context cleared." };
}

/**
 * Handler for /quit — tells the UI to quit.
 */
export function handleQuit(): CommandResult {
  return { action: ACTIONS.ERROR, error: "UI command: quit" };
}

/**
 * Handler for /help — tells the UI to show help.
 */
export function handleHelp(): CommandResult {
  return { action: ACTIONS.ERROR, error: "UI command: help" };
}

/**
 * Handler for /tokens — shows accumulated token usage stats and last-reported values.
 *
 * @param agent - Agent instance.
 */
export function handleTokens(agent: unknown): CommandResult {
  const a = agent as { getTokenUsage: () => TokenUsage };
  const u = a.getTokenUsage();
  if (u.turns === 0) {
    return { action: ACTIONS.DISPLAY, content: "No token usage recorded yet." };
  }

  const promptProcessed = u.promptTokens; // accumulated as (prompt - cached)
  const lines = [
    `Token usage (${u.turns} turn${u.turns === 1 ? "" : "s"}):`,
    `  prompt:      ${promptProcessed.toLocaleString()} tokens`,
    `  cached:      ${u.cachedTokens.toLocaleString()} tokens`,
    `  completion:  ${u.completionTokens.toLocaleString()} tokens`,
    `  total:       ${u.totalTokens.toLocaleString()} tokens`,
  ];

  if (promptProcessed > 0) {
    const cacheRate = (
      (u.cachedTokens / (promptProcessed + u.cachedTokens)) *
      100
    ).toFixed(1);
    lines.push(`  cache hit:   ${cacheRate}% of prompt tokens`);
  }

  // Last-reported values from the provider.
  lines.push("");
  lines.push("Last call:");
  lines.push(
    `  prompt:      ${(u.lastPromptTokens || 0).toLocaleString()} tokens`,
  );
  lines.push(
    `  cached:      ${(u.lastCachedTokens || 0).toLocaleString()} tokens`,
  );
  lines.push(
    `  completion:  ${(u.lastCompletionTokens || 0).toLocaleString()} tokens`,
  );
  lines.push(
    `  total:       ${(u.lastTotalTokens || 0).toLocaleString()} tokens`,
  );

  return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
}

interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  lastPromptTokens: number;
  lastCachedTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
}

/**
 * Handler for /tools — toggles tool call display.
 *
 * @param agent - Agent instance.
 */
export function handleTools(agent: unknown): CommandResult {
  const a = agent as { hideTools: boolean; _emitOutput: (type: string, data: Record<string, unknown>) => void };
  a.hideTools = !a.hideTools;
  a._emitOutput("session_state", {
    key: "hideTools",
    value: a.hideTools,
  });
  return {
    action: ACTIONS.DISPLAY,
    content: `Tool display: ${a.hideTools ? "hidden" : "shown"}`,
  };
}

/**
 * Handler for /thinking — toggles thinking display.
 *
 * @param agent - Agent instance.
 */
export function handleThinking(agent: unknown): CommandResult {
  const a = agent as { hideThinking: boolean; _emitOutput: (type: string, data: Record<string, unknown>) => void };
  a.hideThinking = !a.hideThinking;
  a._emitOutput("session_state", {
    key: "hideThinking",
    value: a.hideThinking,
  });
  return {
    action: ACTIONS.DISPLAY,
    content: `Thinking display: ${a.hideThinking ? "hidden" : "shown"}`,
  };
}

/**
 * Handler for /regenerate — regenerates the system prompt.
 *
 * @param agent - Agent instance.
 */
export async function handleRegenerate(agent: unknown): Promise<CommandResult> {
  const a = agent as { _systemPrompt: string | null; ensureSystemPrompt: () => Promise<void> };
  a._systemPrompt = null;
  await a.ensureSystemPrompt();
  return { action: ACTIONS.DISPLAY, content: "System prompt regenerated." };
}

/**
 * Handler for /reasoning — sets the reasoning effort level.
 *
 * @param agent - Agent instance.
 * @param value - Reasoning effort level ("none", "minimal", "low", "high", "xhigh", "max", "unset").
 */
export function handleReasoning(agent: unknown, value?: string | null): CommandResult {
  const a = agent as { _reasoningEffort: string | undefined };
  const valid = ["none", "minimal", "low", "high", "xhigh", "max", "unset"];
  if (!value) {
    const current =
      a._reasoningEffort !== undefined
        ? a._reasoningEffort
        : "(not set, omitted from requests)";
    return { action: ACTIONS.DISPLAY, content: `Current reasoning effort: ${current}` };
  }
  if (value === "unset") {
    a._reasoningEffort = undefined;
    return { action: ACTIONS.DISPLAY, content: "Reasoning effort unset (omitted from requests)." };
  }
  if (valid.includes(value)) {
    a._reasoningEffort = value;
    return { action: ACTIONS.DISPLAY, content: `Reasoning effort set to: ${value}` };
  }
  return {
    action: ACTIONS.ERROR,
    error: `Invalid reasoning effort '${value}'. Valid: none, minimal, low, high, xhigh, max, unset`,
  };
}

/**
 * Map of Command enum values to their handler functions.
 * Used to register built-in commands with the agent's CommandRegistry.
 */
export const CORE_COMMAND_HANDLERS: Record<string, CommandHandlerDef> = {
  [Command.Clear]: { handler: handleClear, description: "Clear context" },
  [Command.Quit]: { handler: handleQuit, description: "Exit", isUiCommand: true },
  [Command.Help]: { handler: handleHelp, description: "Show help", isUiCommand: true },
  [Command.Tokens]: { handler: handleTokens, description: "Show token usage" },
  [Command.Tools]: { handler: handleTools, description: "Toggle tool call display" },
  [Command.Thinking]: { handler: handleThinking, description: "Toggle thinking display" },
  [Command.Regenerate]: { handler: handleRegenerate, description: "Regenerate system prompt" },
  [Command.Reasoning]: { handler: handleReasoning, description: "Set reasoning effort level" },
};
