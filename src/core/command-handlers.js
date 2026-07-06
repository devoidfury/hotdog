// Built-in command handlers for the agent.
// These are extracted from agent.js so that agent.js only does generic dispatch.
// Each handler is a function (agent, value, cmd) => { content?, error? }.

import { Command } from "./commands.js";

/**
 * Handler for /clear — clears context and resets system prompt.
 *
 * @param {Object} agent - Agent instance.
 * @param {string} [value] - Optional value (ignored).
 * @returns {void}
 */
export async function handleClear(agent, value) {
  await agent.clearContext();
  return { content: "Context cleared." };
}

/**
 * Handler for /quit — tells the UI to quit.
 *
 * @returns {{error: string}} Error message.
 */
export function handleQuit() {
  return { error: "UI command: quit" };
}

/**
 * Handler for /help — tells the UI to show help.
 *
 * @returns {{error: string}} Error message.
 */
export function handleHelp() {
  return { error: "UI command: help" };
}

/**
 * Handler for /tokens — shows accumulated token usage stats and last-reported values.
 *
 * @param {Object} agent - Agent instance.
 * @returns {{content: string}} Response content.
 */
export function handleTokens(agent) {
  const u = agent.getTokenUsage();
  if (u.turns === 0) {
    return { content: "No token usage recorded yet." };
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

  return { content: lines.join("\n") };
}

/**
 * Handler for /tools — toggles tool call display.
 *
 * @param {Object} agent - Agent instance.
 * @returns {{content: string}} Response content.
 */
export function handleTools(agent) {
  agent.hideTools = !agent.hideTools;
  agent._emitOutput("session_state", {
    key: "hideTools",
    value: agent.hideTools,
  });
  return { content: `Tool display: ${agent.hideTools ? "hidden" : "shown"}` };
}

/**
 * Handler for /thinking — toggles thinking display.
 *
 * @param {Object} agent - Agent instance.
 * @returns {{content: string}} Response content.
 */
export function handleThinking(agent) {
  agent.hideThinking = !agent.hideThinking;
  agent._emitOutput("session_state", {
    key: "hideThinking",
    value: agent.hideThinking,
  });
  return {
    content: `Thinking display: ${agent.hideThinking ? "hidden" : "shown"}`,
  };
}

/**
 * Handler for /regenerate — regenerates the system prompt.
 *
 * @param {Object} agent - Agent instance.
 * @returns {Promise<{content: string}>} Response content.
 */
export async function handleRegenerate(agent) {
  agent._systemPrompt = null;
  await agent.ensureSystemPrompt();
  return { content: "System prompt regenerated." };
}

/**
 * Handler for /reasoning — sets the reasoning effort level.
 *
 * @param {Object} agent - Agent instance.
 * @param {string} [value] - Reasoning effort level ("none", "minimal", "low", "high", "xhigh", "max", "unset").
 * @returns {{content: string}} Response content.
 */
export function handleReasoning(agent, value) {
  const valid = ["none", "minimal", "low", "high", "xhigh", "max", "unset"];
  if (!value) {
    const current =
      agent._reasoningEffort !== undefined
        ? agent._reasoningEffort
        : "(not set, omitted from requests)";
    return { content: `Current reasoning effort: ${current}` };
  }
  if (value === "unset") {
    agent._reasoningEffort = undefined;
    return { content: "Reasoning effort unset (omitted from requests)." };
  }
  if (valid.includes(value)) {
    agent._reasoningEffort = value;
    return { content: `Reasoning effort set to: ${value}` };
  }
  return {
    error: `Invalid reasoning effort '${value}'. Valid: none, minimal, low, high, xhigh, max, unset`,
  };
}

/**
 * Map of Command enum values to their handler functions.
 * Used to register built-in commands with the agent's CommandRegistry.
 */
export const CORE_COMMAND_HANDLERS = {
  [Command.Clear]: { handler: handleClear, description: "Clear context" },
  [Command.Quit]: { handler: handleQuit, description: "Exit", isUiCommand: true },
  [Command.Help]: { handler: handleHelp, description: "Show help", isUiCommand: true },
  [Command.Tokens]: { handler: handleTokens, description: "Show token usage" },
  [Command.Tools]: { handler: handleTools, description: "Toggle tool call display" },
  [Command.Thinking]: { handler: handleThinking, description: "Toggle thinking display" },
  [Command.Regenerate]: { handler: handleRegenerate, description: "Regenerate system prompt" },
  [Command.Reasoning]: { handler: handleReasoning, description: "Set reasoning effort level" },
};
