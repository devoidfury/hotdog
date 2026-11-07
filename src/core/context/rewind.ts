// Cut resolution for the trim commands: turn-boundary trimming (trimTurns,
// the /undo path only) and the message-index resolver (resolveMessageCut,
// the /rewind and /fork path).

import type { Message } from "./message.ts";
import { isVisibleMessage, visibleIndexSequence } from "./message-index.ts";

export interface TrimResult {
  kept: Message[];
  /** Turns actually dropped (0 when the context holds no user turns). */
  droppedTurns: number;
  totalTurns: number;
}

/**
 * Drop the last `turns` turns of a conversation. This is /undo's trim;
 * /rewind and /fork cut by the visible-message index (resolveMessageCut).
 *
 * A turn is one `user` message plus everything after it (assistant replies, tool results, steering) up to the next user message.
 * Cutting only at user boundaries keeps assistant(tool_calls) messages together with their tool results,
 * so the kept context is always wire-valid without a repair pass.
 *
 * STRAY-FREE CUT (owner ruling): the kept context ends at the last VISIBLE message it retains and that message's answered tool-call block. Harness notices, system reminders, loop-detect nudges, orphan tool results and any other traffic trailing that boundary -- whatever their role -- are swept out with the dropped turns; the sweep is positional over the whole array, not a user/assistant filter. Only when the trim retains no visible message at all does the pre-conversation prefix (system prompt, compaction summary) stand.
 */
export function trimTurns(messages: Message[], turns: number): TrimResult {
  const totalTurns = messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);

  if (turns <= 0) {
    return { kept: messages.slice(), droppedTurns: 0, totalTurns };
  }

  if (turns >= totalTurns) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    const cut = firstUser === -1 ? messages.length : firstUser;
    return { kept: trimToLastVisible(messages.slice(0, cut)), droppedTurns: totalTurns, totalTurns };
  }

  // Walk back to the start of the Nth-from-last turn.
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      seen++;
      if (seen === turns) {
        return { kept: trimToLastVisible(messages.slice(0, i)), droppedTurns: turns, totalTurns };
      }
    }
  }

  // Unreachable: the count above guarantees the walk finds `turns` users.
  return { kept: messages.slice(), droppedTurns: 0, totalTurns };
}

/**
 * The exclusive end of the message at `at`'s answered tool-result block: the
 * results for its calls follow it contiguously and ride with it, so a cut at
 * this boundary never splits a call from a result. `unanswered` counts the
 * calls whose result never arrived.
 */
function answeredBlock(messages: Message[], at: number): { end: number; unanswered: number } {
  const calls = messages[at]!.toolCalls;
  if (!calls || calls.length === 0) return { end: at + 1, unanswered: 0 };
  const pending = new Set(calls.map((tc) => tc.id));
  let end = at + 1;
  while (end < messages.length) {
    const next = messages[end]!;
    const answeredId = next.role === "tool" ? next.toolCallId : null;
    if (!answeredId || !pending.has(answeredId)) break;
    pending.delete(answeredId);
    end++;
  }
  return { end, unanswered: pending.size };
}

/**
 * Back an array up to the end of the LAST visible message's answered
 * tool-call block -- the stray-free-cut invariant: nothing (tool call, tool
 * result, harness notice, system reminder, any role) dangles past the kept
 * boundary. An array holding no visible message (the bare system prefix) is
 * returned untouched; a clean array is returned without re-slicing.
 */
function trimToLastVisible(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isVisibleMessage(messages[i]!)) continue;
    const { end } = answeredBlock(messages, i);
    return end === messages.length ? messages : messages.slice(0, end);
  }
  return messages;
}

// ── Message-index cuts ───────────────────────────────────────────────────────
// The visible-message index (context/message-index.ts) numbers user input and
// assistant responses #1, #2, ... The cut grammar addresses one of those
// numbers: bare N = the absolute index, -N = relative back. CUT CONVENTION,
// identical for /rewind and /fork: the cut KEEPS the addressed message (and
// everything before it) and drops everything strictly after it regardless of
// role; an addressed assistant message that made tool calls keeps its
// immediately-following answered results with it. So the kept context always
// ends exactly at a real, wire-valid boundary and nothing -- no tool call, no
// tool result, no harness/system entry parked between visible messages --
// dangles past the cut (owner ruling: zero stray entries trailing the cut
// boundary). The slice below is positional over the whole context array, so
// this holds by construction, not by role filtering.

/** Absolute: address visible message #index (keep through it). */
export interface CutToIndex {
  kind: "index";
  index: number;
}
/** Relative: drop the last `messages` visible messages (keep the one before). */
export interface CutBack {
  kind: "back";
  messages: number;
}
export type MessageCut = CutToIndex | CutBack;

/** A fork branch's cut: the head as-is, or a message-index cut. */
export type ForkCut = { kind: "head" } | MessageCut;

/** An honest out-of-range / unaddressable cut target. Never a nearby silent cut. */
export class MessageCutError extends Error {}

export interface MessageCutResult {
  /** The kept context: everything through the addressed message's boundary. */
  kept: Message[];
  /** Visible number (#N) of the last kept message; null when every visible message was dropped. */
  after: number | null;
  /** How many visible messages the cut dropped. */
  droppedVisible: number;
}

/**
 * Resolve a message-index cut against a context Message[] -- the ONE resolver
 * /rewind and /fork share, so the same number cuts the same boundary in both.
 * A target outside the visible lineage (0, past the newest, swallowed by
 * compaction, stale from before a rewind) throws MessageCutError naming the
 * valid range.
 */
export function resolveMessageCut(messages: Message[], spec: MessageCut): MessageCutResult {
  const seq = visibleIndexSequence(messages);
  if (seq.length === 0) {
    throw new MessageCutError("Nothing to cut: the context holds no visible messages yet.");
  }
  const lo = seq[0]!.index;
  const hi = seq[seq.length - 1]!.index;
  const range = `the current lineage has ${seq.length} visible message${seq.length === 1 ? "" : "s"}: #${lo}-#${hi}`;

  // Position in `seq` of the addressed entry; -1 = cut before the first
  // visible message (only the pre-conversation prefix survives).
  let pos: number;
  if (spec.kind === "back") {
    if (!Number.isInteger(spec.messages) || spec.messages < 1) {
      throw new MessageCutError(`How many messages to go back must be at least 1 (${range}).`);
    }
    if (spec.messages > seq.length) {
      throw new MessageCutError(
        `Cannot go back ${spec.messages} messages: ${range}. Deepest message cut is -${seq.length}.`,
      );
    }
    pos = seq.length - 1 - spec.messages;
  } else {
    if (!Number.isInteger(spec.index) || spec.index < 1) {
      throw new MessageCutError(`Index must be at least 1 (${range}).`);
    }
    pos = seq.findIndex((e) => e.index === spec.index);
    if (pos === -1) {
      throw new MessageCutError(
        spec.index > hi
          ? `Index #${spec.index} is past the newest visible message (#${hi}); ${range}.`
          : `Index #${spec.index} is no longer in this lineage (lower entries were cut or compacted away); ${range}.`,
      );
    }
  }

  if (pos < 0) {
    return { kept: messages.slice(0, seq[0]!.position), after: null, droppedVisible: seq.length };
  }
  const entry = seq[pos]!;
  const { end, unanswered } = answeredBlock(messages, entry.position);
  if (unanswered > 0) {
    throw new MessageCutError(
      `Message #${entry.index} has an unanswered tool call, so it cannot be a cut point. Address an earlier message (a smaller N, or a deeper -N) instead.`,
    );
  }
  return { kept: messages.slice(0, end), after: entry.index, droppedVisible: seq.length - pos - 1 };
}
