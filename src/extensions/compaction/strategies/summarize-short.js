// Aggressive summarization with shorter output.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_SHORT,
} from '../prompts.js';
import { serializeConversation, findFirstKeptIndex, estimateContextTokens } from '../utils.js';
import { CompactionStrategy } from '../strategies.js';
import { AgentError } from '../../../core/error.js';

/**
 * Aggressive LLM summarization with shorter output.
 * Less context preserved but more efficient.
 */
export class SummarizeShortStrategy extends CompactionStrategy {
  name = 'summarize-short';
  description = 'Aggressive LLM summarization with shorter output. Less context preserved but more efficient.';

  async execute(messages, settings, llmChat, model) {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
    if (firstKept === 0) return null;

    const messagesToCompact = messages.slice(0, firstKept);
    const conversation = serializeConversation(messagesToCompact);
    const userPrompt = SUMMARIZATION_USER_PROMPT_SHORT.replace('{conversation}', conversation);

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

    return {
      summary,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: 'summarize-short',
        tokensBefore: estimateContextTokens(messages),
        tokensAfter: estimateContextTokens(messages.slice(firstKept)),
      },
    };
  }
}
