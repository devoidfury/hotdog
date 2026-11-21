// Lazy history windowing: the pure seam that decides which trailing slice of
// a session log ships first, so opening a session shows the LAST FIVE
// MESSAGES immediately and older history loads only when the user scrolls
// up. The cold LOG_VIEWED page (handlers-logs.ts), the live attach's FULL
// replay (attach.ts), and the C2S loadOlder pages all align through here --
// one definition of "a page of conversation messages", no drift.
//
// The unit is a MESSAGE: one user input/prompt entry, or one model response
// (llm) entry -- a response counts as exactly one message whether it
// stopped, called tools, or continued. These are the same countable entries
// the sidebar's messageCount sums (isCountedLogEntry), so the page count
// matches what the list promised. Everything else -- tool_result,
// system_prompt, compaction, token_usage, tool_started, question_asked, the
// other bookkeeping -- is NON-message baggage riding inside whatever page
// its index falls in; it never counts toward k. Pages are NOT aligned to
// user turns: a window may start at an llm entry mid-turn.
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

import { isCountedLogEntry, type LogEntry } from "@core/session/session-log.ts";

/** Trailing window size in conversation messages (a user input/prompt entry
 *  or a model response entry each count 1; see the module header). A module
 *  constant, NOT a config key: "the last five messages" is one number, and
 *  speculative settings are banned. */
export const HISTORY_WINDOW_MESSAGES = 5;

/** Ceiling on a client-requested loadOlder page size. The request frame
 *  carries an untrusted number; a huge page must not flood the socket. */
export const MAX_HISTORY_PAGE_MESSAGES = 25;

export interface HistoryPage {
  /** Inclusive start index within `entries` (the epoch view). */
  start: number;
  /** True when a countable message exists below `start` (an older page can
   *  be fetched). */
  hasOlder: boolean;
}

/**
 * The page ending (exclusive) at `upper` that carries the LAST `k`
 * messages: `start` is the index of the k-th-from-last countable message
 * (input | prompt | llm), and everything from there to `upper` ships whole,
 * baggage included. A continuing page therefore always LEADS at a countable
 * message; it may END right after an llm entry whose tool_results live in
 * the newer page the client already holds (well-formed logs keep a
 * response's results adjacent to it, so pairing resolves inside the page;
 * the renderer tolerates a cut anyway -- orphan results drop through the
 * existing no-matching-call idiom, unanswered calls keep the pending one).
 *
 * When the reachable range holds at most `k` countable messages there is
 * nothing countable older to page for: the whole range ships (start 0) with
 * hasOlder false -- leading bookkeeping (system_prompt, session_start)
 * before the first message simply rides; it renders nothing and paging for
 * it would buy nothing. `upper` is clamped into range; `k` is sanitized to
 * [1, MAX_HISTORY_PAGE_MESSAGES] (loadOlder passes an untrusted size).
 */
export function windowOlderThan(entries: LogEntry[], upper: number, k: number): HistoryPage {
  const limit = Math.max(0, Math.min(Math.trunc(upper) || 0, entries.length));
  const kSafe = Math.max(1, Math.min(Math.trunc(k) || 1, MAX_HISTORY_PAGE_MESSAGES));
  const messages: number[] = [];
  for (let i = 0; i < limit; i++) {
    if (isCountedLogEntry(entries[i]!)) messages.push(i);
  }
  if (messages.length <= kSafe) return { start: 0, hasOlder: false };
  // messages[len - kSafe] is strictly above messages[0], so whenever this
  // fires at least one countable message exists below start: hasOlder true.
  const start = messages[messages.length - kSafe]!;
  return { start, hasOlder: start > 0 };
}
