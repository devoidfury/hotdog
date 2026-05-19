// Aggressive summarization with shorter output.
// Same as summarize but with a more concise prompt template.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  serializeConversation,
  findFirstKeptIndex,
  estimateContextTokens,
} from '../../compaction.js';
import { CompactionStrategy } from '../strategies.js';

const SUMMARIZATION_USER_PROMPT_SHORT = `The messages above are a conversation to summarize. Produce a CONCISE structured summary.

Use this EXACT format (keep each section very brief):

## Goal
[One sentence]

## Progress
### Done
- [x] [Brief]

### In Progress
- [ ] [Brief]

## Key Decisions
- [Decision]: [Brief rationale]

## Next Steps
1. [Brief]

## Critical Context
- [One-line data or "(none)"]

<conversation>
{conversation}
</conversation>`;

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
      throw new Error(`Summarization failed: ${e.message}`);
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
