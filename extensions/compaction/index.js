// Compaction Extension
// Handles context compaction when the conversation grows too long.
// Hooks into `context:full` to trigger compaction.

import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from './strategies.js';
import { SummarizeStrategy } from './strategies/summarize.js';
import { DropStrategy } from './strategies/drop.js';
import { SummarizeShortStrategy } from './strategies/summarize-short.js';
import { TokenAwareStrategy } from './strategies/token-aware.js';
import { estimateContextTokens } from './utils.js';
import { HOOKS } from '../../src/core/hooks.js';

/**
 * Default compaction settings.
 */
const DEFAULT_COMPACTION = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentMessages: 3,
  strategy: 'summarize',
};

/**
 * Create the compaction extension.
 *
 * @param {Object} core - The core object with hooks, config, etc.
 * @returns {Object|null} Extension instance, or null if compaction is disabled.
 */
export function create(core) {
  const config = core.config?.compaction;
  if (config?.enabled === false) return null;

  const settings = { ...DEFAULT_COMPACTION, ...config };
  // Normalize: config uses keepRecentMessages, strategies use keepRecent
  if (settings.keepRecentMessages !== undefined) {
    settings.keepRecent = settings.keepRecentMessages;
  }

  // Register built-in strategies
  const registry = new CompactionStrategyRegistry();
  registry.register(new SummarizeStrategy());
  registry.register(new DropStrategy());
  registry.register(new SummarizeShortStrategy());
  registry.register(new TokenAwareStrategy());

  return {
    hooks: {
      /**
       * Handle context:full hook — trigger compaction if needed.
       * The agent passes itself and context size; the extension does the work.
       */
      [HOOKS.CONTEXT_FULL]: async ({ agent, contextSize }) => {
        if (!settings.enabled) return;

        const messages = agent.context;
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        // Quick check: do we have enough messages?
        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        // Check token budget
        const estimatedTokens = estimateContextTokens(nonSystemMessages);
        const reserveTokens = settings.reserveTokens || DEFAULT_COMPACTION.reserveTokens;
        const modelConfig = core.modelRegistry?.[agent.model];
        const contextLimit = modelConfig?.maxTokens || 128000;

        if (estimatedTokens <= contextLimit - reserveTokens) return;

        // Get the strategy
        const strategy = registry.get(settings.strategy) || registry.getDefault();
        if (!strategy) return;

        // Check if compaction is applicable
        if (!strategy.canCompact(nonSystemMessages, settings)) return;

        // Execute compaction via the strategy
        await _performCompaction(core, agent, strategy, settings);
      },
    },

    // Expose for external use
    registry,
    settings,

    /**
     * Get all available strategies with descriptions.
     */
    getStrategyList() {
      return registry.getAll().map(s => ({
        name: s.name,
        description: s.description,
      }));
    },
  };
}

/**
 * Perform the actual compaction.
 */
async function _performCompaction(core, agent, strategy, settings) {
  const messages = agent.context;
  const model = agent.model;
  const modelConfig = core.modelRegistry?.[model];

  // Build the LLM chat function from the agent's LLM client
  const llmChat = async (chatMessages, chatModel) => {
    const stream = agent._llmClient.chatStreamCancellable(
      chatMessages,
      modelConfig || { name: chatModel, temperature: null, maxTokens: 4096 },
      [],
      { aborted: false },
    );

    let fullText = '';
    for await (const event of stream) {
      if (event.type === 'content') {
        fullText += event.content;
      }
    }
    return fullText;
  };

  try {
    const result = await strategy.execute(messages, settings, llmChat, model);
    if (!result) return;

    // Apply the compaction result
    const compactedCount = result.messagesCompacted;

    // Replace compacted messages with summary
    if (result.summary) {
      // Create a summary message with marker wrapper
      const summaryMsg = {
        role: 'user',
        content: `<m_ckga3qxdoia7896k>${result.summary}</m_ckga3qxdoia7896k>`,
      };

      // Replace the compacted portion
      agent._context = [
        summaryMsg,
        ...messages.slice(compactedCount),
      ];
    } else {
      // Drop strategy — just remove the old messages
      agent._context = messages.slice(compactedCount);
    }

    // Emit compaction result event
    core.hooks?.emit(HOOKS.OUTPUT_EVENT, {
      type: 'compaction_result',
      data: result,
    });

  } catch (e) {
    // Compaction failure is non-fatal — log and continue
    console.error(`[compaction] error: ${e.message}`);
  }
}

// ── Re-exports for backward compatibility ────────────────────────────────────

export { estimateContextTokens, findFirstKeptIndex, serializeConversation, estimateMessageTokens, shouldCompact, compactMessages } from './utils.js';
export { CompactionStrategy, CompactionStrategyRegistry } from './strategies.js';
export { SummarizeStrategy } from './strategies/summarize.js';
export { DropStrategy } from './strategies/drop.js';
export { SummarizeShortStrategy } from './strategies/summarize-short.js';
export { TokenAwareStrategy } from './strategies/token-aware.js';
