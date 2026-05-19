// Drop old messages without summarizing.
// Fastest option, no LLM cost, but loses all context from compacted messages.

import {
  findFirstKeptIndex,
  estimateContextTokens,
} from '../../compaction.js';
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
    // Drop requires at least 4 non-system messages (2 pairs) to have anything to drop
    const nonSystem = messages.filter(m => m.role !== 'system');
    return nonSystem.length > (settings.keepRecent || 3) * 2;
  }
}
