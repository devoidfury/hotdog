// Default LLM-based summarization strategy.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
} from "../prompts.ts";
import { serializeConversation, findFirstKeptIndex, estimateContextTokens } from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";
import { AgentError } from "../../../core/error.ts";

/**
 * Default compaction strategy: LLM-based summarization of older messages.
 * Preserves recent messages verbatim.
 */
export class SummarizeStrategy extends CompactionStrategy {
  override name = "summarize";
  override description = "LLM-based summarization of older messages. Produces a structured summary preserving context.";

  override async execute(
    messages: Message[],
    settings: CompactionSettings,
    llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    model: string,
  ): Promise<CompactResult | null> {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent ?? 8);
    if (firstKept === 0) return null;

    const messagesToCompact = messages.slice(0, firstKept);
    const conversation = serializeConversation(messagesToCompact);
    const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace("{conversation}", conversation);

    const summaryMessages = [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    let summary: string;
    try {
      summary = await llmChat(summaryMessages, model);
    } catch (e: unknown) {
      throw AgentError.SummarizationFailed((e as Error).message);
    }

    return {
      summary,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: "summarize",
        tokensBefore: estimateContextTokens(messages),
        tokensAfter: estimateContextTokens(messages.slice(firstKept)),
      },
    };
  }
}
