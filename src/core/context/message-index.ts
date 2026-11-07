// The visible-message index: the #N number on the interactive status row,
// and what /rewind and /fork address when they cut by message number.
//
// A message is VISIBLE when it is user input (role "user") or an assistant
// response (role "assistant" with non-empty text). Excluded: tool results
// (role "tool"), tool-call-only assistant messages (empty text: the wire
// plumbing around a tool chain, which renders as tool traffic, never as a
// response), the system prompt and compaction summaries (role "system"), and
// harness notices (role "harness").
//
// Numbering is a STABLE ordinal per message, assigned when the message first
// enters a context and never reused. A plain conversation numbers 1, 2, 3...;
// cutting the tail (rewind, fork seeding) does not renumber survivors, and
// the next message continues above the lineage's high-water mark. Gaps in the
// numbering therefore sit exactly where history died -- cut by a rewind, or
// swallowed by compaction -- so an old number can never silently address a
// newer message: it errors out of range instead. Numbers restart at 1 only
// when a context is rebuilt (a fresh session, a resumed log, /clear): the
// index always addresses the CURRENT context lineage.
//
// An index addresses a message; the cut it names keeps that message and
// everything before it and drops everything strictly after it (a tool-call
// message keeps its own results with it). resolveMessageCut in rewind.ts is
// the single resolver both commands run through.

import { contentToText, type Message } from "./message.ts";

export interface VisibleEntry {
  /** The message's stable visible number (#N). */
  index: number;
  message: Message;
  /** The message's position in the Message[] passed to visibleIndexSequence(). */
  position: number;
}

/** The index definition, in one predicate: user input or an assistant response. */
export function isVisibleMessage(m: Message): boolean {
  if (m.role === "user") return true;
  return m.role === "assistant" && contentToText(m.content).trim().length > 0;
}

// Message -> ordinal, assigned on first entry into a tracked context.
const ordinals = new WeakMap<Message, number>();
// MessageLog -> highest ordinal ever assigned into that context. Survives
// tail cuts on purpose: rewound numbers stay spent and error as stale.
const highWater = new WeakMap<object, number>();

/** MessageLog seam: number one appended message (no-op for invisible ones). */
export function noteMessageAdded(log: object, msg: Message): void {
  if (!isVisibleMessage(msg)) return;
  const seen = ordinals.get(msg);
  if (seen === undefined) {
    const hw = highWater.get(log) ?? 0;
    ordinals.set(msg, hw + 1);
    highWater.set(log, hw + 1);
  } else if (seen > (highWater.get(log) ?? 0)) {
    // A stamped message arriving from another lineage (a fork copy) pins the
    // high-water mark so later messages continue above it.
    highWater.set(log, seen);
  }
}

/**
 * MessageLog seam: a whole-array replacement (compaction, rewind, replay).
 * Stamped survivors keep their numbers -- that is what makes stale targets
 * error instead of readdressing. A wholly untracked array (a resumed or
 * stitched context of fresh Message objects) rebuilds the lineage: numbered
 * 1..k in array order, high-water reset. Stamped and untracked messages
 * mixed together (practically: baton replay appending popped messages)
 * number the unseen ones above the highest survivor, in order.
 */
export function noteMessageLogReplaced(log: object, messages: Message[]): void {
  let maxSeen = 0;
  let visible = 0;
  for (const m of messages) {
    if (!isVisibleMessage(m)) continue;
    visible++;
    const seen = ordinals.get(m);
    if (seen !== undefined && seen > maxSeen) maxSeen = seen;
  }
  if (visible > 0 && maxSeen === 0) {
    let hw = 0;
    for (const m of messages) {
      if (isVisibleMessage(m)) ordinals.set(m, ++hw);
    }
    highWater.set(log, hw);
    return;
  }
  let hw = Math.max(highWater.get(log) ?? 0, maxSeen);
  for (const m of messages) {
    if (!isVisibleMessage(m) || ordinals.has(m)) continue;
    ordinals.set(m, ++hw);
  }
  highWater.set(log, hw);
}

/** MessageLog seam: /clear starts a fresh lineage (next message is #1). */
export function noteMessageLogCleared(log: object): void {
  highWater.set(log, 0);
}

/**
 * The visible-message sequence of a context -- THE function computing the
 * index (status row, /rewind, /fork all read numbering from here). Returns
 * the visible messages in context order with their numbers. An array no
 * MessageLog ever tracked (hand-built, e.g. tests) falls back to positional
 * numbering 1..n: same in-range behavior, no stale-gap detection to offer.
 */
export function visibleIndexSequence(messages: Message[]): VisibleEntry[] {
  const tracked = messages.some((m) => isVisibleMessage(m) && ordinals.has(m));
  const out: VisibleEntry[] = [];
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!isVisibleMessage(m)) continue;
    n++;
    out.push({ index: tracked ? ordinals.get(m) ?? n : n, message: m, position: i });
  }
  return out;
}

/** The newest visible message's number (#N), or null when nothing is visible. */
export function latestVisibleIndex(messages: Message[]): number | null {
  const seq = visibleIndexSequence(messages);
  return seq.length > 0 ? seq[seq.length - 1]!.index : null;
}
