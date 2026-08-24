// Extracted from agent.ts so that agent.ts only does generic dispatch.

import { Command, ACTIONS } from "./commands.ts";
import type { CommandHandler, CommandResult } from "./extensions/registries.ts";
import type { CompletionContext, CompletionOption } from "./completion.ts";
import type { Agent } from "./agent.ts";

export { type CommandResult } from "./extensions/registries.ts";

export interface CommandHandlerDef {
  handler: CommandHandler;
  description: string;
  completion?: (ctx: CompletionContext) => CompletionOption[];
}

// Re-export for external use
export type { CommandHandler } from "./extensions/registries.ts";

// ── Command Handlers ─────────────────────────────────────────────────────────

export async function handleClear(
  agent: Agent,
  _value?: string | null,
): Promise<CommandResult> {
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

export function handleTokens(agent: Agent): CommandResult {
  const u = agent.context.getTokenUsage();
  if (u.turns === 0) {
    return { action: ACTIONS.DISPLAY, content: "No token usage recorded yet." };
  }

  const promptProcessed = u.sessionPromptTokens; // accumulated as (prompt - cached)
  const lines = [
    `Token usage (${u.turns} turn${u.turns === 1 ? "" : "s"}):`,
    `  prompt:      ${promptProcessed.toLocaleString()} tokens`,
    `  cached:      ${u.sessionCachedTokens.toLocaleString()} tokens`,
    `  completion:  ${u.sessionCompletionTokens.toLocaleString()} tokens`,
    `  total:       ${u.sessionTotalTokens.toLocaleString()} tokens`,
  ];

  if (promptProcessed > 0) {
    const cacheRate = (
      (u.sessionCachedTokens / (promptProcessed + u.sessionCachedTokens)) *
      100
    ).toFixed(1);
    lines.push(`  cache hit:   ${cacheRate}% of prompt tokens`);
  }

  // Most recent call values from the provider.
  lines.push("");
  lines.push("Last call:");
  lines.push(`  prompt:      ${(u.promptTokens || 0).toLocaleString()} tokens`);
  lines.push(`  cached:      ${(u.cachedTokens || 0).toLocaleString()} tokens`);
  lines.push(
    `  completion:  ${(u.completionTokens || 0).toLocaleString()} tokens`,
  );
  lines.push(`  total:       ${(u.totalTokens || 0).toLocaleString()} tokens`);

  return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
}

export function handleTools(agent: Agent): CommandResult {
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

export function handleThinking(agent: Agent): CommandResult {
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

export async function handleRegenerate(
  agent: Agent,
): Promise<CommandResult> {
  agent.context.clearSystemPrompt();
  await agent.ensureSystemPrompt();
  return { action: ACTIONS.DISPLAY, content: "System prompt regenerated." };
}

export function handleReasoning(
  agent: Agent,
  value?: string | null,
): CommandResult {
  const valid = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "unset"];
  if (!value) {
    const current =
      agent.reasoningEffort !== undefined
        ? agent.reasoningEffort
        : "(not set, omitted from requests)";
    return {
      action: ACTIONS.DISPLAY,
      content: `Current reasoning effort: ${current}`,
    };
  }
  if (value === "unset") {
    agent.reasoningEffort = undefined;
    return {
      action: ACTIONS.DISPLAY,
      content: "Reasoning effort unset (omitted from requests).",
    };
  }
  if (valid.includes(value)) {
    agent.reasoningEffort = value;
    return {
      action: ACTIONS.DISPLAY,
      content: `Reasoning effort set to: ${value}`,
    };
  }
  return {
    action: ACTIONS.ERROR,
    error: `Invalid reasoning effort '${value}'. Valid: none, minimal, low, medium, high, xhigh, max, unset`,
  };
}

export const CORE_COMMAND_HANDLERS: Record<string, CommandHandlerDef> = {
  [Command.Clear]: { handler: handleClear, description: "Clear context" },
  [Command.Quit]: { handler: handleQuit, description: "Exit" },
  [Command.Help]: { handler: handleHelp, description: "Show help" },
  [Command.Tokens]: { handler: handleTokens, description: "Show token usage" },
  [Command.Tools]: {
    handler: handleTools,
    description: "Toggle tool call display",
  },
  [Command.Thinking]: {
    handler: handleThinking,
    description: "Toggle thinking display",
  },
  [Command.Regenerate]: {
    handler: handleRegenerate,
    description: "Regenerate system prompt",
  },
  [Command.Reasoning]: {
    handler: handleReasoning,
    description: "Set reasoning effort level",
    completion: (ctx: CompletionContext): CompletionOption[] => {
      const prefix = (ctx.commandArg || "").toLowerCase();
      const levels = [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "unset",
      ];
      return levels
        .filter((l) => l.toLowerCase().startsWith(prefix))
        .map((l) => ({ value: l }));
    },
  },
};
