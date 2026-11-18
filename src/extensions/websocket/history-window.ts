// Lazy history windowing: the pure seam that decides which trailing slice of
// a session log ships first, so opening a session shows the LAST FEW
// messages immediately and older history loads only when the user scrolls
// up. The cold LOG_VIEWED page (handlers-logs.ts), the live attach's FULL
// replay (attach.ts), and the C2S loadOlder pages all align through here --
// one definition of "a page of conversation messages", no drift.
//
// Coordinate space: everything indexes the EPOCH view of a log (the entries
// after the last RESET -- exactly what readSessionEntries returns by
// default). Pre-epoch bytes are invisible to every consumer, and indexes
// stay stable across appends. But a mid-socket RESET (/rewind, /undo, /clear
// dispatched by handleCommand) appends RESET + re-emitted history WITHOUT
// any attach, shifting the epoch -- a window index held across it means a
// DIFFERENT entry. That is what the epochToken guards: the attestation
// frames carry the full-log epochStartIndex, the client echoes it on
// loadOlder, and handleLoadOlder refuses a mismatch (code "epoch_moved")
// instead of serving a page from the wrong epoch -- the client then closes
// the seam until its next attach/navigation re-attests.

import { LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";

/** Trailing window size in CONVERSATION messages (user turns). A module
 *  constant, NOT a config key: "the last few messages" is one number, and
 *  speculative settings are banned. */
export const HISTORY_WINDOW_MESSAGES = 6;

/** Ceiling on a client-requested loadOlder page size. The request frame
 *  carries an untrusted number; a huge page must not flood the socket. */
export const MAX_HISTORY_PAGE_MESSAGES = 25;

/** A user turn opens here. The window NEVER starts before one: TOOL_RESULT,
 *  TOKEN_USAGE, bookkeeping, and assistant-entry baggage riding between
 *  boundaries travels whole with its messages -- a page is always a run of
 *  complete turns, never a user turn cut in half and never a start
 *  mid-tool-run. */
function isTurnBoundary(entry: LogEntry): boolean {
  return entry.source === LOG_SOURCE.INPUT || entry.source === LOG_SOURCE.PROMPT;
}

export interface HistoryPage {
  /** Inclusive start index within `entries` (the epoch view). */
  start: number;
  /** True when entries exist below `start` (an older page can be fetched). */
  hasOlder: boolean;
}

/**
 * The page ending (exclusive) at `upper` that carries the LAST `k` turn
 * boundaries, aligned so `start` IS a boundary entry -- everything from
 * there to `upper` ships, trailing assistant/tool/usage baggage included.
 *
 * When the reachable range holds at most `k` boundaries there is nothing
 * older to page to: the whole range ships (start 0) with hasOlder false --
 * even if leading bookkeeping (system_prompt, session_start) rides along
 * under the first boundary; it renders nothing and paging for it would buy
 * nothing. `upper` is clamped into range; `k` is sanitized to
 * [1, MAX_HISTORY_PAGE_MESSAGES] (loadOlder passes an untrusted size).
 */
export function windowOlderThan(entries: LogEntry[], upper: number, k: number): HistoryPage {
  const limit = Math.max(0, Math.min(Math.trunc(upper) || 0, entries.length));
  const kSafe = Math.max(1, Math.min(Math.trunc(k) || 1, MAX_HISTORY_PAGE_MESSAGES));
  const bounds: number[] = [];
  for (let i = 0; i < limit; i++) {
    if (isTurnBoundary(entries[i]!)) bounds.push(i);
  }
  if (bounds.length <= kSafe) return { start: 0, hasOlder: false };
  // bounds[len - kSafe] is a boundary index strictly above bounds[0], so
  // whenever this fires there IS at least one older user message below.
  const start = bounds[bounds.length - kSafe]!;
  return { start, hasOlder: start > 0 };
}
