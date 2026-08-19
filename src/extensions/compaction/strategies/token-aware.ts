// Token-aware compaction strategy.

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
} from "../prompts.ts";
import { serializeConversation, estimateContextTokens, estimateMessageTokens } from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";
import { AgentError } from "../../../core/error.ts";

/**
 * Compact to a target token count.
 */
export class TokenAwareStrategy extends CompactionStrategy {
  override name = "token-aware";
  override description = "Compact to a target token count. Dynamically determines how many messages to keep based on precise token estimation.";

  constructor() {
    super();
  }

  override async execute(
    messages: Message[],
    settings: CompactionSettings,
    llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    model: string,
  ): Promise<CompactResult | null> {
    const targetTokens = settings.targetTokens || settings.reserveTokens || 16384;
    const contextLimit = settings.contextLimit
      || (model && model.includes("32k") ? 32768 : model && model.includes("128k") ? 131072 : 128000);
    const maxKeepTokens = contextLimit - targetTokens;

    let cumulativeTokens = 0;
    let lastKeptIndex = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role === "system") continue;
      const msgTokens = estimateMessageTokens(msg);
      if (cumulativeTokens + msgTokens > maxKeepTokens) break;
      cumulativeTokens += msgTokens;
      lastKeptIndex = i;
    }

    if (lastKeptIndex <= 0) return null;

    // Back up the boundary so the kept window never starts with a tool
    // result whose parent assistant tool_calls message would be compacted
    // away (strict OpenAI-compatible backends 400 on orphaned tool
    // messages). Keeping the parent may overshoot maxKeepTokens by one
    // message; that is cheaper than a hard API error.
    while (lastKeptIndex > 0 && messages[lastKeptIndex]!.role === "tool") {
      lastKeptIndex--;
      cumulativeTokens += estimateMessageTokens(messages[lastKeptIndex]!);
    }
    if (lastKeptIndex <= 0) return null;

    const messagesToCompact = lastKeptIndex;
    if (messagesToCompact === 0) return null;

    const messagesToSummarize = messages.slice(0, messagesToCompact).filter((m): m is Message => m != null);
    const conversation = serializeConversation(messagesToSummarize);
    const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace("{conversation}", () => conversation);

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

    const tokensBefore = estimateContextTokens(messages.filter((m): m is Message => m != null));
    const summaryTokens = estimateMessageTokens({ role: "assistant", content: summary });
    const tokensAfter = cumulativeTokens + summaryTokens;

    return {
      summary,
      messagesCompacted: messagesToCompact,
      metadata: {
        strategyName: "token-aware",
        tokensBefore,
        tokensAfter,
        targetTokens,
        maxKeepTokens,
      },
    };
  }

  override canCompact(messages: Message[], settings: CompactionSettings): boolean {
    const nonSystem = messages.filter((m): m is Message => m != null && m.role !== "system");
    const targetTokens = settings.targetTokens || settings.reserveTokens || 16384;
    const contextLimit = settings.contextLimit || 128000;
    const maxKeepTokens = contextLimit - targetTokens;
    return estimateContextTokens(nonSystem) > maxKeepTokens;
  }
}
