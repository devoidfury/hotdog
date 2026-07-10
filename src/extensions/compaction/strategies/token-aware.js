// Token-aware compaction strategy.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
} from '../prompts.js';
import { serializeConversation, estimateContextTokens, estimateMessageTokens } from '../utils.js';
import { CompactionStrategy } from '../strategies.js';
import { AgentError } from '../../../core/error.ts';

/**
 * Compact to a target token count.
 */
export class TokenAwareStrategy extends CompactionStrategy {
  name = 'token-aware';
  description = 'Compact to a target token count. Dynamically determines how many messages to keep based on precise token estimation.';

  async execute(messages, settings, llmChat, model) {
    const targetTokens = settings.targetTokens || (settings.reserveTokens || 16384);
    const contextLimit = settings.contextLimit
      || (model && model.includes('32k') ? 32768 : model && model.includes('128k') ? 131072 : 128000);
    const maxKeepTokens = contextLimit - targetTokens;

    let cumulativeTokens = 0;
    let lastKeptIndex = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'system') continue;
      const msgTokens = estimateMessageTokens(messages[i]);
      if (cumulativeTokens + msgTokens > maxKeepTokens) break;
      cumulativeTokens += msgTokens;
      lastKeptIndex = i;
    }

    if (lastKeptIndex <= 0) return null;

    const messagesToCompact = lastKeptIndex;
    if (messagesToCompact === 0) return null;

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
      throw AgentError.SummarizationFailed(e.message);
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
    return estimateContextTokens(nonSystem) > maxKeepTokens;
  }
}
