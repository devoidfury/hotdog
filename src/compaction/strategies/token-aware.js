// Token-aware compaction strategy.
// Compacts to a target token count rather than keeping a fixed number of messages.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
  serializeConversation,
  estimateContextTokens,
  estimateMessageTokens,
} from '../../compaction.js';
import { CompactionStrategy } from '../strategies.js';

/**
 * Compact to a target token count.
 * Dynamically determines how many messages to keep based on precise token estimation.
 */
export class TokenAwareStrategy extends CompactionStrategy {
  name = 'token-aware';
  description = 'Compact to a target token count. Dynamically determines how many messages to keep based on precise token estimation.';

  async execute(messages, settings, llmChat, model) {
    const targetTokens = settings.targetTokens || (settings.reserveTokens || 16384);
    // Derive context limit from model config if available, otherwise use setting, then fallback
    const contextLimit = settings.contextLimit
      || (model && model.includes('32k') ? 32768 : model && model.includes('128k') ? 131072 : 128000);
    const maxKeepTokens = contextLimit - targetTokens;

    // Calculate cumulative tokens from the end to find how many we can keep
    let cumulativeTokens = 0;
    let lastKeptIndex = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'system') continue;
      const msgTokens = estimateMessageTokens(messages[i]);
      if (cumulativeTokens + msgTokens > maxKeepTokens) break;
      cumulativeTokens += msgTokens;
      lastKeptIndex = i;
    }

    // Ensure we keep at least 2 messages (one pair)
    if (lastKeptIndex <= 0) return null;

    // Calculate how many messages to compact
    const messagesToCompact = lastKeptIndex;

    // If there's nothing to compact, return null
    if (messagesToCompact === 0) return null;

    // Token-aware still needs a summary to preserve context
    const messagesToSummarize = messages.slice(0, messagesToCompact);
    const conversation = serializeConversation(messagesToSummarize);
    const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace('{conversation}', conversation);

    const summaryMessages = [
      { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    let summary;
    try {
      summary = await llmChat(summaryMessages, model);
    } catch (e) {
      throw new Error(`Summarization failed: ${e.message}`);
    }

    const tokensBefore = estimateContextTokens(messages);
    const summaryTokens = estimateMessageTokens({ content: summary });
    const tokensAfter = cumulativeTokens + summaryTokens;

    return {
      summary,
      messagesCompacted: messagesToCompact,
      metadata: {
        strategyName: 'token-aware',
        tokensBefore,
        tokensAfter,
        targetTokens,
        maxKeepTokens,
      },
    };
  }

  canCompact(messages, settings) {
    const nonSystem = messages.filter(m => m.role !== 'system');
    const targetTokens = settings.targetTokens || (settings.reserveTokens || 16384);
    const contextLimit = settings.contextLimit || 128000;
    const maxKeepTokens = contextLimit - targetTokens;

    // Only compact if we're over the limit
    return estimateContextTokens(nonSystem) > maxKeepTokens;
  }
}
