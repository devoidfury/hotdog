// Handoff tool — plan-execute handoff for multi-phase tasks.
//
// The agent calls this tool to package all relevant context into a handoff
// document, then the extension clears the conversation context, rebuilds the
// system prompt fresh, and enqueues the handoff content as the first user
// message to start the next phase.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { HOOKS } from "../../core/hooks.ts";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolContext,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

interface HandoffPayload {
  content: string;
  title?: string;
  instructions?: string;
  files?: string[];
}

export class HandoffTool {
  static readonly TOOL_NAME = "handoff";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 3 };

  /** Pending handoffs keyed by agent session id. */
  constructor(private pending: Map<string, HandoffPayload>) {}

  toToolDef() {
    return toolDef(
      HandoffTool.TOOL_NAME,
      "Transition to a new phase by clearing context and restarting with a prepared plan. Use when transitioning work phase, examples: planning → execution, research → implementation, analysis → action, or need fresh focus on essential context, or when asked to prepare a plan and execute. Be thorough — this is your only bridge to the next phase.",
      {
        properties: {
          content: param(
            "string",
            "The handoff content — a comprehensive summary of the plan, context, decisions, and instructions for the next phase. This becomes the starting point for the fresh conversation. Include: the plan/task, key decisions and rationale, constraints/requirements, and specific next steps - avoid repeating anything already in the relevant files.",
          ),
          title: param(
            "string",
            "Optional title for this handoff phase. Used for clarity in the restarted conversation.",
          ),
          instructions: param(
            "string",
            "Optional specific instructions for the next phase beyond what's in content. These are prefixed to the handoff message to guide the agent's behavior.",
          ),
          files: param(
            "array",
            "Optional list of file paths relevant to the next phase. Helps the agent know which files to focus on.",
            {
              items: { type: "string" },
            },
          ),
        },
        required: ["content"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args: Record<string, unknown>) => {
        const title = (args.title as string) || "handoff";
        return `handoff: ${title}`;
      },
      { fallback: "handoff: preparing phase transition..." },
    );
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.content || typeof args.content !== "string") {
      return ToolResult.err("Handoff requires a non-empty 'content' field");
    }

    const payload: HandoffPayload = {
      content: args.content as string,
      title: (args.title as string) || undefined,
      instructions: (args.instructions as string) || undefined,
      files: Array.isArray(args.files)
        ? (args.files as string[]).filter((f) => typeof f === "string")
        : undefined,
    };

    // Store the handoff payload for the TURN_END hook to process.
    // The hook does the actual context clear + enqueue to ensure
    // proper lifecycle ordering (tool results are added before clearing).
    // Keyed by agent session id so concurrent sessions can't clobber each
    // other's pending handoff (shared tool instance across sessions).
    const agent = ctx?.get("agent") as { sessionId?: string } | undefined;
    const sessionId = agent?.sessionId || "default";
    this.pending.set(sessionId, payload);

    return ToolResult.stop(
      `Handoff prepared. Context will be cleared and the agent will restart with your plan.\n\n` +
        `${payload.title ? `Title: ${payload.title}\n\n` : ""}` +
        `Your handoff content has been captured and will be the starting point for the next phase.`,
    ).withEntries({
      status: "handoff_ready",
      title: payload.title || "",
    });
  }
}

// ── Extension Entry Point ──────────────────────────────────────────────────

/**
 * Create the handoff-tool extension.
 *
 * The extension:
 * 1. Registers the "handoff" tool via TOOLS_REGISTER hook
 * 2. Watches TURN_END to detect handoff completion, then:
 *    - Clears the conversation context
 *    - Rebuilds the system prompt fresh
 *    - Enqueues the handoff content as the first user message
 */
export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{
    enabled?: boolean;
    systemPrompt?: boolean;
  }>(core, "handoffTool");

  if (config.enabled === false) {
    return {};
  }

  // Shared between the tool and the TURN_END hook; keyed by agent session id
  // so concurrent sessions (e.g. multiple webui clients) can't clobber
  // each other's pending handoff.
  const pending = new Map<string, HandoffPayload>();

  const handoffTool = new HandoffTool(pending);

  /**
   * Build the enqueued message from the handoff payload.
   * This becomes the first user message in the fresh conversation.
   */
  function buildHandoffMessage(payload: HandoffPayload): string {
    const parts: string[] = [];

    if (payload.title) {
      parts.push(`# ${payload.title}`);
      parts.push("");
    }

    if (payload.instructions) {
      parts.push(`## Instructions`);
      parts.push(payload.instructions);
      parts.push("");
    }

    parts.push(`## Plan`);
    parts.push(payload.content);

    if (payload.files && payload.files.length > 0) {
      parts.push("");
      parts.push(`## Relevant Files`);
      for (const file of payload.files) {
        parts.push(`- ${file}`);
      }
    }

    parts.push("");
    parts.push(
      "_This conversation started from a handoff. The plan above was prepared in a previous phase. Proceed with execution._",
    );

    return parts.join("\n");
  }

  return {
    hooks: {
      /** Register the handoff tool. */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("handoff", handoffTool);
      },

      /**
       * Detect when the agent finishes a turn after a handoff tool call.
       * Clear context, rebuild system prompt, and enqueue the handoff content.
       */
      [HOOKS.TURN_END]: async ({ stopped, cancelled, agent, toolResults }) => {
        if (!agent) {
          return;
        }

        // Keyed by agent session id to match the tool's pending map.
        const sessionId = (agent as { sessionId?: string }).sessionId || "default";

        // A cancelled turn leaves a stale pending handoff; drop it so a later
        // turn in this session can't accidentally consume it.
        if (cancelled) {
          pending.delete(sessionId);
          return;
        }

        // Only process if:
        // - The turn stopped (agent completed, not continuing loop)
        // - We have a pending handoff for THIS session
        if (!stopped || !pending.has(sessionId)) {
          return;
        }

        // Verify the handoff tool was called in this turn
        const handoffCalled = toolResults?.some((tr) => tr.toolName === "handoff");
        if (!handoffCalled) {
          return;
        }

        const handoff = pending.get(sessionId)!;
        pending.delete(sessionId); // Clear immediately to avoid re-processing

        try {
          // Clear the conversation context (messages + system prompt cache)
          await agent.clearContext();

          // Rebuild the system prompt fresh
          await agent.ensureSystemPrompt();

          // Enqueue the handoff content as the first user message
          // This triggers the agent loop to start the next phase
          const message = buildHandoffMessage(handoff);
          agent.enqueue(message);
        } catch (e: unknown) {
          // If something goes wrong, emit an error but don't break the loop
          const errorMsg = e instanceof Error ? e.message : String(e);
          agent.emitOutput("command_result", {
            content: `Handoff error: ${errorMsg}`,
          });
        }
      },
    },

    // Expose for external use / testing
    HandoffTool,
  };
}
