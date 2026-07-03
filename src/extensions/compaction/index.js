// Compaction Extension
// Handles context compaction when the conversation grows too long.
// Hooks into `context:full` to trigger compaction.

import extensionData from './extension.json';
import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from './strategies.js';
import { SummarizeStrategy } from './strategies/summarize.js';
import { DropStrategy } from './strategies/drop.js';
import { SummarizeShortStrategy } from './strategies/summarize-short.js';
import { TokenAwareStrategy } from './strategies/token-aware.js';
import { TrimStrategy } from './strategies/trim.js';
import { estimateContextTokens } from './utils.js';
import { HOOKS } from '../../core/hooks.js';
import { logger } from '../../core/logger.js';
import { LlmError } from '../../core/error.js';
import { Message } from '../../core/context/message.js';

/**
 * Create the compaction extension.
 *
 * @param {Object} core - The core object with hooks, config, etc.
 * @returns {Object|null} Extension instance, or null if compaction is disabled.
 */
export function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.compaction || {};
  const cs = extensionData.configSchema.compaction.properties;

  const settings = {
    enabled: config.enabled ?? cs.enabled.default,
    reserveTokens: config.reserveTokens ?? cs.reserveTokens.default,
    keepRecentMessages: config.keepRecentMessages ?? cs.keepRecentMessages.default,
    strategy: config.strategy ?? cs.strategy.default,
  };

  // Normalize: config uses keepRecentMessages, strategies use keepRecent
  if (settings.keepRecentMessages !== undefined) {
    settings.keepRecent = settings.keepRecentMessages;
  }

  if (!settings.enabled) return null;

  // Register built-in strategies
  const registry = new CompactionStrategyRegistry();
  registry.register(new SummarizeStrategy());
  registry.register(new DropStrategy());
  registry.register(new SummarizeShortStrategy());
  registry.register(new TokenAwareStrategy());
  registry.register(new TrimStrategy());

  return {
    hooks: {
      /**
       * Handle context hook — check if compaction is needed before each LLM call.
       * Inspects the messages array and compacts the agent's context if token
       * budget is exceeded. Returns modified messages to the agent.
       */
      [HOOKS.CONTEXT]: async ({ messages, agent }) => {
        if (!settings.enabled) return;

        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        // Quick check: do we have enough messages?
        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        // Check token budget
        const estimatedTokens = estimateContextTokens(nonSystemMessages);
        const reserveTokens = settings.reserveTokens;
        const modelConfig = core.modelRegistry?.[agent.model];
        const contextLimit = modelConfig?.maxTokens || 128000;

        if (estimatedTokens <= contextLimit - reserveTokens) return;

        // Get the strategy
        const strategy = registry.get(settings.strategy) || registry.getDefault();
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
              const strategies = registry.getAll().map(s => ({
                name: s.name,
                description: s.description,
              }));
              const lines = ['Available compaction strategies:'];
              for (const s of strategies) {
                const marker = s.name === settings.strategy ? ' (current)' : '';
                lines.push(`  ${s.name}${marker} - ${s.description}`);
              }
              return { content: lines.join('\n') };
            } else {
              // Set strategy
              settings.strategy = action;
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
    const nonSystemMessages = agent.log.getNonSystem();

    if (nonSystemMessages.length <= 2) {
      return { content: 'Not enough messages to compact.' };
    }

    // If keep is specified, just trim to that many messages
    if (keep !== null) {
      const systemMessages = agent.log.getSystem();
      const keptMessages = nonSystemMessages.slice(-keep);
      agent.replaceContext([...systemMessages, ...keptMessages]);
      return { content: `Context compacted to ${keptMessages.length} messages.` };
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
    const messages = agent.log.getAll(); // defensive copy — strategies expect Message[]
    const model = agent.model;
    const modelConfig = core.modelRegistry?.[model];

    // Build the LLM chat function from the agent's LLM client.
    // Wires a real AbortController to the agent's cancellation signals
    // so compaction can be interrupted (task agents via _abortSignal,
    // main agent via _cancelled flag checked in the event loop).
    const llmChat = async (chatMessages, chatModel) => {
      const abortController = new AbortController();

      // Wire to task-agent abort signal if present
      if (agent._abortSignal) {
        if (agent._abortSignal.aborted) {
          abortController.abort();
        } else {
          agent._abortSignal.addEventListener(
            'abort',
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

      let fullText = '';
      for await (const event of stream) {
        // Check main-agent cancellation flag each iteration (Ctrl+C, etc.)
        if (agent._cancelled) {
          abortController.abort();
          throw LlmError.Cancelled('Compaction cancelled');
        }
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
        const summaryMsg = new Message({
          role: 'user',
          content: `<previous-context-summary>${result.summary}</previous-context-summary>`,
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
      core.hooks?.notifyHooks(HOOKS.OUTPUT_EVENT, {
        type: 'compaction_result',
        data: result,
      });

    } catch (e) {
      // Compaction failure is non-fatal — log and continue
      logger.error(`[compaction] error: ${e.message}`);
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
export { TrimStrategy } from './strategies/trim.js';
