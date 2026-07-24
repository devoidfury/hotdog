// Handoff tool — plan-execute handoff for multi-phase tasks.
//
// The agent calls this tool to package all relevant context into a handoff
// document, then the extension clears the conversation context, rebuilds the
// system prompt fresh, and enqueues the handoff content as the first user
// message to start the next phase.
//
// Use case: planning → execution, research → implementation, etc.
// The planning phase collects all context and calls handoff; the execution
// phase starts with a clean context window but with the full plan.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HOOKS, type SystemPromptChunk } from "../../core/hooks.ts";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  ToolExecutionContext,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDOFF_SYSTEM_PROMPT = readFileSync(
  join(__dirname, "handoff_chunk.md"),
  "utf-8",
);
import { Agent } from "../../core/agent.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface HandoffPayload {
  content: string;
  title?: string;
  instructions?: string;
  files?: string[];
}

interface HandoffState {
  pending: HandoffPayload | null;
}

// ── Handoff Tool ───────────────────────────────────────────────────────────

export class HandoffTool {
  static readonly TOOL_NAME = "handoff";

  constructor(private state: HandoffState) {}

  toToolDef() {
    return toolDef(
      HandoffTool.TOOL_NAME,
      "Transition to a new phase by clearing context and restarting with a prepared plan. Call this after completing planning/research to hand off to execution. The tool clears the conversation context, rebuilds the system prompt, and restarts the agent loop with your handoff content as the first instruction.",
      {
        properties: {
          content: param(
            "string",
            "The handoff content — a comprehensive summary of the plan, context, decisions, and instructions for the next phase. This becomes the starting point for the fresh conversation. Include: the plan/task, key decisions and rationale, relevant files with paths, constraints/requirements, and specific next steps. Be thorough — this is your only bridge to the next phase.",
          ),
          title: param(
            "string",
            "Optional title for this handoff phase (e.g., 'Implementation Phase', 'Code Review Phase'). Used for clarity in the restarted conversation.",
          ),
          instructions: param(
            "string",
            "Optional specific instructions for the next phase beyond what's in content. These are prefixed to the handoff message to guide the agent's behavior (e.g., 'Execute the plan step by step', 'Focus on correctness over speed').",
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

  async execute(
    input: string | Record<string, unknown> | null,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
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
    this.state.pending = payload;

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
 * 2. Contributes instructions to the system prompt via SYSTEM_PROMPT_BUILD hook
 * 3. Watches TURN_END to detect handoff completion, then:
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

  // Shared state between the tool and the TURN_END hook.
  const state: HandoffState = { pending: null };

  const handoffTool = new HandoffTool(state);

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
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        registry.register("handoff", handoffTool);
      },

      /** Add handoff tool instructions to the system prompt. */
      [HOOKS.SYSTEM_PROMPT_BUILD]: ({ agent }): SystemPromptChunk => {
        if (
          config.systemPrompt === false ||
          !agent ||
          !agent.getToolNames().includes(HandoffTool.TOOL_NAME)
        ) {
          return {
            name: "handoff-tool-instructions",
            priority: 50,
            content: "",
          };
        }
        return {
          name: "handoff-tool-instructions",
          priority: 50,
          content: HANDOFF_SYSTEM_PROMPT.trim(),
        };
      },

      /**
       * Detect when the agent finishes a turn after a handoff tool call.
       * Clear context, rebuild system prompt, and enqueue the handoff content.
       */
      [HOOKS.TURN_END]: async ({ stopped, cancelled, agent, toolResults }) => {
        // Only process if:
        // - The turn stopped (agent completed, not continuing loop)
        // - Not cancelled (user interrupted)
        // - We have a pending handoff
        if (!stopped || cancelled || !agent || !state.pending) {
          return;
        }

        // Verify the handoff tool was called in this turn
        const handoffCalled = toolResults?.some(
          (tr) => tr.toolName === "handoff",
        );
        if (!handoffCalled) {
          return;
        }

        const handoff = state.pending;
        state.pending = null; // Clear immediately to avoid re-processing

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
