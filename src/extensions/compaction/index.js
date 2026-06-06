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
import { HOOKS } from '../../core/hooks.js';

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
        await _performCompaction(agent, strategy);
      },

      /**
       * Handle compact:strategyList hook — return available strategies and current setting.
       * The agent calls this via emit() (sync) to get strategy info for the /compact:strategy command.
       */
      [HOOKS.COMPACT_STRATEGY_LIST]: ({ agent }) => {
        const strategies = registry.getAll().map(s => ({
          name: s.name,
          description: s.description,
        }));
        return {
          strategies,
          current: settings.strategy,
        };
      },

      /**
       * Handle compact:strategySet hook — update the current compaction strategy.
       */
      [HOOKS.COMPACT_STRATEGY_SET]: ({ agent, strategyName }) => {
        // The strategy registry validates at execution time, so allow any name here.
        settings.strategy = strategyName;
      },

      /**
       * Register commands for compaction.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        // /compact [n] [--compact-debug]
        registry.register('compact', {
          description: 'Compact context (compact [n] [--compact-debug])',
          matches: (cmd) => cmd.startsWith('compact') && !cmd.startsWith('compact:'),
          handler: async (agent, cmdValue) => {
            const parts = cmdValue.split(/\s+/);
            let keep = null;
            let debug = false;
            for (const part of parts.slice(1)) {
              if (part === '--compact-debug') {
                debug = true;
              } else if (!Number.isNaN(Number(part))) {
                keep = parseInt(part, 10);
              }
            }
            return await _handleCompactCommand(agent, { keep, debug });
          },
        });

        // /compact:strategy [action] [name]
        registry.register('compact:strategy', {
          description: 'Manage compaction strategy (compact:strategy [list|set <name>|help])',
          matches: (cmd) => cmd.startsWith('compact:strategy'),
          handler: async (agent, cmdValue) => {
            const rest = cmdValue.slice(16).trim();
            const parts = rest ? rest.split(/\s+/) : [];
            const action = parts[0] || 'list';
            const name = parts[1] || null;

            if (action === 'help') {
              return { content: `Usage: /compact:strategy [list|set <name>|help]\n  list   - Show available strategies\n  set    - Set the current strategy\n  help   - Show this help` };
            } else if (action === 'list' || action === '') {
              const result = core.hooks.emit(HOOKS.COMPACT_STRATEGY_LIST, { agent });
              const strategies = result?.strategies || [];
              const lines = ['Available compaction strategies:'];
              for (const s of strategies) {
                const marker = s.name === result?.current ? ' (current)' : '';
                lines.push(`  ${s.name}${marker} - ${s.description}`);
              }
              return { content: lines.join('\n') };
            } else {
              // Set strategy
              core.hooks.emit(HOOKS.COMPACT_STRATEGY_SET, { agent, strategyName: action });
              return { content: `Compaction strategy set to: ${action}` };
            }
          },
        });
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

  // ── Helper functions (inside create() to close over core, settings, registry) ──

  /**
   * Handle the /compact command.
   */
  async function _handleCompactCommand(agent, { keep, debug }) {
    const messages = agent.context;
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= 2) {
      return { content: 'Not enough messages to compact.' };
    }

    // If keep is specified, just trim to that many messages
    if (keep !== null) {
      const systemMessages = messages.filter(m => m.role === 'system');
      const keptMessages = nonSystemMessages.slice(-keep);
      agent._context = [...systemMessages, ...keptMessages];
      return { content: `Context compacted to ${keptMessages.length} messages.` };
    }

    // Auto-compact based on token budget
    const estimatedTokens = estimateContextTokens(nonSystemMessages);
    const reserveTokens = settings.reserveTokens || DEFAULT_COMPACTION.reserveTokens;
    const modelConfig = core.modelRegistry?.[agent.model];
    const contextLimit = modelConfig?.maxTokens || 128000;

    if (estimatedTokens <= contextLimit - reserveTokens) {
      return { content: 'Context is within token budget. No compaction needed.' };
    }

    // Get the strategy
    const strategy = registry.get(settings.strategy) || registry.getDefault();
    if (!strategy) {
      return { error: 'No compaction strategy available.' };
    }

    if (!strategy.canCompact(nonSystemMessages, settings)) {
      return { content: 'Compaction not applicable with current settings.' };
    }

    // Perform compaction
    await _performCompaction(agent, strategy);

    const resultContent = `Context compacted using '${settings.strategy}' strategy.`;
    if (debug) {
      return { content: resultContent + '\n(Debug mode: debug file written.)' };
    }
    return { content: resultContent };
  }

  /**
   * Perform the actual compaction.
   */
  async function _performCompaction(agent, strategy) {
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
}

// ── Re-exports for convenience ───────────────────────────────────────────────

export { estimateContextTokens, findFirstKeptIndex, serializeConversation, estimateMessageTokens, shouldCompact, compactMessages } from './utils.js';
export { CompactionStrategy, CompactionStrategyRegistry } from './strategies.js';
export { SummarizeStrategy } from './strategies/summarize.js';
export { DropStrategy } from './strategies/drop.js';
export { SummarizeShortStrategy } from './strategies/summarize-short.js';
export { TokenAwareStrategy } from './strategies/token-aware.js';
