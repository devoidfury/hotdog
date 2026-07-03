// Binary-search trim strategy.
// Drops the minimum number of oldest messages to fit under budget.
// No LLM cost -- O(log n) token counts using local estimation.

import { estimateContextTokens, findFirstKeptIndex } from '../utils.js';
import { CompactionStrategy } from '../strategies.js';

/**
 * Binary-search trim: drop the minimum number of oldest messages to fit under budget.
 * No LLM call required. More precise than 'drop' which uses a fixed message count.
 */
export class TrimStrategy extends CompactionStrategy {
  name = 'trim';
  description = 'Binary-search trim: drop the minimum number of oldest messages to fit under budget. No LLM cost.';

  async execute(messages, settings, llmChat, model) {
    const contextLimit = settings.contextLimit
      || (model && model.includes('128k') ? 131072 : 128000);
    const effectiveMax = contextLimit - (settings.reserveTokens || 0);

    // Separate system and non-system messages, tracking original indices.
    const systemMessages = [];
    const nonSystemIndices = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') {
        systemMessages.push(i);
      } else {
        nonSystemIndices.push(i);
      }
    }

    const nonSystemCount = nonSystemIndices.length;

    // Nothing to trim
    if (nonSystemCount === 0) return null;

    // Already under budget -- nothing to do
    const tokensBefore = estimateContextTokens(messages);
    if (tokensBefore <= effectiveMax) return null;

    // Protect the keepRecent zone
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
    const maxTrimCount = nonSystemCount - (firstKept > 0 ? nonSystemIndices.length - nonSystemIndices.indexOf(nonSystemIndices.filter(i => i >= firstKept)[0] ?? nonSystemCount) : 0);

    // Simpler: count how many non-system messages are before firstKept
    const droppableCount = nonSystemIndices.filter(i => i < firstKept).length;
    if (droppableCount === 0) return null;

    // Binary search on the number of non-system messages to drop from the front.
    // We want the minimum dropCount such that keeping system + nonSystem[dropCount:] fits.
    let lo = 1, hi = droppableCount;
    let bestDrop = -1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);

      // Build candidate: system messages + non-system messages starting from dropCount
      const keptIndices = [...systemMessages, ...nonSystemIndices.slice(mid)];
      const candidate = keptIndices.map(i => messages[i]);
      const tokens = estimateContextTokens(candidate);

      if (tokens <= effectiveMax) {
        bestDrop = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    if (bestDrop < 0) return null;

    // bestDrop is the number of non-system messages to drop from the front.
    // The first message we keep is nonSystemIndices[bestDrop].
    // messagesCompacted must be an index into the original messages array
    // such that messages.slice(compactedCount) gives us the kept portion.
    const firstKeptIndex = nonSystemIndices[bestDrop];

    return {
      summary: null,
      messagesCompacted: firstKeptIndex,
      metadata: {
        strategyName: 'trim',
        tokensBefore,
        tokensAfter: estimateContextTokens(messages.slice(firstKeptIndex)),
        messagesDropped: bestDrop,
        contextLimit,
      },
    };
  }

  canCompact(messages, settings) {
    const nonSystem = messages.filter(m => m.role !== 'system');
    if (nonSystem.length <= (settings.keepRecent || 3) * 2) return false;

    const contextLimit = settings.contextLimit || 128000;
    const effectiveMax = contextLimit - (settings.reserveTokens || 0);

    // Only applicable if we're actually over budget
    return estimateContextTokens(nonSystem) > effectiveMax;
  }
}
