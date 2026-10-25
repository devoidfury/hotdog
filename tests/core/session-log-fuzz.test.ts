// Fuzz suite for session-log replay (crash resilience + durability truth on torn files).
//
// The hard part is NOT "doesn't throw": expectations at every byte cut are derived
// from a parallel META table of record INTENTS (which record is the started/result/
// asked/llm/reset for which call id), sliced by the byte cut -- never from what the
// scan code happens to return.
//
// Pinned scanner tolerance (parseJsonLines splits on "\n", trims, keeps lines that
// parse as JSON; isLogEntry then keeps only plain objects). A record's serialized
// text is exactly the byte range [start_i, end_i), so truncation at byte k keeps:
//   - record i IFF k >= end_i. JSON object texts are prefix-free: no strict byte
//     prefix of `{...}` parses, so a cut can neither fabricate a shorter valid
//     record nor partially keep one (mid-UTF8 -> U+FFFD -> dropped, same rule).
//   - a cut right after `}` with NO newline yet: the reader also scans the
//     unterminated tail, so the record IS kept.
//   - a cut between CR and LF of a CRLF record: trim removes the CR, kept.
//   - records before the torn tail are never dropped and never reordered: expected
//     entries at k are EXACTLY fixture records 0..m, m = #{i : end_i <= k}.
//
// Durability truth asserted per prefix (full view; window-scoped for the epoch):
//   started(c)  <=> an intact tool_started(c) record
//   answered(c) <=> an intact tool_result(c) record
//   asked(c)    <=> an intact question_asked(c) record (log order, deduped)
//   pending(c)  <=> asked(c) && !answered(c), held open on replay (no synthesized
//                   result) at every offset
//   synthesis for an llm call with no intact result: OUTCOME_UNKNOWN while its own
//   started record is intact, NOT_STARTED once any started record exists in the
//   window, generic INTERRUPTED only before any started record exists. An
//   unfinished call is NEVER presented as completed, started-but-unfinished stays
//   distinct from never-started, and full-view membership only flips false->true.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readSessionEntries,
  collectDurabilityFacts,
  replayEntriesIntoContext,
  restoreSessionIntoAgent,
  LOG_SOURCE,
  type DurabilityFacts,
  type LogEntry,
} from "@core/session/session-log.ts";
import {
  INTERRUPTED_TOOL_RESULT,
  INTERRUPTED_OUTCOME_UNKNOWN,
  INTERRUPTED_NOT_STARTED,
} from "@core/context/repair.ts";
import { CliError } from "@core/error.ts";
import type { Message } from "@core/context/message.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── Fixture ─────────────────────────────────────────────────────────

const SESSION_ID = "fz-sweep";
const TS = "2026-10-24T12:00:00.000Z"; // fixed: no Date.now in test logic

type Kind =
  | "session_start" | "turn_started" | "turn_end" | "input" | "llm" | "started"
  | "result" | "asked" | "reset" | "resume";

interface Meta {
  kind: Kind;
  callId?: string;
  progress?: boolean; // counts as livelock-cap progress per the protocol docs
  auto?: boolean; // resume_attempt with origin "auto"
}

function entry(over: Partial<LogEntry> & Pick<LogEntry, "source">): LogEntry {
  return { ts: TS, session_id: SESSION_ID, content: "", ...over };
}

function calls(...ids: string[]): NonNullable<LogEntry["tool_calls"]> {
  return ids.map((id) => ({ id, type: "function", function: { name: "bash", arguments: "{}" } }));
}

const FIXTURE: Array<{ entry: LogEntry; meta: Meta }> = [
  { entry: entry({ source: LOG_SOURCE.SESSION_START, v: 2, content: {}, model: "alpha", profile: "gena" }), meta: { kind: "session_start" } },
  // record 1 is CRLF-terminated so a cut can land between CR and LF
  { entry: entry({ source: LOG_SOURCE.TURN_STARTED, v: 2, content: {} }), meta: { kind: "turn_started" } },
  // 2-byte (e-acute via escape), 4-byte emoji, \n, \" and \\ escapes all live here:
  { entry: entry({ source: LOG_SOURCE.INPUT, content: "pre-epoch msg \u00e9 \u{1F30D} line1\nline2 \"quoted\" \\ tail", origin: "user" }), meta: { kind: "input", progress: true } },
  { entry: entry({ source: LOG_SOURCE.LLM, content: "", tool_calls: calls("call_x"), origin: "model" }), meta: { kind: "llm", progress: true } },
  { entry: entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "call_x", tool_name: "bash", content: '{"command":"echo x"}' }), meta: { kind: "started", callId: "call_x" } },
  { entry: entry({ source: LOG_SOURCE.TOOL_RESULT, tool_call_id: "call_x", content: "x-out", origin: "tool" }), meta: { kind: "result", callId: "call_x", progress: true } },
  // epoch/handoff boundary: everything after this is the replayable epoch
  { entry: entry({ source: LOG_SOURCE.RESET, content: "[reset] epoch boundary" }), meta: { kind: "reset" } },
  { entry: entry({ source: LOG_SOURCE.TURN_STARTED, v: 2, content: {} }), meta: { kind: "turn_started" } },
  { entry: entry({ source: LOG_SOURCE.INPUT, content: "second \u{1F30D} epoch", origin: "user" }), meta: { kind: "input", progress: true } },
  { entry: entry({ source: LOG_SOURCE.LLM, content: "", tool_calls: calls("call_b"), origin: "model" }), meta: { kind: "llm", progress: true } },
  { entry: entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "call_b", tool_name: "read", content: '{"path":"a.txt"}' }), meta: { kind: "started", callId: "call_b" } },
  { entry: entry({ source: LOG_SOURCE.TOOL_RESULT, tool_call_id: "call_b", content: "b-out", origin: "tool" }), meta: { kind: "result", callId: "call_b", progress: true } },
  { entry: entry({ source: LOG_SOURCE.LLM, content: "", tool_calls: calls("call_q"), origin: "model" }), meta: { kind: "llm", progress: true } },
  { entry: entry({ source: LOG_SOURCE.QUESTION_ASKED, tool_call_id: "call_q", tool_name: "question", content: [{ question: "which \u{1F30D} color?", options: ["red", "blue"] }] }), meta: { kind: "asked", callId: "call_q" } },
  { entry: entry({ source: LOG_SOURCE.LLM, content: "", tool_calls: calls("call_d"), origin: "model" }), meta: { kind: "llm", progress: true } },
  { entry: entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "call_d", tool_name: "bash", content: '{"command":"echo d"}' }), meta: { kind: "started", callId: "call_d" } },
  { entry: entry({ source: LOG_SOURCE.LLM, content: "", tool_calls: calls("call_e"), origin: "model" }), meta: { kind: "llm", progress: true } },
  { entry: entry({ source: LOG_SOURCE.RESUME_ATTEMPT, content: { origin: "auto" } }), meta: { kind: "resume", auto: true } },
];

const RECORDS: LogEntry[] = FIXTURE.map((f) => f.entry);

// Where each call's records live, as FIXTURE indices (the independent intent map).
const CALLS: Record<string, { llm: number; started?: number; result?: number; asked?: number }> = {
  call_x: { llm: 3, started: 4, result: 5 },
  call_b: { llm: 9, started: 10, result: 11 },
  call_q: { llm: 12, asked: 13 },
  call_d: { llm: 14, started: 15 },
  call_e: { llm: 16 },
};
const RESULT_CONTENT: Record<string, string> = { call_x: "x-out", call_b: "b-out" };

function buildLog(crlfAll: boolean, trailingNewline: boolean): { buf: Buffer; ranges: Array<[number, number]> } {
  let acc = "";
  const ranges: Array<[number, number]> = [];
  FIXTURE.forEach((f, i) => {
    const line = JSON.stringify(f.entry);
    const start = Buffer.byteLength(acc, "utf-8");
    ranges.push([start, start + Buffer.byteLength(line, "utf-8")]);
    acc += line + (crlfAll || i === 1 ? "\r\n" : "\n");
  });
  if (!trailingNewline) acc = acc.slice(0, -1);
  return { buf: Buffer.from(acc, "utf-8"), ranges };
}

// ── Independent oracles (from META, not from the scanner) ───────────

function expectedFacts(lo: number, hi: number) {
  const started = new Set<string>();
  const answered = new Set<string>();
  const asked: Array<{ toolCallId: string; questions: unknown }> = [];
  let resumeAttempts = 0;
  let consecutiveAutoResumes = 0;
  let openTurn = false;
  for (let i = lo; i < hi; i++) {
    const meta = FIXTURE[i]!.meta;
    switch (meta.kind) {
      case "turn_started": openTurn = true; break;
      case "turn_end": openTurn = false; break;
      case "started": started.add(meta.callId!); break;
      case "result": answered.add(meta.callId!); break;
      case "asked":
        if (!asked.some((p) => p.toolCallId === meta.callId)) {
          asked.push({ toolCallId: meta.callId!, questions: FIXTURE[i]!.entry.content });
        }
        break;
      case "resume":
        resumeAttempts++;
        if (meta.auto) consecutiveAutoResumes++;
        break;
    }
    if (meta.progress) consecutiveAutoResumes = 0;
  }
  return { started, answered, asked, resumeAttempts, consecutiveAutoResumes, openTurn };
}

type ExpectedFacts = ReturnType<typeof expectedFacts>;

function factsDiff(f: DurabilityFacts, e: ExpectedFacts): string {
  const d: string[] = [];
  const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  if (!setEq(f.started, e.started)) d.push(`started ${JSON.stringify([...f.started])} != ${JSON.stringify([...e.started])}`);
  if (!setEq(f.answered, e.answered)) d.push(`answered ${JSON.stringify([...f.answered])} != ${JSON.stringify([...e.answered])}`);
  if (JSON.stringify(f.asked) !== JSON.stringify(e.asked)) d.push(`asked ${JSON.stringify(f.asked)} != ${JSON.stringify(e.asked)}`);
  if (f.resumeAttempts !== e.resumeAttempts) d.push(`resumeAttempts ${f.resumeAttempts} != ${e.resumeAttempts}`);
  if (f.consecutiveAutoResumes !== e.consecutiveAutoResumes) d.push(`consecutive ${f.consecutiveAutoResumes} != ${e.consecutiveAutoResumes}`);
  if (f.openTurn !== e.openTurn) d.push(`openTurn ${f.openTurn} != ${e.openTurn}`);
  return d.join("; ");
}

/** Everything replay/restore must report for the epoch window [lo, m). */
function expectedWindow(lo: number, m: number) {
  const inW = (i: number | undefined): boolean => i !== undefined && i >= lo && i < m;
  const facts = expectedFacts(lo, m);
  const pending = facts.asked.filter((p) => !facts.answered.has(p.toolCallId));

  let profile: string | null = null;
  for (let i = lo; i < m; i++) {
    const kind = FIXTURE[i]!.meta.kind;
    if (kind === "session_start") {
      const p = FIXTURE[i]!.entry["profile"];
      if (typeof p === "string") profile = p;
    }
  }

  let msgCount = 0;
  for (let i = lo; i < m; i++) {
    const kind = FIXTURE[i]!.meta.kind;
    // bookkeeping kinds (started/asked/resume/reset/turn/session_start) never replay
    // as messages; a result only counts if its own llm call is in the window too
    // (repair drops orphan results) -- impossible here by construction but pinned.
    if (kind === "input" || kind === "llm") msgCount++;
    if (kind === "result" && inW(CALLS[FIXTURE[i]!.meta.callId!]?.llm)) msgCount++;
  }

  const durabilityActive = facts.started.size > 0;
  const perCall: Record<string, { count: number; content?: string }> = {};
  for (const [id, loc] of Object.entries(CALLS)) {
    if (!inW(loc.llm)) { perCall[id] = { count: 0 }; continue; }
    if (inW(loc.result)) { perCall[id] = { count: 1, content: RESULT_CONTENT[id]! }; continue; }
    if (inW(loc.asked)) { perCall[id] = { count: 0 }; continue; } // held open
    msgCount++; // synthesized missing result
    perCall[id] = {
      count: 1,
      content: inW(loc.started)
        ? INTERRUPTED_OUTCOME_UNKNOWN
        : durabilityActive
          ? INTERRUPTED_NOT_STARTED
          : INTERRUPTED_TOOL_RESULT,
    };
  }
  return { facts, pending, profile, msgCount, perCall };
}

// ── Harness plumbing ────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "hotdog-sessionlog-fuzz-"));
const ORIG_SESSIONS_DIR = process.env.HOTDOG_SESSIONS_DIR;

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = TMP;
});

afterAll(() => {
  try {
    if (ORIG_SESSIONS_DIR === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = ORIG_SESSIONS_DIR;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});

function logPath(id: string): string {
  return join(TMP, `${id}.jsonl`);
}

function recorder() {
  const msgs: Message[] = [];
  return { msgs, agent: { addMessage: (m: Message) => { msgs.push(m); } } };
}

const restoreAgent = {
  sessionId: SESSION_ID,
  isRestoring: false,
  addMessage() {},
};

function toolMsgsFor(msgs: Message[], id: string): Message[] {
  return msgs.filter((m) => m.role === "tool" && m.toolCallId === id);
}

// ── Exhaustive byte-truncation sweep ────────────────────────────────

describe("session-log exhaustive truncation sweep", () => {
  it("every prefix of the fixture log scans/replays/restores with pinned classification", async () => {
    const { buf, ranges } = buildLog(false, true);
    const N = buf.length;
    expect(N).toBeLessThan(4096); // keeps the exhaustive sweep cheap

    const failures: string[] = [];
    let prevStarted: string[] = [];
    let prevAnswered: string[] = [];
    let prevAsked: string[] = [];
    let midUtf8 = 0;
    let midEscape = 0;
    let midCrlf = 0;

    for (let k = 0; k <= N && failures.length < 8; k++) {
      writeFileSync(logPath(SESSION_ID), buf.subarray(0, k));
      try {
        const m = ranges.reduce((acc, [, end]) => acc + (end <= k ? 1 : 0), 0);
        let lo = 0;
        for (let i = m - 1; i >= 0; i--) {
          if (FIXTURE[i]!.meta.kind === "reset") { lo = i + 1; break; }
        }

        // 1. No crash at any entry point.
        const full = await readSessionEntries(SESSION_ID, { full: true });
        const epoch = await readSessionEntries(SESSION_ID);
        const fullFacts = collectDurabilityFacts(full);
        const epochFacts = collectDurabilityFacts(epoch);
        const rec = recorder();
        const rep = replayEntriesIntoContext(rec.agent, epoch);
        const rr = await restoreSessionIntoAgent(restoreAgent, SESSION_ID);

        // 2. Pinned tolerance: intact records are EXACTLY the fixture prefix 0..m,
        //    in order; the torn tail record and everything after are dropped.
        if (JSON.stringify(full) !== JSON.stringify(RECORDS.slice(0, m))) {
          failures.push(`k=${k}: full view ${JSON.stringify(full).slice(0, 120)} != records 0..${m}`);
        }
        if (JSON.stringify(epoch) !== JSON.stringify(RECORDS.slice(lo, m))) {
          failures.push(`k=${k}: epoch view != records ${lo}..${m}`);
        }

        // 3. Durability classification, per view, against the META oracle.
        const dFull = factsDiff(fullFacts, expectedFacts(0, m));
        if (dFull) failures.push(`k=${k} [full] ${dFull}`);
        const w = expectedWindow(lo, m);
        const dEpoch = factsDiff(epochFacts, w.facts);
        if (dEpoch) failures.push(`k=${k} [epoch] ${dEpoch}`);

        // 4. A call whose result record is absent or torn is never completed, and
        //    the started-but-unfinished call never collapses into never-started.
        if (fullFacts.answered.has("call_d") || fullFacts.answered.has("call_q")) {
          failures.push(`k=${k}: unfinished call classified completed`);
        }

        // 5. Replay content: exact message count, one result per call with the
        //    pinned text (real result, held question, or the right synthesis).
        if (rec.msgs.length !== w.msgCount) {
          failures.push(`k=${k}: replayed ${rec.msgs.length} msgs != ${w.msgCount}`);
        }
        for (const [id, exp] of Object.entries(w.perCall)) {
          const tms = toolMsgsFor(rec.msgs, id);
          if (tms.length !== exp.count) {
            failures.push(`k=${k}: call ${id} has ${tms.length} tool msgs, want ${exp.count}`);
          } else if (exp.count === 1 && tms[0]!.content !== exp.content) {
            failures.push(`k=${k}: call ${id} content ${JSON.stringify(tms[0]!.content)} != ${JSON.stringify(exp.content)}`);
          }
        }
        if (JSON.stringify(rep.pendingQuestions) !== JSON.stringify(w.pending)) {
          failures.push(`k=${k}: pending ${JSON.stringify(rep.pendingQuestions)} != ${JSON.stringify(w.pending)}`);
        }
        if (rep.replayed !== rec.msgs.length) failures.push(`k=${k}: replayed count ${rep.replayed} != msgs ${rec.msgs.length}`);

        // 6. restoreSessionIntoAgent agrees with the same epoch expectation.
        if (rr.replayed !== w.msgCount) failures.push(`k=${k}: restore replayed ${rr.replayed} != ${w.msgCount}`);
        if (JSON.stringify(rr.pendingQuestions) !== JSON.stringify(w.pending)) failures.push(`k=${k}: restore pending != expected`);
        if (rr.profile !== w.profile) failures.push(`k=${k}: restore profile ${rr.profile} != ${w.profile}`);
        if (rr.openTurn !== w.facts.openTurn) failures.push(`k=${k}: restore openTurn ${rr.openTurn} != ${w.facts.openTurn}`);
        if (restoreAgent.isRestoring) failures.push(`k=${k}: isRestoring stuck true`);

        // 7. Monotone classification over the growing prefix (full view; the epoch
        //    view legitimately re-baselines at the RESET, so it is exempt).
        if (prevStarted.some((id) => !fullFacts.started.has(id))) failures.push(`k=${k}: started membership oscillated`);
        if (prevAnswered.some((id) => !fullFacts.answered.has(id))) failures.push(`k=${k}: answered membership oscillated`);
        const nowAsked = fullFacts.asked.map((p) => p.toolCallId);
        if (prevAsked.some((id) => !nowAsked.includes(id))) failures.push(`k=${k}: asked question disappeared`);
        prevStarted = [...fullFacts.started];
        prevAnswered = [...fullFacts.answered];
        prevAsked = nowAsked;
      } catch (e) {
        failures.push(`k=${k} threw: ${String(e)}`);
      }

      if (k >= 1 && k < N && (buf[k]! & 0xc0) === 0x80) midUtf8++;
      if (k >= 1 && buf[k - 1] === 0x5c) midEscape++;
      if (k >= 1 && buf[k - 1] === 0x0d && buf[k] === 0x0a) midCrlf++;
    }

    expect(failures).toEqual([]);
    // the sweep must have actually exercised the nasty cut classes
    expect(midUtf8).toBeGreaterThan(0);
    expect(midEscape).toBeGreaterThan(0);
    expect(midCrlf).toBeGreaterThan(0);
  });
});

// ── Random single-byte corruption (seeded) ──────────────────────────

const MUT_BYTES = [0x7b, 0x22, 0x5c, 0x6e, 0x7d, 0x2c, 0x65, 0x30, 0x61, 0x00, 0xff, 0x0a, 0x0d, 0x3a, 0x5d, 0x20, 0x80, 0xc3];

function mutate(rng: Rng, buf: Buffer, pos: number): Buffer {
  const out = Buffer.from(buf);
  const orig = out[pos]!;
  let b = MUT_BYTES[rng.int(MUT_BYTES.length)]!;
  for (let t = 0; t < 5 && b === orig; t++) b = MUT_BYTES[rng.int(MUT_BYTES.length)]!;
  if (b === orig) b = (orig ^ 0x2a) & 0xff; // guaranteed-different fallback
  out[pos] = b;
  return out;
}

describe("session-log single-byte corruption", () => {
  const VARIANTS = [
    { name: "base", crlf: false, trailing: true, seed: 0xa11ce },
    { name: "no-trailing-newline", crlf: false, trailing: false, seed: 0xb0b },
    { name: "crlf-all", crlf: true, trailing: true, seed: 0xc0ffee },
  ];

  const IN_RECORD_PROBES = 240;
  const TERMINATOR_PROBES = 24;

  it("a corrupted byte alters/drops only its own record; neighbors survive; scans are stable", async () => {
    const failures: string[] = [];
    for (const v of VARIANTS) {
      const { buf, ranges } = buildLog(v.crlf, v.trailing);
      const N = buf.length;
      const recAt = new Int32Array(N).fill(-1);
      ranges.forEach(([s, e], i) => {
        for (let p = s; p < e; p++) recAt[p] = i;
      });
      const inRecord: number[] = [];
      const terminator: number[] = [];
      for (let p = 0; p < N; p++) (recAt[p]! >= 0 ? inRecord : terminator).push(p);

      const rng = makeRng(v.seed);
      for (let probe = 0; probe < IN_RECORD_PROBES && failures.length < 8; probe++) {
        const pos = inRecord[rng.int(inRecord.length)]!;
        writeFileSync(logPath(SESSION_ID), mutate(rng, buf, pos));
        const label = `${v.name} pos=${pos} (record ${recAt[pos]})`;
        try {
          const e1 = await readSessionEntries(SESSION_ID, { full: true });
          const e2 = await readSessionEntries(SESSION_ID, { full: true });
          if (JSON.stringify(e1) !== JSON.stringify(e2)) {
            failures.push(`${label}: scan unstable across repeats`);
            continue;
          }
          // neighbors: line boundaries are untouched (cut is inside a record's text),
          // so every other record survives unchanged and in order; the hit record is
          // either dropped or parses as some (possibly different) object.
          const L = recAt[pos]!;
          const okDropped =
            e1.length === RECORDS.length - 1 &&
            JSON.stringify(e1) === JSON.stringify(RECORDS.slice(0, L).concat(RECORDS.slice(L + 1)));
          const okAltered =
            e1.length === RECORDS.length &&
            JSON.stringify(e1.slice(0, L)) === JSON.stringify(RECORDS.slice(0, L)) &&
            JSON.stringify(e1.slice(L + 1)) === JSON.stringify(RECORDS.slice(L + 1));
          if (!okDropped && !okAltered) failures.push(`${label}: neighbors not preserved (got ${e1.length} records)`);

          // downstream entry points keep running (classification need not be sane
          // for a mangled record, but must not crash)
          const epoch = await readSessionEntries(SESSION_ID);
          collectDurabilityFacts(epoch);
          replayEntriesIntoContext(recorder().agent, epoch);
        } catch (e) {
          failures.push(`${label}: threw ${String(e)}`);
        }
      }

      // terminator bytes (newlines/CR): corruption may merge or split lines, so pin
      // only crash-freedom and stable skip behavior, not neighbor preservation.
      for (let probe = 0; probe < TERMINATOR_PROBES && failures.length < 8; probe++) {
        const pos = terminator[rng.int(terminator.length)]!;
        writeFileSync(logPath(SESSION_ID), mutate(rng, buf, pos));
        const label = `${v.name} term pos=${pos}`;
        try {
          const e1 = await readSessionEntries(SESSION_ID, { full: true });
          const e2 = await readSessionEntries(SESSION_ID, { full: true });
          if (JSON.stringify(e1) !== JSON.stringify(e2)) failures.push(`${label}: scan unstable`);
          if (e1.length > RECORDS.length) failures.push(`${label}: more records than exist (${e1.length})`);
          const epoch = await readSessionEntries(SESSION_ID);
          collectDurabilityFacts(epoch);
          replayEntriesIntoContext(recorder().agent, epoch);
        } catch (e) {
          failures.push(`${label}: threw ${String(e)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// ── Edge inputs ─────────────────────────────────────────────────────

describe("session-log edge inputs", () => {
  async function load(id: string, bytes: Buffer | string): Promise<{ full: LogEntry[]; epoch: LogEntry[] }> {
    writeFileSync(logPath(id), bytes);
    return {
      full: await readSessionEntries(id, { full: true }),
      epoch: await readSessionEntries(id),
    };
  }

  const emptyReplay = (entries: LogEntry[]): void => {
    const facts = collectDurabilityFacts(entries);
    expect(facts.started.size).toBe(0);
    expect(facts.answered.size).toBe(0);
    expect(facts.asked).toEqual([]);
    expect(facts.resumeAttempts).toBe(0);
    expect(facts.consecutiveAutoResumes).toBe(0);
    expect(facts.openTurn).toBe(false);
    const rep = replayEntriesIntoContext(recorder().agent, entries);
    expect(rep.replayed).toBe(0);
    expect(rep.pendingQuestions).toEqual([]);
    expect(rep.profile).toBeNull();
    expect(rep.openTurn).toBe(false);
  };

  it("zero-byte log reads as empty everywhere", async () => {
    const { full, epoch } = await load("fz-empty", Buffer.alloc(0));
    expect(full).toEqual([]);
    expect(epoch).toEqual([]);
    emptyReplay(full);
    const rr = await restoreSessionIntoAgent(restoreAgent, "fz-empty");
    expect(rr).toEqual({ replayed: 0, pendingQuestions: [], profile: null, openTurn: false });
  });

  it("single newline and CRLF-only files read as empty", async () => {
    for (const bytes of ["\n", "\r\n", "\n\n\n"]) {
      const { full } = await load("fz-blank", bytes);
      expect(full).toEqual([]);
      emptyReplay(full);
    }
  });

  it("full log with the trailing newline removed keeps every record", async () => {
    const { buf } = buildLog(false, true);
    const { full } = await load("fz-sweep", buf.subarray(0, buf.length - 1));
    expect(JSON.stringify(full)).toBe(JSON.stringify(RECORDS));
    // and it restores with the full epoch truth: held question, unfinished pair
    const w = expectedWindow(7, RECORDS.length);
    const rr = await restoreSessionIntoAgent(restoreAgent, "fz-sweep");
    expect(rr.replayed).toBe(w.msgCount);
    expect(JSON.stringify(rr.pendingQuestions)).toBe(JSON.stringify(w.pending));
    expect(rr.openTurn).toBe(true);
    expect(rr.profile).toBeNull(); // epoch starts after the RESET; no profile record inside it
  });

  it("whole-file garbage never crashes and yields no records", async () => {
    const rng = makeRng(0x6a4b);
    const CHARS = "zqx#@$%^&*()_-+=[]|<>,.?/ \t\v\x01\xff";
    let junk = "";
    for (let i = 0; i < 700; i++) junk += CHARS[rng.int(CHARS.length)]!;
    expect(junk).not.toContain("{"); // no line can parse as an entry
    const { full } = await load("fz-junk", junk);
    expect(full).toEqual([]);
    emptyReplay(full);

    const soup = await load("fz-soup", "}".repeat(300) + "{".repeat(60));
    expect(soup.full).toEqual([]);
    emptyReplay(soup.full);
  });

  it("valid JSON that is not an object is dropped by the shape gate", async () => {
    const { full } = await load("fz-shape", '[1,2]\n"hello"\nnull\n42\ntrue\n{"ok":1}\n');
    expect(JSON.stringify(full)).toBe('[{"ok":1}]');
  });

  it("restore of a missing session rejects with CliError; id mismatch is a no-op", async () => {
    rmSync(logPath("fz-absent"), { force: true });
    let threw: unknown = null;
    try {
      await restoreSessionIntoAgent({ ...restoreAgent, sessionId: "fz-absent" }, "fz-absent");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(CliError);
    expect(threw).toBeInstanceOf(Error);

    const rr = await restoreSessionIntoAgent({ ...restoreAgent, sessionId: "someone-else" }, SESSION_ID);
    expect(rr).toEqual({ replayed: 0, pendingQuestions: [], profile: null, openTurn: false });
    const rn = await restoreSessionIntoAgent(restoreAgent, null);
    expect(rn).toEqual({ replayed: 0, pendingQuestions: [], profile: null, openTurn: false });
  });
});
