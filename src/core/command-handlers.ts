// Extracted from agent.ts so that agent.ts only does generic dispatch.

import { Command, ACTIONS } from "./commands.ts";
import {
  MessageCutError,
  resolveMessageCut,
  trimTurns,
  type ForkCut,
  type MessageCut,
} from "./context/rewind.ts";
import { formatError } from "./error.ts";
import { computeTokenCost, findModelPrice, formatUsd, isPricingConfigured } from "./token-pricing.ts";
import { contextGaugeSegment } from "./context-gauge.ts";
import { spoofSafe } from "@utils/spoof.ts";
import type {
  CommandDefinition,
  CommandHandler,
  CommandResult,
} from "./extensions/registries.ts";
import type { CompletionContext, CompletionOption } from "./completion.ts";
import type { Agent } from "./agent.ts";

export { type CommandResult } from "./extensions/registries.ts";

/** Core command definitions; the registry interface, with handler required. */
export interface CommandHandlerDef extends CommandDefinition {
  handler: CommandHandler;
  description: string;
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
 * Handler for /help — the real command list, built from the registry every
 * agent owns (core handlers plus extension-registered commands all carry
 * descriptions). The interactive CLI still intercepts /help at its UI layer
 * with its own static HELP_TEXT; this is what non-CLI channels (webui)
 * render.
 */
export function handleHelp(agent: Agent): CommandResult {
  return {
    action: ACTIONS.DISPLAY,
    content: `Commands:\n${agent.commandRegistry.generateHelpText()}`,
  };
}

/**
 * Handler for /redraw — handled at the interactive-UI level (purge scrollback,
 * reprint the transcript, repaint the frame -- split renderer recovery).
 * This fallback exists for direct agent command execution and UIs without a
 * managed renderer, where there is nothing to purge.
 */
export function handleRedraw(): CommandResult {
  return { action: ACTIONS.DISPLAY, content: "Redraw (handled by the interactive renderer)" };
}

export function handleTokens(agent: Agent): CommandResult {
  const u = agent.context.getTokenUsage();
  if (u.turns === 0) {
    return { action: ACTIONS.DISPLAY, content: "No token usage recorded yet." };
  }

  // Cost lines are opt-in via the `modelPricing` config key: no key, no lines.
  // Numbers come from the tracker (prompt totals are already net of cached).
  const pricing = agent.config?.modelPricing;
  const pricingConfigured = isPricingConfigured(pricing);
  const price = pricingConfigured ? findModelPrice(pricing, agent.model) : undefined;
  const sessionCost = price
    ? computeTokenCost(
        {
          promptTokens: u.sessionPromptTokens,
          cachedTokens: u.sessionCachedTokens,
          completionTokens: u.sessionCompletionTokens,
        },
        price,
      )
    : null;
  const lastCallCost = price
    ? computeTokenCost(
        {
          promptTokens: u.promptTokens || 0,
          cachedTokens: u.cachedTokens || 0,
          completionTokens: u.completionTokens || 0,
        },
        price,
      )
    : null;

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

  if (pricingConfigured) {
    lines.push(
      sessionCost
        ? `  cost:        ${formatUsd(sessionCost.total)}`
        : `  cost:        model '${agent.model}' has no modelPricing entry`,
    );
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
  if (lastCallCost) {
    lines.push(`  cost:        ${formatUsd(lastCallCost.total)}`);
  }

  // Context gauge: what the last call occupied of the window (prompt tokens
  // are already net of cached; cached added back = full input). Without a
  // contextLimit there is nothing honest to measure against: line omitted.
  const contextGauge = contextGaugeSegment(
    (u.promptTokens || 0) + (u.cachedTokens || 0),
    agent.contextLimit,
  );
  if (contextGauge) {
    lines.push(`  context:     ${contextGauge}`);
  }

  return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
}

/**
 * `/tools` toggles the tool-call display. `/tools list` prints the registered
 * tools with their author-declared domain tags trailing (untagged tools show
 * nothing extra). Tags are author text, not model text, but the listing still
 * goes through the render-time spoof neutralizer like every other human-facing
 * surface.
 */
export function handleTools(agent: Agent, value?: string | null): CommandResult {
  const arg = (value ?? "").trim().toLowerCase();
  if (arg) {
    if (arg !== "list") {
      return {
        action: ACTIONS.ERROR,
        error: `Unknown /tools argument '${spoofSafe(arg)}'. Valid: list`,
      };
    }
    const registry = agent.toolRegistry;
    const rows = registry
      .getAllWithMetadata()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name }) => {
        const tags = registry.getTags(name).map(spoofSafe);
        return tags.length > 0 ? `  ${spoofSafe(name)} [${tags.join(", ")}]` : `  ${spoofSafe(name)}`;
      });
    return {
      action: ACTIONS.DISPLAY,
      content: `Tools (${rows.length}):\n${rows.join("\n")}`,
    };
  }
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

/**
 * /undo: drop the last turn via rewindContext, which also fires CONTEXT_REWOUND so the session-log extension checkpoints the log.
 * Turn-based by owner ruling -- the deliberate difference: /undo undoes a TURN (user message + everything after it),
 * /rewind cuts by the visible-message index. trimTurns serves this path and nothing else.
 */
export async function handleUndo(agent: Agent): Promise<CommandResult> {
  const messages = agent.getMessages();
  const { kept, droppedTurns, totalTurns } = trimTurns(messages, 1);
  if (droppedTurns === 0) {
    return {
      action: ACTIONS.DISPLAY,
      content: "Nothing to rewind (no user turns in context).",
    };
  }
  await agent.rewindContext(kept);
  const remaining = totalTurns - droppedTurns;
  return {
    action: ACTIONS.DISPLAY,
    content:
      `Rewound ${droppedTurns} turn${droppedTurns === 1 ? "" : "s"}` +
      ` (${remaining} ${remaining === 1 ? "turn remains" : "turns remain"}).`,
  };
}

/**
 * Take a cut spec off the front of a command argument: "-N" (N visible
 * messages back) or "N"/"#N" (absolute visible message #N -- the leading "#"
 * is accepted as sugar for the status row's number, so "/fork #5" is
 * "/fork 5"). `rest` is whatever follows the spec -- rewind requires it
 * empty; fork hands it to the prompt half. Nothing else is a spec: the
 * retired "index" keyword has no alias and lands in the invalid-argument
 * path.
 */
function takeMessageCut(arg: string): { cut: MessageCut | null; rest: string } {
  const back = arg.match(/^-(\d+)(?:\s+([\s\S]*))?$/);
  if (back) return { cut: { kind: "back", messages: parseInt(back[1]!, 10) }, rest: (back[2] ?? "").trim() };
  const idx = arg.match(/^#?(\d+)(?:\s+([\s\S]*))?$/);
  if (idx) return { cut: { kind: "index", index: parseInt(idx[1]!, 10) }, rest: (idx[2] ?? "").trim() };
  return { cut: null, rest: arg };
}

const REWIND_USAGE = "Usage: /rewind [-N | N]";

/**
 * /rewind grammar (docs/cli-reference.md), message-based by owner ruling --
 * the turns unit lives only in /undo:
 *   /rewind        cut ONE visible message back -- exactly /rewind -1
 *   /rewind N      cut to absolute visible message #N (keep through #N)
 *   /rewind -N     drop the last N visible messages (the status row's #N)
 * The bare form runs through the same -1 spec and resolver, so its result
 * envelope is identical to an explicit /rewind -1. The legacy "index N"
 * keyword is retired: "/rewind index 2" is an invalid argument, not an alias.
 */
export async function handleRewind(agent: Agent, value?: string | null): Promise<CommandResult> {
  const arg = (value ?? "").trim();
  // Bare /rewind is exactly -1: same spec, same resolver, same envelope.
  const { cut, rest } =
    arg === ""
      ? { cut: { kind: "back", messages: 1 } as MessageCut, rest: "" }
      : takeMessageCut(arg);
  if (!cut || rest !== "") {
    return {
      action: ACTIONS.ERROR,
      error: `Invalid argument: '${arg}'. ${REWIND_USAGE}`,
    };
  }
  let resolved;
  try {
    resolved = resolveMessageCut(agent.getMessages(), cut);
  } catch (err) {
    return {
      action: ACTIONS.ERROR,
      error: err instanceof MessageCutError ? err.message : formatError(err),
    };
  }
  if (resolved.droppedVisible === 0) {
    return {
      action: ACTIONS.DISPLAY,
      content: `Nothing to rewind (message #${resolved.after} is already the newest visible message).`,
    };
  }
  // rewindContext fires CONTEXT_REWOUND, so the session-log checkpoint lands
  // on the kept (stray-free) context.
  await agent.rewindContext(resolved.kept);
  const n = resolved.droppedVisible;
  const content =
    resolved.after === null
      ? `Rewound ${n} visible message${n === 1 ? "" : "s"}; no visible messages remain.`
      : cut.kind === "index"
        ? `Rewound to message #${resolved.after} (dropped ${n} visible message${n === 1 ? "" : "s"}).`
        : `Rewound ${cut.messages} visible message${cut.messages === 1 ? "" : "s"} (now at #${resolved.after}).`;
  return { action: ACTIONS.DISPLAY, content };
}

/**
 * Parse the `/fork` argument: an optional leading cut spec -- "-N" (N visible
 * messages back) or bare "N" (absolute visible message #N, keep through it) --
 * then the optional prompt. Accepted consequence of the bare-N grammar: a
 * prompt whose FIRST token is a digit parses as the index spec -- "/fork 404
 * handling" is index 404 with prompt "handling", never prompt "404 handling"
 * (docs/cli-reference.md). Exported for UIs (webui ws layer) that route fork
 * around the command bus.
 */
export function parseForkArg(value: string): { cut: ForkCut; prompt?: string } {
  const arg = value.trim();
  const { cut, rest } = takeMessageCut(arg);
  if (cut) return { cut, prompt: rest || undefined };
  return { cut: { kind: "head" }, prompt: arg || undefined };
}

export async function handleFork(
  agent: Agent,
  value?: string | null,
): Promise<CommandResult> {
  if (typeof agent.forkSession !== "function") {
    return {
      action: ACTIONS.ERROR,
      error: "Fork is not available in this harness (no session manager).",
    };
  }

  const { cut, prompt } = parseForkArg(value || "");

  try {
    // Note: prompt is parsed for reporting only -- the hosting UI enqueues it after
    // re-targeting its channel onto the fork (see SessionManager.forkSession doc).
    const { sessionId: newSessionId, branchAfter } = await agent.forkSession({ cut });
    const cutNote =
      cut.kind === "head"
        ? "branched the full context"
        : cut.kind === "index"
          ? `branched after message #${branchAfter}`
          : branchAfter !== null
            ? `branched ${cut.messages} message${cut.messages === 1 ? "" : "s"} back, after #${branchAfter}`
            : `branched ${cut.messages} message${cut.messages === 1 ? "" : "s"} back with every visible message dropped`;
    return {
      action: ACTIONS.DISPLAY,
      content:
        `Forked session ${agent.sessionId} → ${newSessionId}` +
        ` (${cutNote}).` +
        (prompt ? "\nPrompt sent to the forked session." : ""),
    };
  } catch (err) {
    // A MessageCutError is an honest usage error: the range text is the whole
    // story, no stack. Everything else goes through formatError.
    return {
      action: ACTIONS.ERROR,
      error: err instanceof MessageCutError ? err.message : formatError(err),
    };
  }
}

/**
 * Handler for /fence — handled at the interactive-UI level (per-session
 * runtime exec-fence toggle; see ui-interactive-cli/fence-command.ts). This
 * fallback exists for direct agent command execution and UIs without the
 * command (typing /fence in a webui chat lands here; the webui's toggle is
 * the dedicated execFence wire message behind the header strip, not this
 * command), where the boot config cannot honestly stand in for what the
 * session's effective policy would be under a toggle.
 */
export function handleFence(): CommandResult {
  return {
    action: ACTIONS.DISPLAY,
    content: "Fence (per-session runtime toggle handled by the interactive CLI: /fence on|off|status)",
  };
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
  [Command.Clear]: { handler: handleClear, description: "Clear context", mutatesSession: true },
  [Command.Quit]: { handler: handleQuit, description: "Exit" },
  [Command.Help]: { handler: handleHelp, description: "Show help" },
  [Command.Redraw]: { handler: handleRedraw, description: "Repaint the terminal (purge and reprint transcript)" },
  [Command.Tokens]: { handler: handleTokens, description: "Show token usage" },
  [Command.Tools]: {
    handler: handleTools,
    description: "Toggle tool call display (/tools list shows each tool's domain tags)",
  },
  [Command.Thinking]: {
    handler: handleThinking,
    description: "Toggle thinking display",
  },
  [Command.Regenerate]: {
    handler: handleRegenerate,
    description: "Regenerate system prompt",
  },
  [Command.Undo]: {
    handler: handleUndo,
    description: "Undo the last turn",
    mutatesSession: true,
  },
  [Command.Rewind]: {
    handler: handleRewind,
    description: "Rewind by message: N = cut to visible message #N, -N = N visible messages back, bare = -1",
    mutatesSession: true,
  },
  [Command.Fork]: {
    handler: handleFork,
    description:
      "Branch a new session: N after visible message #N, -N messages back, omitted = head; optional prompt",
    mutatesSession: true,
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
  [Command.Fence]: {
    handler: handleFence,
    description: "Toggle the exec-fence policy at runtime (on/off/status, interactive CLI)",
  },
};
