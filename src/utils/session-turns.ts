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
 *  cache, see TokenTracker). `callMs` is the producing call's own wall time
 *  when the record carries it (durationMs, recorded posture). Absent fields
 *  are omitted, never zeroed. */
export interface CtxUsage {
  used: number;
  total?: number;
  cached?: number;
  prompt?: number;
  completion?: number;
  callMs?: number;
}

/** The numeric fields a v2 token_usage record carries. */
interface CtxRecordFields {
  totalTokens?: unknown;
  contextWindow?: unknown;
  cachedTokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  durationMs?: unknown;
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
      const callMs = recorded(e.durationMs);
      out[pending] = {
        used,
        ...(total !== undefined ? { total } : {}),
        ...(cached !== undefined ? { cached } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
        ...(callMs !== undefined ? { callMs } : {}),
      };
      pending = -1;
    }
  }
  return out;
}

/** Sources that START an LLM call: user/prompt input landing, or a tool
 *  result handing the loop back to the model. Mirrors LOG_SOURCE in
 *  @core/session/session-log.ts (utils cannot import core). */
const CALL_TRIGGER_SOURCES: ReadonlySet<string> = new Set(["input", "prompt", "tool_result"]);

/**
 * Derived per-call wall time for logs that predate the token_usage
 * durationMs record. For each `llm` entry with NO recorded duration (the
 * token_usage record paired with it carries no finite durationMs -- that
 * number always wins), the call span is `llm.ts - trigger.ts` where the
 * trigger is the nearest preceding entry with source input|prompt|
 * tool_result -- the appends that start an LLM call.
 *
 * STRICT adjacency: between the trigger and the llm entry the only other
 * entries permitted are `token_usage` records (the PREVIOUS call's sibling,
 * written right after its llm entry). Any other intervening entry -- turn
 * markers, model_change, compaction/session records, notifications, even
 * another llm entry -- makes the span ambiguous and yields undefined; an
 * unattested duration is omitted, never guessed. Both ts must parse and
 * llm.ts >= trigger.ts.
 *
 * Crash/resume: a restart cannot silently bridge. Every resume path fires
 * SESSION_RESUME_ATTEMPT, which fsyncs a `resume_attempt` record before the
 * replay reads (restoreSessionIntoAgent), and the continuation run's first
 * iteration fsyncs `turn_started` BEFORE its first LLM call (session-log
 * TURN_START handler; docs/hook-lifecycle.md). Neither source is on the
 * permitted-intervening list, so the first post-resume `llm` entry always
 * sees a disqualifying record between it and any pre-crash trigger. The
 * index rebuild paths (syncSessionFromLog, reconcile) write only the index
 * mirror, never the log. v1-era logs get no auto-resume continuation at all
 * (openTurn is v2-only) and manual resume arrives as a fresh input entry --
 * a new trigger, not a bridge. The rule therefore needs no extra restart
 * carve-out; pinned by fixture test rather than inferred.
 */
export function deriveCallDurationsByIndex(
  entries: ReadonlyArray<{ source?: string | null; ts?: string | null; durationMs?: unknown }>,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(entries.length).fill(undefined);

  // Pass 1: recorded durations beat derivation. Same pairing as ctxByIndex
  // (a token_usage record belongs to the nearest preceding un-claimed llm
  // entry, and a record attesting nothing leaves that entry open), but
  // judged on durationMs alone -- the used/totalTokens gate there is about
  // the gauge, not about this number's existence.
  const recordedCall: Array<number | undefined> = new Array(entries.length).fill(undefined);
  let pending = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.source === "llm") {
      pending = i;
    } else if (e.source === "token_usage" && pending >= 0) {
      if (typeof e.durationMs === "number" && Number.isFinite(e.durationMs)) {
        recordedCall[pending] = e.durationMs;
        pending = -1;
      }
    }
  }

  // Pass 2: forward walk holding the nearest live trigger.
  let triggerAt = -1;
  for (let i = 0; i < entries.length; i++) {
    const src = entries[i]!.source;
    if (typeof src === "string" && CALL_TRIGGER_SOURCES.has(src)) {
      triggerAt = i;
      continue;
    }
    if (src === "llm") {
      if (recordedCall[i] === undefined && triggerAt >= 0) {
        const triggerMs = parseEntryTs(entries[triggerAt]!.ts);
        const llmMs = parseEntryTs(entries[i]!.ts);
        if (triggerMs !== undefined && llmMs !== undefined && llmMs >= triggerMs) {
          out[i] = llmMs - triggerMs;
        }
      }
      // An llm entry ends the trigger's window: the NEXT call needs its own
      // trigger (a tool result or new input), never a second reading of the
      // append that started this one.
      triggerAt = -1;
      continue;
    }
    if (src === "token_usage") continue; // tolerated sibling of the previous call
    triggerAt = -1; // any other record makes a later span ambiguous
  }
  return out;
}
