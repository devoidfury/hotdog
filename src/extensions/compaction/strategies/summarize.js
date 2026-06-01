// Default LLM-based summarization strategy.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
} from '../prompts.js';
import { serializeConversation, findFirstKeptIndex, estimateContextTokens } from '../utils.js';
import { CompactionStrategy } from '../strategies.js';

/**
 * Default compaction strategy: LLM-based summarization of older messages.
 * Preserves recent messages verbatim.
 */
export class SummarizeStrategy extends CompactionStrategy {
  name = 'summarize';
  description = 'LLM-based summarization of older messages. Produces a structured summary preserving context.';

  async execute(messages, settings, llmChat, model) {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
    if (firstKept === 0) return null;

    const messagesToCompact = messages.slice(0, firstKept);
    const conversation = serializeConversation(messagesToCompact);
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

    return {
      summary,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: 'summarize',
        tokensBefore: estimateContextTokens(messages),
        tokensAfter: estimateContextTokens(messages.slice(firstKept)),
      },
    };
  }
}
