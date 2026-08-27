import { HOOKS } from "@core/hooks.ts";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { CoreContext, ExtensionInstance, ToolContext, getExtensionConfig } from "@core/extensions/types.ts";

interface HandoffPayload {
  content: string;
  title?: string;
  instructions?: string;
  files?: string[];
}

export class HandoffTool {
  static readonly TOOL_NAME = "handoff";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 3 };

  constructor(private pending: Map<string, HandoffPayload>) {}

  toToolDef() {
    return toolDef(
      HandoffTool.TOOL_NAME,
      "Transition to a new phase by clearing context and restarting with a prepared plan. Use when transitioning work phase, examples: planning → execution, research → implementation, analysis → action, or need fresh focus on essential context, or when asked to prepare a plan and execute. Be thorough — this is your only bridge to the next phase, but don't paste file contents, and don't over-describe what's inside the files.",
      {
        properties: {
          content: param(
            "string",
            "The handoff content - a clear and concise summary of the task and key decision items for the next phase. This becomes the starting point for the fresh conversation.",
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
            "Optional list of file paths relevant to the next phase. This instructs which files are important context and will be read.",
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
      content: args.content,
      title: (args.title as string) || undefined,
      instructions: (args.instructions as string) || undefined,
      files: Array.isArray(args.files)
        ? (args.files as string[]).filter((f) => typeof f === "string")
        : undefined,
    };

    // Defer the actual context clear + enqueue to the TURN_END hook so tool
    // results are added to the conversation before it gets cleared.
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

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{
    enabled?: boolean;
    systemPrompt?: boolean;
  }>(core, "handoffTool");

  if (config.enabled === false) {
    return {};
  }

  // Keyed by session id: the tool instance is shared across all sessions
  // (e.g. multiple webui clients), so pending handoffs must be namespaced.
  const pending = new Map<string, HandoffPayload>();

  const handoffTool = new HandoffTool(pending);

  // Formats the handoff payload as the first user message of the fresh conversation.
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
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("handoff", handoffTool);
      },

      [HOOKS.TURN_END]: async ({ stopped, cancelled, agent, toolResults }) => {
        if (!agent) {
          return;
        }

        // Keyed by agent session id to match the tool's pending map.
        const sessionId = agent.sessionId || "default";

        // A cancelled turn leaves a stale pending handoff; drop it so a later
        // turn in this session can't accidentally consume it.
        if (cancelled) {
          pending.delete(sessionId);
          return;
        }

        if (!stopped || !pending.has(sessionId)) {
          return;
        }

        const handoffCalled = toolResults?.some((tr) => tr.toolName === "handoff");
        if (!handoffCalled) {
          return;
        }

        const handoff = pending.get(sessionId)!;
        pending.delete(sessionId); // Clear immediately to avoid re-processing

        try {
          await agent.clearContext();
          await agent.ensureSystemPrompt();

          // The model composed the handoff content, so tag it as model-sourced.
          const message = buildHandoffMessage(handoff);
          agent.enqueue(message, { source: "model" });
        } catch (e: unknown) {
          // Emit instead of rethrowing so a failure mid-transition doesn't
          // break the agent loop.
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
