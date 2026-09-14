import { SUMMARIZATION_USER_PROMPT_SHORT } from "../prompts.ts";
import {
  runSummarization,
  findFirstKeptIndex,
  estimateContextTokens,
  estimatorFor,
  type WireRenderContext,
} from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";

export class SummarizeShortStrategy extends CompactionStrategy {
  override name = "summarize-short";
  override description = "Aggressive LLM summarization with shorter output. Less context preserved but more efficient.";

  constructor() {
    super();
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
      SUMMARIZATION_USER_PROMPT_SHORT,
    );

    return {
      summary,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: "summarize-short",
        tokensBefore: estimateContextTokens(messages, estimatorFor(wire)),
        tokensAfter: estimateContextTokens(messages.slice(firstKept), estimatorFor(wire)),
      },
    };
  }
}
