// Unit tests for the honest turn/call derivation in @utils/session-turns.ts.
// The doctrine is absolute: an unattested number is OMITTED, never guessed.
// These pin deriveCallDurationsByIndex (the strict-adjacency log-gap fallback
// for logs predating the token_usage durationMs record) and the extended
// ctxByIndex read that carries a recorded durationMs into CtxUsage.callMs.

import { describe, it, expect } from "bun:test";
import {
  ctxByIndex,
  deriveCallDurationsByIndex,
  parseEntryTs,
} from "@utils/session-turns.ts";

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** Minimal entry: source + optional ts (parseEntryTs posture). */
function e(source: string, offsetMs?: number | null, over: Record<string, unknown> = {}) {
  return {
    source,
    ...(offsetMs !== null && offsetMs !== undefined ? { ts: iso(offsetMs) } : {}),
    ...over,
  };
}

/** Derive at a given index (undefined elsewhere asserted by callers). */
function derived(entries: Array<Record<string, unknown>>): Array<number | undefined> {
  return deriveCallDurationsByIndex(entries as never);
}

describe("parseEntryTs", () => {
  it("parses an ISO ts to epoch ms", () => {
    expect(parseEntryTs(iso(1234))).toBe(T0 + 1234);
  });
  it("rejects non-strings and unparseable strings", () => {
    expect(parseEntryTs("not-a-date")).toBeUndefined();
    expect(parseEntryTs(12345)).toBeUndefined();
    expect(parseEntryTs(undefined)).toBeUndefined();
    expect(parseEntryTs(null)).toBeUndefined();
  });
});

describe("deriveCallDurationsByIndex", () => {
  it("derives the exact delta from a trigger-adjacent llm entry", () => {
    // input is what starts an LLM call; the llm entry lands right after it.
    const out = derived([e("input", 0), e("llm", 4200)]);
    expect(out[1]).toBe(4200);
    expect(out[0]).toBeUndefined(); // the trigger itself gets no duration
  });

  it("treats prompt and tool_result as triggers too", () => {
    expect(derived([e("prompt", 0), e("llm", 1000)])[1]).toBe(1000);
    expect(derived([e("tool_result", 0), e("llm", 2500)])[1]).toBe(2500);
  });

  it("tolerates a token_usage sibling between the trigger and the llm entry", () => {
    // The PREVIOUS call's usage record sits between the trigger and this
    // llm entry; it is permitted, so the span still resolves off the trigger.
    const out = derived([
      e("tool_result", 0),
      e("token_usage", 100, { totalTokens: 10 }),
      e("llm", 3000),
    ]);
    expect(out[2]).toBe(3000);
  });

  it("yields undefined when a non-usage entry intervenes (model_change)", () => {
    const out = derived([
      e("input", 0),
      e("model_change", 100),
      e("llm", 3000),
    ]);
    expect(out[2]).toBeUndefined();
  });

  it("yields undefined for a compaction/session record in the gap", () => {
    expect(derived([e("input", 0), e("compaction", 100), e("llm", 3000)])[2]).toBeUndefined();
    expect(derived([e("input", 0), e("session_start", 100), e("llm", 3000)])[2]).toBeUndefined();
  });

  it("a turn marker in the gap makes it ambiguous: undefined", () => {
    // An intervening turn_started/turn_end is a disqualifier, which is what
    // stops a restart from being silently bridged (see the resume pins below).
    expect(derived([e("input", 0), e("turn_started", 100), e("llm", 3000)])[2]).toBeUndefined();
    expect(derived([e("tool_result", 0), e("turn_end", 50), e("llm", 900)])[2]).toBeUndefined();
  });

  it("yields undefined when the llm ts is unparseable", () => {
    const out = derived([e("input", 0), { source: "llm", ts: "nope" }]);
    expect(out[1]).toBeUndefined();
  });

  it("yields undefined when the trigger ts is missing (legacy v1 log)", () => {
    // A v1-era log has no per-entry ts on the trigger: nothing to measure from.
    const out = derived([{ source: "input" }, { source: "llm", ts: iso(5000) }]);
    expect(out[1]).toBeUndefined();
  });

  it("yields undefined when the llm ts precedes the trigger (reversed clock)", () => {
    const out = derived([e("input", 5000), e("llm", 1000)]);
    expect(out[1]).toBeUndefined();
  });

  it("yields undefined when there is no trigger at all", () => {
    const out = derived([e("turn_started", 0), e("llm", 5000)]);
    expect(out[1]).toBeUndefined();
  });

  it("an llm entry ends the trigger window: a second llm borrows no gap", () => {
    // Two llm entries with only the first call's usage record between them --
    // the second call was started by the FIRST response's tool dispatch, not
    // by the original input, so the shared trigger is now ambiguous.
    const out = derived([
      e("input", 0),
      e("llm", 1000),
      e("token_usage", 1100, { totalTokens: 10 }),
      e("llm", 8000),
    ]);
    expect(out[1]).toBe(1000); // first call: input -> llm
    expect(out[3]).toBeUndefined(); // second call has no trigger of its own
  });

  it("recorded wins over derived: a finite durationMs suppresses derivation", () => {
    // The record's own duration (say the log gap is a coarse lie) is the
    // truth; deriveCallDurationsByIndex leaves that entry undefined so the
    // caller reads the recorded value instead.
    const out = derived([
      e("input", 0),
      e("llm", 5000),
      e("token_usage", 5001, { totalTokens: 10, durationMs: 500 }),
    ]);
    expect(out[1]).toBeUndefined();
  });

  it("a non-finite recorded durationMs does not count: derivation proceeds", () => {
    const out = derived([
      e("input", 0),
      e("llm", 5000),
      e("token_usage", 5001, { totalTokens: 10, durationMs: NaN }),
    ]);
    expect(out[1]).toBe(5000);
  });

  // ── crash/resume: the rule must not silently bridge a restart ──────────
  // Investigated: an auto-resume writes a resume_attempt record and a
  // re-emitted turn_started before the continuation's first llm entry
  // (session-log.ts turn_started re-emit; restoreSessionIntoAgent fsyncs the
  // resume_attempt). A bare restart that appended NOTHING between the last
  // pre-crash trigger and the first post-resume llm entry would otherwise
  // look like a clean adjacent gap and invent a duration across the crash.

  it("does not bridge a restart marked by a resume_attempt record", () => {
    const out = derived([
      e("tool_result", 0), // last pre-crash trigger
      e("resume_attempt", 100000), // the restart marker (a disqualifier)
      e("llm", 110000),
    ]);
    expect(out[2]).toBeUndefined();
  });

  it("does not bridge a restart whose only marker is a re-emitted turn_started", () => {
    const out = derived([
      e("tool_result", 0),
      e("turn_started", 90000), // re-emitted on resume, kind continuation
      e("llm", 95000),
    ]);
    expect(out[2]).toBeUndefined();
  });

  it("a resumed turn derives only from a fresh trigger, never a pre-crash one", () => {
    // The honest shape: resume replays then a NEW tool result starts the next
    // call -- that fresh trigger (post-restart) is legitimate.
    const out = derived([
      e("tool_result", 0),
      e("resume_attempt", 90000),
      e("turn_started", 90100),
      e("llm", 95000),
      e("token_usage", 95100, { totalTokens: 10 }),
      e("tool_result", 96000),
      e("llm", 97500),
    ]);
    expect(out[3]).toBeUndefined(); // first post-resume call: bridge refused
    expect(out[6]).toBe(1500); // later call: fresh post-resume trigger
  });
});

describe("ctxByIndex carries a recorded durationMs", () => {
  it("stamps callMs when the record attests a finite durationMs", () => {
    const out = ctxByIndex([
      e("input", 0),
      e("llm", 1000),
      e("token_usage", 1001, { totalTokens: 120, durationMs: 940 }),
    ] as never);
    expect(out[1]).toEqual({ used: 120, callMs: 940 });
  });

  it("callMs 0 counts (recorded posture: 0 is a number, not an absence)", () => {
    const out = ctxByIndex([
      e("llm", 0),
      e("token_usage", 1, { totalTokens: 120, durationMs: 0 }),
    ] as never);
    expect(out[0]).toEqual({ used: 120, callMs: 0 });
  });

  it("no durationMs on the record leaves callMs absent (never derived here)", () => {
    const out = ctxByIndex([e("llm", 0), e("token_usage", 1, { totalTokens: 120 })] as never);
    expect(out[0]).toEqual({ used: 120 });
    expect("callMs" in out[0]!).toBe(false);
  });

  it("a non-finite durationMs is dropped, the rest of the record still lands", () => {
    const out = ctxByIndex([
      e("llm", 0),
      e("token_usage", 1, { totalTokens: 120, contextWindow: 8000, durationMs: "42" }),
    ] as never);
    expect(out[0]).toEqual({ used: 120, total: 8000 });
  });
});
