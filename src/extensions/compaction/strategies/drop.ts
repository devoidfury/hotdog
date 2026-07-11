// Drop old messages without summarizing.

import { findFirstKeptIndex, estimateContextTokens } from "../utils.ts";
import { CompactionStrategy, Message, CompactionSettings, CompactResult } from "../strategies.ts";

/**
 * Keep the last N messages and remove older messages without summarizing.
 */
export class DropStrategy extends CompactionStrategy {
  name = "drop";
  description =
    "Keep the last N messages and remove older messages without summarizing. Fastest option, no LLM cost, but loses all context from compacted messages.";

  async execute(messages: Message[], settings: CompactionSettings): Promise<CompactResult | null> {
    const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
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

  canCompact(messages: Message[], settings: CompactionSettings): boolean {
    const nonSystem = messages.filter((m) => m.role !== "system");
    return nonSystem.length > (settings.keepRecent || 3) * 2;
  }
}
