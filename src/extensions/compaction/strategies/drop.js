// Drop old messages without summarizing.

import { findFirstKeptIndex, estimateContextTokens } from '../utils.js';
import { CompactionStrategy } from '../strategies.js';

/**
 * Remove old messages without summarizing. No LLM cost.
 */
export class DropStrategy extends CompactionStrategy {
  name = 'drop';
  description = 'Remove old messages without summarizing. Fastest option, no LLM cost, but loses all context from compacted messages.';

  async execute(messages, settings, llmChat, model) {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
    if (firstKept === 0) return null;

    return {
      summary: null,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: 'drop',
        tokensBefore: estimateContextTokens(messages),
        tokensAfter: estimateContextTokens(messages.slice(firstKept)),
      },
    };
  }

  canCompact(messages, settings) {
    const nonSystem = messages.filter(m => m.role !== 'system');
    return nonSystem.length > (settings.keepRecent || 3) * 2;
  }
}
