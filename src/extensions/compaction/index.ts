// Compaction Extension
// Handles context compaction when the conversation grows too long.
// Hooks into `context:full` to trigger compaction.

import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from "./strategies.ts";
import { SummarizeStrategy } from "./strategies/summarize.ts";
import { DropStrategy } from "./strategies/drop.ts";
import { SummarizeShortStrategy } from "./strategies/summarize-short.ts";
import { TokenAwareStrategy } from "./strategies/token-aware.ts";
import { TrimStrategy } from "./strategies/trim.ts";
import { estimateContextTokens } from "./utils.ts";
import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { logger } from "../../core/logger.ts";
import { LlmError, formatError } from "../../core/error.ts";
import { Message } from "../../core/context/message.ts";
import type { Agent } from "../../core/agent.ts";
import {
  CoreContext,
  ExtensionInstance,
  CommandsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import type { ModelConfig } from "../../core/config/providers.ts";

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  keepRecent: number;
  strategy: string;
}

/**
 * Resolve the model config from core.
 * Checks core.resolved.modelRegistry first, falls back to a default config.
 */
function getModelConfig(core: CoreContext, modelName: string): { name: string; temperature: number | null; contextLimit: number; reasoningEffort?: string } | null {
  // Check core.resolved?.modelRegistry first, then fall back to core.modelRegistry
  const registry = core.resolved?.modelRegistry || ((core as unknown) as Record<string, unknown>).modelRegistry;
  if (registry) {
    const entry = (registry as Record<string, ModelConfig>)[modelName];
    if (!entry) return null;
    return {
      name: entry.name || modelName,
      temperature: entry.temperature ?? null,
      contextLimit: entry.contextLimit ?? 128000,
      reasoningEffort: entry.reasoningEffort,
    };
  }
  return null;
}

/**
 * Create the compaction extension.
 */
export function create(core: CoreContext): ExtensionInstance | null {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<CompactionSettings>(core, "compaction");

  const settings: CompactionSettings = {
    enabled: config.enabled ?? true,
    reserveTokens: config.reserveTokens ?? 16384,
    keepRecentMessages: config.keepRecentMessages ?? 8,
    keepRecent: config.keepRecent ?? config.keepRecentMessages ?? 8,
    strategy: config.strategy ?? "summarize",
  };

  if (!settings.enabled) return null;

  // Register built-in strategies
  const strategyRegistry = new CompactionStrategyRegistry();
  strategyRegistry.register(new SummarizeStrategy());
  strategyRegistry.register(new DropStrategy());
  strategyRegistry.register(new SummarizeShortStrategy());
  strategyRegistry.register(new TokenAwareStrategy());
  strategyRegistry.register(new TrimStrategy());

  // ── Helper functions (inside create() to close over core, settings, registry) ──

  /**
   * Ensure the conversation ends with a user turn.
   * Some strict chat templates (e.g. in LM Studio/llama.cpp) fail if the
   * message history ends with an assistant or tool message.
   */
  function ensureUserTurnGuard(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role === "user") return messages;

    return [
      ...messages,
      new Message({
        role: "user",
        content: "Continue from the compressed conversation context above.",
      }),
    ];
  }

  /**
   * Perform the actual compaction.
   */
  async function _performCompaction(agent: Agent, strategy: CompactionStrategy): Promise<void> {

    const messages = agent.log.getAll(); // defensive copy — strategies expect Message[]
    const model = agent.model;
    const modelConfig = getModelConfig(core, model);

    // Build the LLM chat function from the agent's LLM client.
    const llmChat = async (chatMessages: Array<{ role: string; content: string }>, chatModel: string): Promise<string> => {
      const abortController = new AbortController();

      // Wire to task-agent abort signal if present
      if (agent.abortSignal) {
        if (agent.abortSignal.aborted) {
          abortController.abort();
        } else {
          agent.abortSignal.addEventListener(
            "abort",
            () => abortController.abort(),
            { once: true },
          );
        }
      }

      // Wrap plain objects as Message instances so _escapeMessages() can call .toJSON()
      const wrapped = chatMessages.map(
        (m) => new Message({ role: m.role, content: m.content }),
      );
      const stream = agent.llmClient.chatStreamCancellable(
        wrapped.map((m) => m.toJSON()),
        modelConfig ?? { name: chatModel, temperature: null },
        [],
        abortController.signal,
        agent.sessionId,
      );

      let fullText = "";
      for await (const event of stream) {
        // Check main-agent cancellation flag each iteration (Ctrl+C, etc.)
        if (agent.cancelled) {
          abortController.abort();
          throw LlmError.Cancelled("Compaction cancelled");
        }
        if (event.type === "content") {
          fullText += event.content as string;
        }
      }
      return fullText;
    };

    try {
      const result = await strategy.execute(messages, settings, llmChat, model);
      if (!result) return;

      const compactedCount = (result as { messagesCompacted: number }).messagesCompacted;

      // Replace compacted messages with summary
      if ((result as { summary?: string }).summary) {
        // Create a summary message with marker wrapper
        const tag = "previous-context-summary";
        const summaryMsg = new Message({
          role: "user",
          content: `<${tag}>${(result as { summary: string }).summary}</${tag}>`,
        });

        // Replace the compacted portion
        agent.replaceContext(ensureUserTurnGuard([
          summaryMsg,
          ...messages.slice(compactedCount),
        ]));
      } else {
        // Drop strategy — just remove the old messages
        agent.replaceContext(ensureUserTurnGuard(messages.slice(compactedCount)));
      }

      // Emit compaction result event
      core.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, {
        type: "compaction_result",
        data: result,
      });

    } catch (e: unknown) {
      // Compaction failure is non-fatal — log and continue
      logger.error(`[compaction] error: ${formatError(e)}`);
    }
  }

  /**
   * Handle the /compact command.
   */
  async function _handleCompactCommand(agent: Agent, opts: { keep: number | null; debug: boolean }): Promise<Record<string, unknown>> {
    const nonSystemMessages = agent.log.getNonSystem();

    if (nonSystemMessages.length <= 2) {
      return { action: ACTIONS.DISPLAY, content: "Not enough messages to compact." };
    }

    // If keep is specified, just trim to that many messages
    if (opts.keep !== null) {
      const systemMessages = agent.log.getSystem();
      const keptMessages = nonSystemMessages.slice(-opts.keep);
      agent.replaceContext(ensureUserTurnGuard([...systemMessages, ...keptMessages]));
      return { action: ACTIONS.DISPLAY, content: `Context compacted to ${keptMessages.length} messages.` };
    }

    // Get the strategy
    const strategy = strategyRegistry.get(settings.strategy) || strategyRegistry.getDefault();
    if (!strategy) {
      return { action: ACTIONS.ERROR, error: "No compaction strategy available." };
    }

    if (!strategy.canCompact(nonSystemMessages, settings)) {
      return { action: ACTIONS.DISPLAY, content: "Compaction not applicable with current settings." };
    }

    // Perform compaction
    await _performCompaction(agent, strategy);

    const resultContent = `Context compacted using '${settings.strategy}' strategy.`;
    if (opts.debug) {
      return { action: ACTIONS.DISPLAY, content: resultContent + "\n(Debug mode: debug file written.)" };
    }
    return { action: ACTIONS.DISPLAY, content: resultContent };
  }

  return {
    hooks: {
      /**
       * Handle context hook — check if compaction is needed before each LLM call.
       */
      [HOOKS.CONTEXT]: async ({ messages, agent }) => {
        if (!settings.enabled) return;

        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        // Quick check: do we have enough messages?
        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        // Check token budget
        const estimatedTokens = estimateContextTokens(nonSystemMessages);
        const reserveTokens = settings.reserveTokens;
        const modelConfig = getModelConfig(core, agent.model);
        const contextLimit = (modelConfig?.contextLimit as number) || 128000;

        if (estimatedTokens <= contextLimit - reserveTokens) return;

        // Get the strategy
        const strategy = strategyRegistry.get(settings.strategy) || strategyRegistry.getDefault();
        if (!strategy) return;

        // Check if compaction is applicable
        if (!strategy.canCompact(nonSystemMessages, settings)) return;

        // Execute compaction — modifies agent context in place
        await _performCompaction(agent, strategy);

        // Rebuild messages from the updated context and return them.
        const newMessages = agent.buildMessages();
        return { messages: newMessages };
      },

      /**
       * Register commands for compaction.
       */
      [HOOKS.COMMANDS_REGISTER]: async (payload: CommandsRegisterPayload) => {
        const { registry } = payload;
        // /compact [n] [--compact-debug]
        registry.register("compact", {
          description: "Compact context (compact [n] [--compact-debug])",
          matches: (cmd: string) => cmd.startsWith("compact") && !cmd.startsWith("compact:"),
          handler: async (agent: Agent, cmdValue: string) => {
            const parts = cmdValue.split(/\s+/);
            let keep: number | null = null;
            let debug = false;
            for (const part of parts.slice(1)) {
              if (part === "--compact-debug") {
                debug = true;
              } else if (!Number.isNaN(Number(part))) {
                keep = parseInt(part, 10);
              }
            }
            return await _handleCompactCommand(agent, { keep, debug });
          },
        });

        // /compact:strategy [action] [name]
        registry.register("compact:strategy", {
          description: "Manage compaction strategy (compact:strategy [list|set <name>|help])",
          matches: (cmd: string) => cmd.startsWith("compact:strategy"),
          handler: async (_agent: unknown, cmdValue: string) => {
            const rest = cmdValue.slice(16).trim();
            const parts = rest ? rest.split(/\s+/) : [];
            const action = parts[0] || "list";
            const name = parts[1] || null;

            if (action === "help") {
              return { action: ACTIONS.DISPLAY, content: `Usage: /compact:strategy [list|set <name>|help]\n  list   - Show available strategies\n  set    - Set the current strategy\n  help   - Show this help` };
            } else if (action === "list" || action === "") {
              const strategies = strategyRegistry.getAll().map((s) => ({
                name: s.name,
                description: s.description,
              }));
              const lines = ["Available compaction strategies:"];
              for (const s of strategies) {
                const marker = s.name === settings.strategy ? " (current)" : "";
                lines.push(`  ${s.name}${marker} - ${s.description}`);
              }
              return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
            } else {
              // Set strategy
              settings.strategy = action;
              return { action: ACTIONS.DISPLAY, content: `Compaction strategy set to: ${action}` };
            }
          },
        });
      },
    },

    // Expose for external use
    registry: strategyRegistry,
    settings,

    /**
     * Get all available strategies with descriptions.
     */
    getStrategyList() {
      return strategyRegistry.getAll().map((s) => ({
        name: s.name,
        description: s.description,
      }));
    },
  };
}

// ── Re-exports for convenience ───────────────────────────────────────────────

export { estimateContextTokens, findFirstKeptIndex, serializeConversation, estimateMessageTokens, shouldCompact, compactMessages } from "./utils.ts";
export { CompactionStrategy, CompactionStrategyRegistry } from "./strategies.ts";
export { SummarizeStrategy } from "./strategies/summarize.ts";
export { DropStrategy } from "./strategies/drop.ts";
export { SummarizeShortStrategy } from "./strategies/summarize-short.ts";
export { TokenAwareStrategy } from "./strategies/token-aware.ts";
export { TrimStrategy } from "./strategies/trim.ts";
