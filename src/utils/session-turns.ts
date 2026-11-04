// Honest timestamp math over session log entries. Shared by the websocket
// replay (server) and the webui's cold-log renderer (client) so both derive
// identical footer values from the same entries. Utils can't import core
// (core imports utils), so the source names below mirror LOG_SOURCE in
// @core/session/session-log.ts as plain strings.

/** Parse a log entry's `ts` into epoch ms; undefined when the entry carries
 *  no trustworthy timestamp (legacy entries, corrupt lines). Never guesses. */
export function parseEntryTs(ts: unknown): number | undefined {
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * For each entry index, the wall-clock ms of the turn bracketing it.
 * A v2 log closes every turn with `turn_started` ... `turn_end`; both
 * bracketing records must carry valid timestamps to yield a duration.
 * Entries outside any bracket, logs without markers (v1), and turns still
 * open at log end (crash) get undefined: an unknown duration is omitted,
 * never invented.
 */
export function turnDurationsByIndex(
  entries: ReadonlyArray<{ source?: string | null; ts?: string | null }>,
): Array<number | undefined> {
  const durations: Array<number | undefined> = new Array(entries.length).fill(undefined);
  let openAt = -1;
  let openMs: number | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.source === "turn_started") {
      // A second marker before an end (crash + resume re-emits it): the
      // later one owns the turn; entries under the unclosed earlier one
      // stay without a duration.
      openAt = i;
      openMs = parseEntryTs(e.ts);
    } else if (e.source === "turn_end") {
      const endMs = parseEntryTs(e.ts);
      if (openAt >= 0 && openMs !== undefined && endMs !== undefined && endMs >= openMs) {
        for (let k = openAt; k <= i; k++) durations[k] = endMs - openMs;
      }
      openAt = -1;
      openMs = undefined;
    }
  }
  return durations;
}

/** Per-message ctx view derived from a token_usage log record: `used` is the
 *  call's totalTokens (the exact number the sidebar gauge shows), `total` is
 *  the model context window the record was written with. cached/prompt/
 *  completion are the per-call breakdown the record carries (prompt is NET of
 *  cache, see TokenTracker). Absent fields are omitted, never zeroed. */
export interface CtxUsage {
  used: number;
  total?: number;
  cached?: number;
  prompt?: number;
  completion?: number;
}

/** The numeric fields a v2 token_usage record carries. */
interface CtxRecordFields {
  totalTokens?: unknown;
  contextWindow?: unknown;
  cachedTokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
}

/** A recorded usage number counts as attested only when finite and > 0;
 *  0/absent means the provider (or a legacy record) said nothing. */
function attested(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A bare breakdown number: 0 is a real value here (e.g. nothing cached), so
 *  only non-numbers/NaN are dropped, unlike the used/total gate above. */
function recorded(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * For each entry index, the ctx usage attested AT that message's commit --
 * the sibling of turnDurationsByIndex for the footer's `used/total` segment.
 * A token_usage record belongs to the LLM response that precedes it (the
 * session-log hook writes it right after the `llm` entry it describes), so
 * each record claims the nearest preceding un-claimed `llm` entry and stamps
 * it. Messages whose response produced no record (provider kept usage
 * private, logs predating usage records) get undefined: the segment is
 * omitted, never borrowed from a neighbouring call. A record without a
 * usable totalTokens claims nothing; a second record for one entry (should
 * not happen: TokenTracker dedupes) is ignored.
 */
export function ctxByIndex(
  entries: ReadonlyArray<{ source?: string | null } & CtxRecordFields>,
): Array<CtxUsage | undefined> {
  const out: Array<CtxUsage | undefined> = new Array(entries.length).fill(undefined);
  let pending = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.source === "llm") {
      pending = i;
    } else if (e.source === "token_usage" && pending >= 0) {
      const used = attested(e.totalTokens);
      if (used === undefined) continue; // attests nothing; the entry stays open
      const total = attested(e.contextWindow);
      const cached = recorded(e.cachedTokens);
      const prompt = recorded(e.promptTokens);
      const completion = recorded(e.completionTokens);
      out[pending] = {
        used,
        ...(total !== undefined ? { total } : {}),
        ...(cached !== undefined ? { cached } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
      };
      pending = -1;
    }
  }
  return out;
}
