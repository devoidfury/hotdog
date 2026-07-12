// Compaction Extension
// Handles context compaction when the conversation grows too long.
// Hooks into `context:full` to trigger compaction.

import extensionData from "./extension.json" with { type: "json" };
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
import {
  CoreContext,
  ExtensionInstance,
  CommandsRegisterPayload,
  ContextHookPayload,
  getExtensionConfig,
  getConfigSchemaProperties,
  getConfigDefault,
} from "../../core/extensions/types.ts";
import type { ModelConfig } from "../../core/config/providers.ts";

interface Agent {
  model: string;
  sessionId: string;
  log: {
    getAll(): Message[];
    getNonSystem(): Message[];
    getSystem(): Message[];
  };
  buildMessages(): Message[];
  replaceContext(messages: Message[]): void;
  llmClient: {
    chatStreamCancellable(
      messages: Message[],
      modelConfig: Record<string, unknown>,
      toolDefs: unknown[],
      signal: AbortSignal,
    ): AsyncIterable<Record<string, unknown>>;
  };
  abortSignal?: AbortSignal;
  cancelled?: boolean;
}

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
function getModelConfig(core: CoreContext, modelName: string): Record<string, unknown> | undefined {
  // Check core.resolved?.modelRegistry first, then fall back to core.modelRegistry
  const registry = core.resolved?.modelRegistry || (core as Record<string, unknown>).modelRegistry;
  if (registry) {
    return (registry as Record<string, ModelConfig>)[modelName] as Record<string, unknown> | undefined;
  }
  return undefined;
}

/**
 * Create the compaction extension.
 */
export function create(core: CoreContext): ExtensionInstance | null {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig(core, "compaction");
  const cs = getConfigSchemaProperties(extensionData.configSchema, "compaction");

  const settings: CompactionSettings = {
    enabled: (config.enabled as boolean) ?? getConfigDefault<boolean>(cs, "enabled") ?? true,
    reserveTokens: (config.reserveTokens as number) ?? getConfigDefault<number>(cs, "reserveTokens") ?? 16384,
    keepRecentMessages: (config.keepRecentMessages as number) ?? getConfigDefault<number>(cs, "keepRecentMessages") ?? 8,
    strategy: (config.strategy as string) ?? getConfigDefault<string>(cs, "strategy") ?? "summarize",
  };

  // Normalize: config uses keepRecentMessages, strategies use keepRecent
  if (settings.keepRecentMessages !== undefined) {
    settings.keepRecent = settings.keepRecentMessages;
  }

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
        wrapped,
        modelConfig || { name: chatModel, temperature: null, maxTokens: 4096 },
        [],
        abortController.signal,
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
        agent.replaceContext([
          summaryMsg,
          ...messages.slice(compactedCount),
        ]);
      } else {
        // Drop strategy — just remove the old messages
        agent.replaceContext(messages.slice(compactedCount));
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
      agent.replaceContext([...systemMessages, ...keptMessages]);
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
      [HOOKS.CONTEXT]: async ({ messages, agent }: ContextHookPayload & { messages: Message[]; agent: Agent }) => {
        if (!settings.enabled) return;

        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        // Quick check: do we have enough messages?
        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        // Check token budget
        const estimatedTokens = estimateContextTokens(nonSystemMessages);
        const reserveTokens = settings.reserveTokens;
        const modelConfig = getModelConfig(core, agent.model);
        const contextLimit = (modelConfig?.maxTokens as number) || 128000;

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
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }: { registry: CommandsRegisterPayload }) => {
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
