// Turn-boundary trimming shared by /undo, /rewind, and /fork.

import type { Message } from "./message.ts";

export interface TrimResult {
  kept: Message[];
  /** Turns actually dropped (0 when the context holds no user turns). */
  droppedTurns: number;
  totalTurns: number;
}

/**
 * Drop the last `turns` turns of a conversation.
 *
 * A turn is one `user` message plus everything after it (assistant replies, tool results, steering) up to the next user message.
 * Cutting only at user boundaries keeps assistant(tool_calls) messages together with their tool results,
 * so the kept context is always wire-valid without a repair pass.
 *
 * Messages before the first user message (system prompt, compaction summary) are never dropped: dropping every turn leaves that prefix standing.
 */
export function trimTurns(messages: Message[], turns: number): TrimResult {
  const totalTurns = messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);

  if (turns <= 0) {
    return { kept: messages.slice(), droppedTurns: 0, totalTurns };
  }

  if (turns >= totalTurns) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    const cut = firstUser === -1 ? messages.length : firstUser;
    return { kept: messages.slice(0, cut), droppedTurns: totalTurns, totalTurns };
  }

  // Walk back to the start of the Nth-from-last turn.
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      seen++;
      if (seen === turns) {
        return { kept: messages.slice(0, i), droppedTurns: turns, totalTurns };
      }
    }
  }

  // Unreachable: the count above guarantees the walk finds `turns` users.
  return { kept: messages.slice(), droppedTurns: 0, totalTurns };
}
