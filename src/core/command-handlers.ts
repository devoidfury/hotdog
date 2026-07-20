// Built-in command handlers for the agent.
// These are extracted from agent.ts so that agent.ts only does generic dispatch.
// Each handler is a function (agent, value, cmd) => { content?, error? }.

import { Command, ACTIONS, type ParsedCommand } from "./commands.ts";
import type { TokenUsage } from "./token-tracker.ts";
import type { CommandAgent, CommandHandler } from "./extensions/registries.ts";

export interface CommandResult {
  action?: number;
  content?: string;
  error?: string;
}

export interface CommandHandlerDef {
  handler: CommandHandler;
  description: string;
}

// Re-export for external use
export type { CommandHandler } from "./extensions/registries.ts";

// ── Command Handlers ─────────────────────────────────────────────────────────

/**
 * Handler for /clear — clears context and resets system prompt.
 *
 * @param agent - Agent instance.
 * @param _value - Optional value (ignored).
 */
export async function handleClear(agent: CommandAgent, _value?: string | null): Promise<CommandResult> {
  await agent.clearContext();
  return { action: ACTIONS.DISPLAY, content: "Context cleared." };
}

/**
 * Handler for /quit — handled at the Channel level.
 * This fallback exists for direct agent command execution.
 */
export function handleQuit(): CommandResult {
  return { action: ACTIONS.DISPLAY, content: "Quit (use /quit to exit)" };
}

/**
 * Handler for /help — handled at the Channel level.
 * This fallback exists for direct agent command execution.
 */
export function handleHelp(): CommandResult {
  return { action: ACTIONS.DISPLAY, content: "Help (use /help for commands)" };
}

/**
 * Handler for /tokens — shows accumulated token usage stats and last-reported values.
 *
 * @param agent - Agent instance.
 */
export function handleTokens(agent: CommandAgent): CommandResult {
  const u = agent.getTokenUsage();
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

/**
 * Handler for /tools — toggles tool call display.
 *
 * @param agent - Agent instance.
 */
export function handleTools(agent: CommandAgent): CommandResult {
  agent.hideTools = !agent.hideTools;
  agent.emitOutput("session_state", {
    key: "hideTools",
    value: agent.hideTools,
  });
  return {
    action: ACTIONS.DISPLAY,
    content: `Tool display: ${agent.hideTools ? "hidden" : "shown"}`,
  };
}

/**
 * Handler for /thinking — toggles thinking display.
 *
 * @param agent - Agent instance.
 */
export function handleThinking(agent: CommandAgent): CommandResult {
  agent.hideThinking = !agent.hideThinking;
  agent.emitOutput("session_state", {
    key: "hideThinking",
    value: agent.hideThinking,
  });
  return {
    action: ACTIONS.DISPLAY,
    content: `Thinking display: ${agent.hideThinking ? "hidden" : "shown"}`,
  };
}

/**
 * Handler for /regenerate — regenerates the system prompt.
 *
 * @param agent - Agent instance.
 */
export async function handleRegenerate(agent: CommandAgent): Promise<CommandResult> {
  agent.systemPrompt = null;
  await agent.ensureSystemPrompt();
  return { action: ACTIONS.DISPLAY, content: "System prompt regenerated." };
}

/**
 * Handler for /reasoning — sets the reasoning effort level.
 *
 * @param agent - Agent instance.
 * @param value - Reasoning effort level ("none", "minimal", "low", "high", "xhigh", "max", "unset").
 */
export function handleReasoning(agent: CommandAgent, value?: string | null): CommandResult {
  const valid = ["none", "minimal", "low", "high", "xhigh", "max", "unset"];
  if (!value) {
    const current =
      agent.reasoningEffort !== undefined
        ? agent.reasoningEffort
        : "(not set, omitted from requests)";
    return { action: ACTIONS.DISPLAY, content: `Current reasoning effort: ${current}` };
  }
  if (value === "unset") {
    agent.reasoningEffort = undefined;
    return { action: ACTIONS.DISPLAY, content: "Reasoning effort unset (omitted from requests)." };
  }
  if (valid.includes(value)) {
    agent.reasoningEffort = value;
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
  [Command.Quit]: { handler: handleQuit, description: "Exit" },
  [Command.Help]: { handler: handleHelp, description: "Show help" },
  [Command.Tokens]: { handler: handleTokens, description: "Show token usage" },
  [Command.Tools]: { handler: handleTools, description: "Toggle tool call display" },
  [Command.Thinking]: { handler: handleThinking, description: "Toggle thinking display" },
  [Command.Regenerate]: { handler: handleRegenerate, description: "Regenerate system prompt" },
  [Command.Reasoning]: { handler: handleReasoning, description: "Set reasoning effort level" },
};
