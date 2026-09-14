import {
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
  SUMMARIZATION_USER_PROMPT_SHORT,
} from "../prompts.ts";
import {
  runSummarization,
  findFirstKeptIndex,
  estimateContextTokens,
  estimatorFor,
  type WireRenderContext,
} from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";

/**
 * Descriptor for a summarize-family strategy: registry name (the user-facing
 * config value, see extension.json), human description, and the user prompt
 * template for the LLM call.
 */
export interface SummarizeVariant {
  name: string;
  description: string;
  userPrompt: string;
}

export const SUMMARIZE_SHORT_VARIANT: SummarizeVariant = {
  name: "summarize-short",
  description: "Aggressive LLM summarization with shorter output. Less context preserved but more efficient.",
  userPrompt: SUMMARIZATION_USER_PROMPT_SHORT,
};

export class SummarizeStrategy extends CompactionStrategy {
  constructor(
    private variant: SummarizeVariant = {
      name: "summarize",
      description: "LLM-based summarization of older messages. Produces a structured summary preserving context.",
      userPrompt: SUMMARIZATION_USER_PROMPT_TEMPLATE,
    },
  ) {
    super();
    this.name = variant.name;
    this.description = variant.description;
  }

  override canCompact(messages: Message[], settings: CompactionSettings): boolean {
    return messages.length > settings.keepRecentMessages * 2;
  }

  override async execute(
    messages: Message[],
    settings: CompactionSettings,
    llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    model: string,
    wire?: WireRenderContext | null,
  ): Promise<CompactResult | null> {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecentMessages);
    if (firstKept === 0) return null;

    const summary = await runSummarization(
      messages.slice(0, firstKept),
      wire,
      llmChat,
      model,
      this.variant.userPrompt,
    );

    return {
      summary,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: this.variant.name,
        tokensBefore: estimateContextTokens(messages, estimatorFor(wire)),
        tokensAfter: estimateContextTokens(messages.slice(firstKept), estimatorFor(wire)),
      },
    };
  }
}
