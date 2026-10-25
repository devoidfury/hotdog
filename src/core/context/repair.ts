import { Message, type ToolCall } from "./message.ts";

/**
 * Synthesized tool-result content for interrupted calls. Pinned verbatim: the
 * point is that the model KNOWS the call may have partially executed --
 * wording matters for non-idempotent commands.
 */
export const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted]";

/**
 * Resume protocol: a `tool_started` with no result -- execution began, fate
 * unknown. The verify-before-retry wording is the point: never assume
 * success, never blind-retry a side effect.
 */
export const INTERRUPTED_OUTCOME_UNKNOWN =
  "[Tool execution was interrupted before its result was recorded. Side effects may have landed: verify the current state before retrying this call.]";

/**
 * Resume protocol: no `tool_started` in a log that uses the records -- the
 * call never dispatched, safe to retry. Only applied when the log carries
 * started records at all (absence proves nothing otherwise); pre-protocol
 * logs keep INTERRUPTED_TOOL_RESULT.
 */
export const INTERRUPTED_NOT_STARTED =
  "[Tool execution was interrupted before the call started; it never ran. Safe to retry.]";

export interface ToolCallRepair {
  /** New message array; the input is never mutated. */
  messages: Message[];
  /** Call ids that were given a synthesized result. */
  repaired: string[];
  /** Orphan/duplicate results that were dropped (call id, or "(missing id)"). */
  dropped: string[];
  /** Call ids deliberately left unanswered (holdUnresolved); they stay pending. */
  held: string[];
}

export interface ToolCallRepairOptions {
  /** Call ids left unanswered: a replayed pending question. The caller
   *  re-presents it and the real answer lands as these ids' tool result. */
  holdUnresolved?: Set<string>;
  /**
   * Per-call synthesis text (resume classifies started vs never-started).
   * Returning undefined falls back to INTERRUPTED_TOOL_RESULT.
   */
  synthesisFor?: (toolCall: ToolCall) => string | undefined;
}

/**
 * Enforce the wire invariant: every assistant tool_call gets exactly one
 * tool result before the next assistant message (end-of-list counts).
 *
 * Two ways a log/context breaks it:
 *  - interrupt or crash leaves calls with no result (guaranteed 400 on
 *    strict OpenAI-compatible backends, llama.cpp enforces it too)
 *  - a tool result whose call vanished (orphan) is itself a 400
 *
 * Missing results are synthesized as harness-origin tool messages
 * (exempt from marker mangling; a real tool never emits this string).
 * Orphan and duplicate results are dropped. Everything else passes through
 * in order. Pure: healthy inputs come back untouched (same instances).
 */
export function repairToolCalls(
  messages: Message[],
  opts?: ToolCallRepairOptions,
): ToolCallRepair {
  const out: Message[] = [];
  const repaired: string[] = [];
  const dropped: string[] = [];
  const held: string[] = [];

  let i = 0;
  while (i < messages.length) {
    let msg = messages[i]!;
    // Structurally unmatchable tool_calls can never be given a legal result;
    // strip them before the block walk (see sanitizeToolCalls).
    if (msg.role === "assistant") msg = sanitizeToolCalls(msg);
    const calls =
      msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
        ? msg.toolCalls
        : null;

    if (!calls) {
      if (msg.role === "tool") {
        // A tool result with no immediately preceding assistant-with-calls:
        // its call vanished (or never existed). It can match nothing.
        dropped.push(toolResultLabel(msg.toolCallId));
      } else {
        out.push(msg);
      }
      i++;
      continue;
    }

    out.push(msg);

    const expected = new Set<string>();
    for (const tc of calls) {
      if (tc && typeof tc.id === "string" && tc.id !== "") expected.add(tc.id);
    }

    // Scan the block: messages up to the next assistant message.
    const matched = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role !== "assistant") {
      const m = messages[j]!;
      if (m.role !== "tool") {
        // Non-tool messages inside the block are not part of this invariant;
        // keep them in place.
        out.push(m);
      } else if (
        typeof m.toolCallId === "string" &&
        m.toolCallId !== "" &&
        expected.has(m.toolCallId) &&
        !matched.has(m.toolCallId)
      ) {
        matched.add(m.toolCallId);
        out.push(m);
      } else {
        // Orphan (id matches no call of this assistant) or duplicate (a
        // result for an already-satisfied call). Exactly one result per id.
        dropped.push(toolResultLabel(m.toolCallId));
      }
      j++;
    }

    // Synthesize the missing results, appended at the end of the block so
    // real results keep their chronological position.
    const synthesized = new Set<string>();
    for (const tc of calls) {
      const id = tc?.id;
      if (typeof id !== "string" || id === "" || matched.has(id) || synthesized.has(id)) continue;
      synthesized.add(id);
      if (opts?.holdUnresolved?.has(id)) {
        held.push(id);
        continue;
      }
      out.push(
        new Message({
          role: "tool",
          content: opts?.synthesisFor?.(tc) ?? INTERRUPTED_TOOL_RESULT,
          toolCallId: id,
          source: "harness",
        }),
      );
      repaired.push(id);
    }

    i = j;
  }

  return { messages: out, repaired, dropped, held };
}

function toolResultLabel(toolCallId: string | null): string {
  return toolCallId && toolCallId !== "" ? toolCallId : "(missing id)";
}

/**
 * Strip tool_call entries that can never appear on a legal wire request:
 * non-object entries, missing/empty/non-string ids, a missing function object,
 * and repeat ids within one message (first occurrence wins). Rationale:
 *  - an entry without a usable id is unanswerable -- serialize.ts only emits
 *    `tool_call_id` when truthy, so no legal tool result can reference it, and
 *    it stays a dangling tool_use the provider 400s on;
 *  - two tool_use entries sharing one id cannot both be answered: the repair
 *    invariant is exactly-one-result-per-id, so the repeat entry is stripped.
 * Cloned (the input message is never mutated) only when something is removed;
 * healthy messages pass through as the same instance.
 */
function sanitizeToolCalls(msg: Message): Message {
  const tcs = msg.toolCalls;
  if (!Array.isArray(tcs) || tcs.length === 0) return msg;
  const seen = new Set<string>();
  const kept: ToolCall[] = [];
  for (const tc of tcs) {
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
    const id = tc.id;
    const fn = tc.function;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
    seen.add(id);
    kept.push(tc);
  }
  if (kept.length === tcs.length) return msg;
  return new Message({
    role: msg.role,
    content: msg.content,
    reasoningContent: msg.reasoningContent,
    toolCalls: kept.length > 0 ? kept : null,
    toolCallId: msg.toolCallId,
    images: msg.images,
    source: msg.source,
  });
}
