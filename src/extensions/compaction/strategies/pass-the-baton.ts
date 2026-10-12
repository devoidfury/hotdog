import {
  estimateContextTokens,
  estimateMessageTokens,
  estimatorFor,
  type WireRenderContext,
} from "../utils.ts";
import {
  CompactionStrategy,
  Message,
  CompactionSettings,
  CompactResult,
  requireContextLimit,
} from "../strategies.ts";
import { BATON_NOTICE_PROMPT } from "../prompts.ts";

/** An assistant turn carrying tool_calls (whose results may fall in the popped tail). */
function hasToolCalls(msg: Message | undefined | null): boolean {
  if (!msg) return false;
  const calls = msg.toolCalls ?? (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/**
 * True when a baton notice with this exact text is already in the context.
 * The CONTEXT hook fires before every LLM call, and the context stays over
 * budget while the agent wraps up — without this guard every subsequent
 * call would shave another slice off the tail and eat the session alive.
 */
export function hasBatonNotice(messages: Message[], notice: string): boolean {
  return messages.some((m) => {
    if (!m || m.role !== "harness" || m.source !== "harness") return false;
    const content = m.content;
    if (typeof content === "string") return content === notice;
    return (
      Array.isArray(content) &&
      content.some(
        (p) =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: string }).type === "system-notice" &&
          (p as { text?: string }).text === notice,
      )
    );
  });
}

/**
 * pass-the-baton: the prefix-cache-friendly compaction.
 *
 * Mirror of token-aware on purpose: it walks FORWARD and keeps the largest
 * OLDEST prefix that fits `contextLimit - reserveTokens`, popping the
 * newest messages. That is the wrong thing for a continuing session (it
 * forgets the recent work) and exactly the right thing here — the surviving
 * context is a strict byte-prefix of the previous prompt, so prefix-matching
 * LLM runners hit their cache and the only new compute is the small notice
 * plus the model's wrap-up. There is no summarization call at all: the
 * model narrates its own handoff, and the session ends with it. The popped
 * tail is stashed (baton-popped.json) so the fresh session after the
 * handoff can re-append the recent turns.
 */
export class PassTheBatonStrategy extends CompactionStrategy {
  override name = "pass-the-baton";
  override description =
    "Tail-pop for prefix caches: keep the largest oldest prefix that fits the budget, pop the newest messages, and append a system-notice ordering a handoff. No LLM call; the kept window stays a byte-identical prefix so prefix-matching caches hit.";

  private noticeFor(settings: CompactionSettings): string {
    return settings.batonNoticePrompt ?? BATON_NOTICE_PROMPT;
  }

  override canCompact(messages: Message[], settings: CompactionSettings): boolean {
    if (hasBatonNotice(messages, this.noticeFor(settings))) return false;
    const contextLimit = requireContextLimit(settings.contextLimit);
    const maxKeepTokens = contextLimit - (settings.reserveTokens || 0);
    // Whole-context estimate: unlike the front-cut strategies, system
    // messages genuinely occupy the kept prefix here and count against it.
    return estimateContextTokens(messages) > maxKeepTokens;
  }

  override async execute(
    messages: Message[],
    settings: CompactionSettings,
    _llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    _model: string,
    wire?: WireRenderContext | null,
  ): Promise<CompactResult | null> {
    const notice = this.noticeFor(settings);
    if (hasBatonNotice(messages, notice)) return null;

    const est = estimatorFor(wire);
    const contextLimit = requireContextLimit(settings.contextLimit);
    const maxKeepTokens = contextLimit - (settings.reserveTokens || 0);

    // Largest fitting prefix: walk forward from index 0 until the next
    // message would exceed the budget. System messages are counted, not
    // skipped — they are part of the byte-prefix the cache re-reads.
    let cumulativeTokens = 0;
    let keepCount = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = msg ? estimateMessageTokens(msg, est) : 0;
      if (cumulativeTokens + msgTokens > maxKeepTokens) break;
      cumulativeTokens += msgTokens;
      keepCount = i + 1;
    }

    if (keepCount >= messages.length) return null; // everything already fits
    if (keepCount === 0) return null; // budget cannot hold even the first message

    // Tail-cut orphan rule (mirror of front-cut's): a kept assistant turn
    // whose tool results all fall in the popped tail dangles, and a kept
    // tool result at the boundary may hold only part of its parent's
    // results — strict OpenAI-compatible backends 400 on both. Pop back
    // over trailing tool turns; the window then ends on a clean exchange.
    while (
      keepCount > 0 &&
      (messages[keepCount - 1]!.role === "tool" || hasToolCalls(messages[keepCount - 1]))
    ) {
      keepCount--;
    }
    if (keepCount === 0) return null;

    const poppedCount = messages.length - keepCount;
    const keptPrefix = messages.slice(0, keepCount);

    return {
      summary: null,
      messagesCompacted: poppedCount,
      keepFrom: "tail",
      appendNotice: notice,
      metadata: {
        strategyName: "pass-the-baton",
        tokensBefore: estimateContextTokens(messages, est),
        tokensAfter: estimateContextTokens(keptPrefix, est),
        poppedCount,
        maxKeepTokens,
      },
    };
  }
}
