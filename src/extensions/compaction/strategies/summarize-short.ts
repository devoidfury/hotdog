import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_SHORT,
} from "../prompts.ts";
import {
  serializeConversation,
  findFirstKeptIndex,
  estimateContextTokens,
  estimatorFor,
  type WireRenderContext,
} from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";
import { AgentError } from "@core/error.ts";

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

    const messagesToCompact = messages.slice(0, firstKept);
    const conversation = serializeConversation(messagesToCompact, wire);
    const userPrompt = SUMMARIZATION_USER_PROMPT_SHORT.replace("{conversation}", () => conversation);

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
        strategyName: "summarize-short",
        tokensBefore: estimateContextTokens(messages, estimatorFor(wire)),
        tokensAfter: estimateContextTokens(messages.slice(firstKept), estimatorFor(wire)),
      },
    };
  }
}
