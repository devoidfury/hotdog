import { findFirstKeptIndex, estimateContextTokens } from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";

export class DropStrategy extends CompactionStrategy {
  override name = "drop";
  override description =
    "Keep the last N messages and remove older messages without summarizing. Fastest option, no LLM cost, but loses all context from compacted messages.";

  constructor() {
    super();
  }

  override async execute(
    messages: Message[],
    settings: CompactionSettings,
    _llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    _model: string,
  ): Promise<CompactResult | null> {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecentMessages);
    if (firstKept === 0) return null;

    return {
      summary: null,
      messagesCompacted: firstKept,
      metadata: {
        strategyName: "drop",
        tokensBefore: estimateContextTokens(messages),
        tokensAfter: estimateContextTokens(messages.slice(firstKept)),
      },
    };
  }

  override canCompact(messages: Message[], settings: CompactionSettings): boolean {
    const nonSystem = messages.filter((m) => m.role !== "system");
    return nonSystem.length > settings.keepRecentMessages * 2;
  }
}
