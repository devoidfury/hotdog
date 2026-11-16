import {
  estimateContextTokens,
  estimateMessageTokens,
  estimatorFor,
  type WireRenderContext,
} from "../utils.ts";
import type { ToolResultEstimator } from "@utils/token-estimate.ts";
import {
  CompactionStrategy,
  Message,
  CompactionSettings,
  CompactResult,
  requireContextLimit,
} from "../strategies.ts";
import { BATON_NOTICE_PROMPT } from "../prompts.ts";

/** An assistant turn carrying tool_calls (whose results may fall past the cut). */
function hasToolCalls(msg: Message | undefined | null): boolean {
  if (!msg) return false;
  const calls = msg.toolCalls ?? (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/**
 * True when a kept window may END at msg: neither a tool result nor an
 * assistant turn still opening a tool run. A window ending inside a tool
 * run dangles tool_calls (or splits a multi-call result set), and strict
 * OpenAI-compatible backends 400 on both.
 */
function closesExchange(msg: Message | undefined | null): boolean {
  if (!msg) return false;
  return msg.role !== "tool" && !hasToolCalls(msg);
}

/** True when msg IS the baton notice itself (harness provenance required). */
export function isBatonNoticeMessage(msg: Message | undefined | null, notice: string): boolean {
  if (!msg || msg.role !== "harness" || msg.source !== "harness") return false;
  const content = msg.content;
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
}

/**
 * True when a baton notice with this exact text is already in the context.
 *
 * NOTICE LIFECYCLE: appended by the over-budget auto-trigger WITHOUT
 * popping, then consumed by the handoff clear (the TURN_END paths wipe the
 * context it lives in, and the replay window filters the notice text out).
 * Its presence flips the strategy from notice-only to degrade-pop -- it
 * NEVER disables compaction. A notice that locked the baton out switched
 * compaction off precisely when the model had just proven it would not
 * hand off (2026-11-15 victim: 10+ minutes of regrowth with the only
 * remaining rescue path disabled).
 */
export function hasBatonNotice(messages: Message[], notice: string): boolean {
  return messages.some((m) => isBatonNoticeMessage(m, notice));
}

/** A stash must not resurrect a notice into the continuation session. */
function withoutBatonNotice(messages: Message[], notice: string): Message[] {
  return messages.filter((m) => !isBatonNoticeMessage(m, notice));
}

/**
 * Timeline-ordered stash merge: the prior window first, then the newer
 * messages that are not already in it (identity dedupe -- the session's
 * own Message instances flow through the live map, and a pop's tail
 * overlaps an earlier append-time snapshot heavily).
 */
export function mergeStashWindows(prior: Message[], incoming: Message[]): Message[] {
  const seen = new Set<Message>(prior);
  return [...prior, ...incoming.filter((m) => !seen.has(m))];
}

/**
 * The stash window handed to the continuation session: the largest suffix
 * of `messages` that fits `maxKeepTokens`, with the start walked back over
 * tool results so the tail never opens on a tool result orphaned from its
 * parent assistant tool_calls turn (the parent rides along; strict backends
 * 400 otherwise). The notice text never rides.
 */
export function recentWindow(
  messages: Message[],
  est: ToolResultEstimator | undefined,
  maxKeepTokens: number,
  notice: string,
): Message[] {
  let cumulative = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = msg ? estimateMessageTokens(msg, est) : 0;
    if (cumulative + msgTokens > maxKeepTokens) break;
    cumulative += msgTokens;
    start = i;
  }
  while (start > 0 && messages[start]?.role === "tool") start--;
  while (start < messages.length && messages[start]?.role === "tool") start++;
  return withoutBatonNotice(messages.slice(start), notice);
}

/**
 * pass-the-baton: the prefix-cache-friendly compaction, NOTICE-FIRST.
 *
 * AUTO-TRIGGER (CONTEXT hook): when the session crosses the budget, this
 * strategy only APPENDS the handoff notice -- nothing is popped. The
 * request stays the same byte-prefix plus one small appended message (so
 * prefix caches keep hitting), and the model narrates its handoff with the
 * full recent context still in view; the trigger zone fires below the
 * model limit, so the notice still fits. The append also stashes the
 * current recent window, so a handoff on this very turn already has
 * verbatim turns to replay.
 *
 * DEGRADE: a model that ignores the notice and keeps running re-triggers
 * over budget; THEN the tail pops -- the largest OLDEST prefix that fits
 * `contextLimit - reserveTokens`, cut at the last CLEAN EXCHANGE boundary
 * (the newest message that closes an exchange). If no clean boundary
 * exists at a viable floor -- a tool-only worker transcript where every
 * assistant turn is a tool_calls turn -- the strategy returns null rather
 * than a one-message keep, and the rescue chain degrades onward to
 * trim/drop. A popped tail is stashed (merged ahead of any older stash)
 * and the notice re-appended.
 *
 * OVERFLOW RESCUE (PROVIDER_ERROR) pops immediately via the runtime
 * `batonPopNow` directive: the full-size request already failed, there is
 * no room for notice-first. Same clean-exchange floor and budget.
 *
 * HANDOFF (TURN_END paths): the context is cleared there either way, so
 * the replay window is stashed BEFORE the clear (path B recomputes from
 * the live context; path A uses the last known stash -- the wrap-up
 * itself lives in the handoff plan). The fresh session replans, and the
 * CONTEXT hook appends the stash verbatim, making the plan message's "Its
 * most recent turns are appended verbatim below" true. There is no LLM
 * summarization call anywhere: the model narrates its own handoff.
 */
export class PassTheBatonStrategy extends CompactionStrategy {
  override name = "pass-the-baton";
  override description =
    "Notice-first tail-pop for prefix caches: over budget appends the handoff notice with nothing popped; a model that ignores it degrades to keeping the largest oldest prefix that fits the budget, cut at a clean exchange boundary, and stashes the recent turns for the continuation. No LLM call.";

  private noticeFor(settings: CompactionSettings): string {
    return settings.batonNoticePrompt ?? BATON_NOTICE_PROMPT;
  }

  override canCompact(messages: Message[], settings: CompactionSettings): boolean {
    const contextLimit = requireContextLimit(settings.contextLimit);
    const maxKeepTokens = contextLimit - (settings.reserveTokens || 0);
    // Whole-context estimate: unlike the front-cut strategies, system
    // messages genuinely occupy the kept prefix here and count against it.
    // No notice gate (R4): with the notice present and the context still
    // over budget, the baton DEGRADES to a pop instead of standing down.
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

    const est = estimatorFor(wire);
    const contextLimit = requireContextLimit(settings.contextLimit);
    const maxKeepTokens = contextLimit - (settings.reserveTokens || 0);

    // Nothing to do when the context already fits the budget -- the
    // notice exists for over-budget moments only.
    if (estimateContextTokens(messages, est) <= maxKeepTokens) return null;

    // NOTICE-FIRST (auto trigger): append only. A notice already in the
    // context, or a caller demanding an immediate pop (overflow rescue,
    // manual /compact), falls through to the pop path below.
    if (!hasBatonNotice(messages, notice) && !settings.batonPopNow) {
      const tokens = estimateContextTokens(messages, est);
      return {
        summary: null,
        messagesCompacted: 0,
        keepFrom: "tail",
        appendNotice: notice,
        // Snapshot of the recent window: if the model hands off in direct
        // response to this notice, the continuation replays it verbatim.
        batonStash: recentWindow(messages, est, maxKeepTokens, notice),
        metadata: {
          strategyName: "pass-the-baton",
          tokensBefore: tokens,
          tokensAfter: tokens,
          poppedCount: 0,
          maxKeepTokens,
          noticeOnly: true,
        },
      };
    }

    // POP PATH (degrade or rescue): largest fitting OLDEST prefix, with
    // the last clean exchange boundary tracked along the way. System
    // messages are counted, not skipped -- they are part of the
    // byte-prefix the cache re-reads.
    let cumulativeTokens = 0;
    let keepCount = 0;
    let lastClean = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = msg ? estimateMessageTokens(msg, est) : 0;
      if (cumulativeTokens + msgTokens > maxKeepTokens) break;
      cumulativeTokens += msgTokens;
      keepCount = i + 1;
      if (closesExchange(msg)) lastClean = keepCount;
    }

    if (keepCount >= messages.length) return null; // everything already fits
    if (keepCount === 0) return null; // budget cannot hold even the first message

    // A naive cut inside a tool run leaves dangling tool_calls or split
    // results in the kept window; rewind -- in ONE jump -- to the last
    // clean exchange. The old per-message descent over trailing tool turns
    // walked past everything on a tool-only transcript and returned a
    // ~1-message keep as "success" (2026-11-15 victim: 276 of 278 popped).
    if (!closesExchange(messages[keepCount - 1])) {
      keepCount = lastClean;
    }

    // FLOOR: the kept window must be a context worth continuing from --
    // at least two messages and at least one assistant turn inside. A
    // prefix of nothing but system prompt + task message is the victim's
    // one-message keep wearing a hat: return null and let the rescue chain
    // degrade onward to trim/drop.
    if (keepCount < 2) return null;
    const keptPrefix = messages.slice(0, keepCount);
    if (!keptPrefix.some((m) => m.role === "assistant")) return null;

    // If the only thing left past the fitting prefix is the notice itself,
    // the context fits with its notice already in place; popping and
    // re-appending it every call is pure churn.
    if (
      keepCount === messages.length - 1 &&
      isBatonNoticeMessage(messages[messages.length - 1], notice)
    ) {
      return null;
    }

    const poppedCount = messages.length - keepCount;

    return {
      summary: null,
      messagesCompacted: poppedCount,
      keepFrom: "tail",
      appendNotice: notice,
      // The swept-up old notice (degrade pop) must not ride into the
      // continuation session.
      batonStash: withoutBatonNotice(messages.slice(keepCount), notice),
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
