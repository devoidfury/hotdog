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
import { findModelEntry, type ModelConfig } from "../../core/config/providers.ts";
import { matcher, completion } from "./completions.ts";

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  strategy: string;
  userTurnGuardPrompt: string;
}

/**
 * Resolve the model config from the agent's model registry.
 */
function getModelConfig(modelRegistry: Record<string, ModelConfig>, modelName: string): { name: string; temperature: number | null; contextLimit: number; reasoningEffort?: string } | null {
  const entry = findModelEntry(modelName, modelRegistry);
  if (!entry) return null;
  if (typeof entry.contextLimit !== "number" || entry.contextLimit <= 0) {
    throw new Error(`Model "${modelName}" missing contextLimit in registry`);
  }
  return {
    name: entry.name || modelName,
    temperature: entry.temperature ?? null,
    contextLimit: entry.contextLimit,
    reasoningEffort: entry.reasoningEffort,
  };
}

/**
 * Create the compaction extension.
 */
export function create(core: CoreContext): ExtensionInstance | null {
  // Config defaults come from extension.json configSchema
  const settings = getExtensionConfig<CompactionSettings>(core, "compaction");

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
        content: settings.userTurnGuardPrompt,
      }),
    ];
  }

  /**
   * Perform the actual compaction.
   */
  async function _performCompaction(agent: Agent, strategy: CompactionStrategy): Promise<void> {

    const messages = agent.context.getMessages(); // defensive copy — strategies expect Message[]
    const model = agent.model;
    const modelConfig = getModelConfig(agent.modelRegistry, model);

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
          fullText += event.content;
        }
      }
      return fullText;
    };

    try {
      const result = await strategy.execute(messages, settings, llmChat, model);
      if (!result) return;

      const compactedCount = result.messagesCompacted;

      // Replace compacted messages with summary
      if (result.summary) {
        // Create a summary message with marker wrapper
        const tag = "previous-context-summary";
        const summaryMsg = new Message({
          role: "user",
          content: `<${tag}>${result.summary}</${tag}>`,
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
        agent,
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
    const nonSystemMessages = agent.context.getNonSystem();

    if (nonSystemMessages.length <= 2) {
      return { action: ACTIONS.DISPLAY, content: "Not enough messages to compact." };
    }

    // If keep is specified, just trim to that many messages
    if (opts.keep !== null) {
      const systemMessages = agent.context.getSystem();
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

  const instance: ExtensionInstance & {
    registry: CompactionStrategyRegistry;
    settings: CompactionSettings;
    getStrategyList(): Array<{ name: string; description: string }>;
  } = {
    hooks: {
      /** Mount registry on agent for completion access. */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ agent }) => {
        (agent as { compactionRegistry?: typeof strategyRegistry }).compactionRegistry = strategyRegistry;
      },

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
        const modelConfig = getModelConfig(agent.modelRegistry, agent.model);
        if (!modelConfig) {
          throw new Error(`Model "${agent.model}" not found in registry`);
        }
        const contextLimit = modelConfig.contextLimit;

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
       * Register the compaction command.
       *
       * Syntaxes:
       *   /compact                         - Run compaction with the current strategy
       *   /compact [n] [--compact-debug]   - Trim context to n messages (optional debug)
       *   /compact <strategy>              - Switch the compaction strategy
       *   /compact:<strategy>              - Switch the compaction strategy (colon form)
       */
      [HOOKS.COMMANDS_REGISTER]: async (payload: CommandsRegisterPayload) => {
        const { registry } = payload;

        const strategyNames = (): string =>
          strategyRegistry.getAll().map((s) => s.name).join(", ");

        const setStrategy = (name: string) => {
          if (!strategyRegistry.get(name)) {
            return {
              action: ACTIONS.ERROR,
              error: `Unknown compaction strategy: '${name}'. Available: ${strategyNames()}`,
            };
          }
          settings.strategy = name;
          return { action: ACTIONS.DISPLAY, content: `Compaction strategy set to: ${name}` };
        };

        registry.register("compact", {
          description: "Compact context ([n] [--compact-debug]) or switch strategy (<strategy>, compact:<strategy>)",
          matches: (cmd: string) =>
            cmd === "compact" || cmd.startsWith("compact ") || cmd.startsWith("compact:"),
          completion,
          handler: async (agent, cmdValue) => {
            const parts = (cmdValue || "").split(/\s+/).filter(Boolean);
            const head = parts[0] || "compact";
            const rest = parts.slice(1);
            const debug = rest.includes("--compact-debug");
            const args = rest.filter((p) => p !== "--compact-debug");

            // Colon form: /compact:<strategy>
            if (head.startsWith("compact:")) {
              if (args.length > 0) {
                return {
                  action: ACTIONS.ERROR,
                  error: `Unexpected arguments: ${args.join(" ")}\nUsage: /compact:<strategy> (available: ${strategyNames()})`,
                };
              }
              return setStrategy(head.slice("compact:".length));
            }

            // No args: run compaction
            if (args.length === 0) {
              return await _handleCompactCommand(agent, { keep: null, debug });
            }

            // Strategy name: switch strategy
            const first = args[0] ?? "";
            if (strategyRegistry.get(first)) {
              if (args.length > 1) {
                return {
                  action: ACTIONS.ERROR,
                  error: `Unexpected arguments: ${args.slice(1).join(" ")}\nUsage: /compact <strategy> (available: ${strategyNames()})`,
                };
              }
              return setStrategy(first);
            }

            // Numeric: trim context to n messages
            if (args.length === 1 && /^\d+$/.test(first)) {
              return await _handleCompactCommand(agent, {
                keep: parseInt(first, 10),
                debug,
              });
            }

            return {
              action: ACTIONS.ERROR,
              error: `Unknown argument: '${first}'\nUsage: /compact [n] [--compact-debug] | /compact <strategy> | /compact:<strategy>\nAvailable strategies: ${strategyNames()}`,
            };
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

  // Register completion with completion service (if available)
  if (core.completion) {
    core.completion.register(matcher, completion, "compaction:compact-strategy");
  }

  return instance;
}

// ── Re-exports for convenience ───────────────────────────────────────────────

export { estimateContextTokens, findFirstKeptIndex, serializeConversation, estimateMessageTokens, shouldCompact, compactMessages } from "./utils.ts";
export { CompactionStrategy, CompactionStrategyRegistry } from "./strategies.ts";
export { SummarizeStrategy } from "./strategies/summarize.ts";
export { DropStrategy } from "./strategies/drop.ts";
export { SummarizeShortStrategy } from "./strategies/summarize-short.ts";
export { TokenAwareStrategy } from "./strategies/token-aware.ts";
export { TrimStrategy } from "./strategies/trim.ts";
