// Session durability (part 1) -- resume protocol tests.
//
// Covers the three facts the protocol rests on:
//   1. tool_started records: fsynced pre-execution writes keyed by tool_call_id
//      that never replay as messages.
//   2. Replay classifies calls with no result: started = outcome-unknown
//      (verify before retry), not-started = safe to retry.
//   3. question_asked records: an asked call with no result is HELD open on
//      replay and reported as a pending question for the UI to re-present.
// Plus the kill -9 definition-of-done: a process SIGKILLed mid-side-effect
// leaves exactly one side effect on disk and replays as outcome-unknown.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  replayEntriesIntoContext,
  readSessionEntries,
  restoreSessionIntoAgent,
  collectDurabilityFacts,
  LOG_SOURCE,
  type LogEntry,
} from "@core/session/session-log.ts";
import {
  getSessionRow,
  reconcileSessionIndex,
  closeSessionIndex,
  openSessionIndex,
  deriveSessionState,
  SESSION_STATE,
} from "@core/session/session-index.ts";
import {
  INTERRUPTED_TOOL_RESULT,
  INTERRUPTED_OUTCOME_UNKNOWN,
  INTERRUPTED_NOT_STARTED,
} from "@core/context/repair.ts";
import { create } from "@extensions/session-log/index.ts";
import { HOOKS } from "@core/hooks.ts";
import type { Message } from "@core/context/message.ts";
import { createMockCore } from "../helpers.ts";

const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-durability-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanup(sessionId: string): void {
  try { rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`)); } catch {}
}

/** Minimal agent sink for replay. */
function recorder() {
  const log: Message[] = [];
  return {
    agent: { addMessage: (m: Message) => void log.push(m) },
    log: log as Array<{ role?: string; toolCallId?: string | null; content?: unknown }>,
  };
}

function entry(over: Partial<LogEntry>): LogEntry {
  return {
    ts: new Date().toISOString(),
    session_id: "s",
    source: LOG_SOURCE.INPUT,
    content: "",
    ...over,
  };
}

describe("tool_started records (session-log extension)", () => {
  it("writes an fsynced started record before execution, keyed by call id", async () => {
    const sessionId = uniqueId("started");
    try {
      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      await ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
        toolCallId: "call_1",
        toolName: "bash",
        input: '{"command":"echo hi"}',
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe(LOG_SOURCE.TOOL_STARTED);
      expect(entries[0]!.tool_call_id).toBe("call_1");
      expect(entries[0]!.tool_name).toBe("bash");
      expect(entries[0]!.content).toBe('{"command":"echo hi"}');
    } finally {
      cleanup(sessionId);
    }
  });

  it("skips started records without a call id", async () => {
    const sessionId = uniqueId("started-noid");
    try {
      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      await ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
        toolCallId: undefined,
        toolName: "bash",
        input: "{}",
        agent: { sessionId },
      });
      expect(existsSync(join(SESSIONS_DIR, `${sessionId}.jsonl`))).toBe(false);
    } finally {
      cleanup(sessionId);
    }
  });

  it("started records never replay as messages", () => {
    const { agent, log } = recorder();
    const result = replayEntriesIntoContext(agent, [
      entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "c1", tool_name: "read" }),
    ]);
    expect(result.replayed).toBe(0);
    expect(log).toHaveLength(0);
  });

  it("fails closed: an unwritable barrier blocks its own call at the TOOL_CALL gate", async () => {
    // notifyHooks swallows hook errors, so a failed started-record write
    // cannot propagate -- it must flip the TOOL_CALL gate instead, or replay
    // would later read the missing record as "never ran, safe to retry".
    const sessionId = uniqueId("barrier");
    const ext = (await create(createMockCore() as never)) as never as {
      hooks: Record<string, (p: unknown) => Promise<unknown>>;
    };
    const gate = ext.hooks[HOOKS.TOOL_CALL]!;
    const preflight = (id: string) =>
      ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
        toolCallId: id,
        toolName: "bash",
        input: "{}",
        agent: { sessionId },
      });

    try {
      // Break the sessions dir after create()'s mkdir: writes now fail.
      rmSync(SESSIONS_DIR, { recursive: true, force: true });
      await preflight("call_blocked");
      // Same call reaches the gate: the failed barrier must block it.
      const blocked = (await gate({ toolCallId: "call_blocked", toolName: "bash", agent: {} })) as
        | Record<string, unknown>
        | undefined;
      expect(blocked!.action).toBe("block");
      expect(String(blocked!.result)).toContain("unwritable");

      // Disk recovered: the next pre-flight lands, that call passes the gate.
      mkdirSync(SESSIONS_DIR, { recursive: true });
      await preflight("call_after_recovery");
      expect(await gate({ toolCallId: "call_after_recovery", toolName: "bash", agent: {} })).toBeUndefined();

      const entries = await readSessionEntries(sessionId);
      expect(entries.map((e) => e.tool_call_id)).toEqual(["call_after_recovery"]);
    } finally {
      cleanup(sessionId);
    }
  });

  it("barrier failures are per call: another call's successful write does not open the gate", async () => {
    // The hooks (and this extension instance) are shared across webui
    // sessions. A global flag let one session's landed write reset another
    // session's failed barrier, letting an unrecorded side effect through.
    const sessionId = uniqueId("barrier-percall");
    const ext = (await create(createMockCore() as never)) as never as {
      hooks: Record<string, (p: unknown) => Promise<unknown>>;
    };
    const gate = ext.hooks[HOOKS.TOOL_CALL]!;
    const preflight = (id: string) =>
      ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
        toolCallId: id,
        toolName: "bash",
        input: "{}",
        agent: { sessionId },
      });

    try {
      rmSync(SESSIONS_DIR, { recursive: true, force: true });
      await preflight("call_x"); // its barrier fails
      mkdirSync(SESSIONS_DIR, { recursive: true });
      await preflight("call_y"); // another call's barrier lands

      // Y's success must not rescue X: X's started record never landed, so
      // X must be refused or replay would claim "never ran, safe to retry".
      const blockedX = (await gate({ toolCallId: "call_x", toolName: "bash", agent: {} })) as
        | Record<string, unknown>
        | undefined;
      expect(blockedX!.action).toBe("block");
      expect(await gate({ toolCallId: "call_y", toolName: "bash", agent: {} })).toBeUndefined();

      const entries = await readSessionEntries(sessionId);
      expect(entries.map((e) => e.tool_call_id)).toEqual(["call_y"]);
    } finally {
      cleanup(sessionId);
    }
  });
});

describe("replay classification of unanswered tool calls", () => {
  const toolCalls = [
    { id: "c_started", type: "function" as const, function: { name: "bash", arguments: "{}" } },
    { id: "c_never", type: "function" as const, function: { name: "bash", arguments: "{}" } },
  ];

  it("started-without-result synthesizes the outcome-unknown wording", () => {
    const { agent, log } = recorder();
    replayEntriesIntoContext(agent, [
      entry({ source: LOG_SOURCE.LLM, content: "running", tool_calls: toolCalls }),
      entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "c_started", tool_name: "bash" }),
    ]);
    expect(log).toHaveLength(3); // assistant + 2 synthesized
    const synthesized = log.filter((m) => m.role === "tool");
    expect(synthesized).toHaveLength(2);
    expect(synthesized.find((m) => m.toolCallId === "c_started")!.content).toBe(
      INTERRUPTED_OUTCOME_UNKNOWN,
    );
    expect(synthesized.find((m) => m.toolCallId === "c_never")!.content).toBe(
      INTERRUPTED_NOT_STARTED,
    );
    // Neither is the old generic string.
    for (const m of synthesized) expect(m.content).not.toBe(INTERRUPTED_TOOL_RESULT);
  });

  it("a landed result outranks the started record", () => {
    const { agent, log } = recorder();
    replayEntriesIntoContext(agent, [
      entry({ source: LOG_SOURCE.LLM, content: "running", tool_calls: toolCalls }),
      entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "c_started" }),
      entry({ source: LOG_SOURCE.TOOL_RESULT, tool_call_id: "c_started", content: "done" }),
    ]);
    const results = log.filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(results.find((m) => m.toolCallId === "c_started")!.content).toBe("done");
    expect(results.find((m) => m.toolCallId === "c_never")!.content).toBe(INTERRUPTED_NOT_STARTED);
  });

  it("a log with NO started records (pre-protocol) makes no retry claim", () => {
    // Absence of a started record only means "never dispatched" when the log
    // actually uses the records. A log from before the protocol gets the
    // generic interrupted wording: no "safe to retry" claim on bare absence.
    const { agent, log } = recorder();
    replayEntriesIntoContext(agent, [
      entry({ source: LOG_SOURCE.LLM, content: "running", tool_calls: toolCalls }),
    ]);
    const synthesized = log.find((m) => m.role === "tool");
    expect(synthesized!.content).toBe(INTERRUPTED_TOOL_RESULT);
  });
});

describe("question_asked records and pending questions", () => {
  it("question events write a durable asked record keyed by call id", async () => {
    const sessionId = uniqueId("asked");
    try {
      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      await ext.hooks[HOOKS.OUTPUT_EVENT]!({
        type: "question",
        data: {
          toolCallId: "call_q",
          questions: [{ key: "color", prompt: "Favorite color?" }],
        },
        agent: { sessionId },
      });
      // Events without a call id (legacy shape) or without questions are ignored.
      await ext.hooks[HOOKS.OUTPUT_EVENT]!({
        type: "question",
        data: { questions: [{ key: "x", prompt: "?" }] },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe(LOG_SOURCE.QUESTION_ASKED);
      expect(entries[0]!.tool_call_id).toBe("call_q");
      expect(entries[0]!.content).toEqual([{ key: "color", prompt: "Favorite color?" }]);
    } finally {
      cleanup(sessionId);
    }
  });

  it("asked-without-result is held open and reported as pending", () => {
    const { agent, log } = recorder();
    const questions = [{ key: "mode", prompt: "Which mode?", options: ["a", "b"] }];
    const result = replayEntriesIntoContext(agent, [
      entry({
        source: LOG_SOURCE.LLM,
        content: "let me ask",
        tool_calls: [
          { id: "call_q", type: "function", function: { name: "question", arguments: "{}" } },
        ],
      }),
      entry({ source: LOG_SOURCE.TOOL_STARTED, tool_call_id: "call_q", tool_name: "question" }),
      entry({ source: LOG_SOURCE.QUESTION_ASKED, tool_call_id: "call_q", content: questions }),
    ]);

    // The call is NOT synthesized -- it stays pending for re-presentation.
    expect(result.replayed).toBe(1);
    expect(log).toHaveLength(1);
    expect(log[0]!.role).toBe("assistant");
    expect(result.pendingQuestions).toEqual([{ toolCallId: "call_q", questions }]);
  });

  it("answered questions replay normally with no pending", () => {
    const { agent, log } = recorder();
    const result = replayEntriesIntoContext(agent, [
      entry({
        source: LOG_SOURCE.LLM,
        content: "let me ask",
        tool_calls: [
          { id: "call_q", type: "function", function: { name: "question", arguments: "{}" } },
        ],
      }),
      entry({ source: LOG_SOURCE.QUESTION_ASKED, tool_call_id: "call_q", content: [] }),
      entry({ source: LOG_SOURCE.TOOL_RESULT, tool_call_id: "call_q", content: '{"mode":"a"}' }),
    ]);
    expect(result.pendingQuestions).toHaveLength(0);
    expect(log.some((m) => m.role === "tool" && m.content === '{"mode":"a"}')).toBe(true);
  });

  it("asked-after-a-result (answer landed pre-crash) stays answered", () => {
    // Ordering must not matter: answered is answered.
    const { agent } = recorder();
    const result = replayEntriesIntoContext(agent, [
      entry({
        source: LOG_SOURCE.LLM,
        content: "asked",
        tool_calls: [
          { id: "call_q", type: "function", function: { name: "question", arguments: "{}" } },
        ],
      }),
      entry({ source: LOG_SOURCE.TOOL_RESULT, tool_call_id: "call_q", content: "answered" }),
      entry({ source: LOG_SOURCE.QUESTION_ASKED, tool_call_id: "call_q", content: [] }),
    ]);
    expect(result.pendingQuestions).toHaveLength(0);
  });
});

describe("kill -9 mid-side-effect (definition of done)", () => {
  it("side effect lands exactly once and replays as outcome-unknown", async () => {
    const sessionId = uniqueId("crash");
    const counterPath = join(SESSIONS_DIR, `counter-${sessionId}`);
    try {
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "../fixtures/crash-mid-tool.ts")],
        {
          env: {
            ...process.env,
            HOTDOG_SESSIONS_DIR: SESSIONS_DIR,
            CRASH_SESSION_ID: sessionId,
            COUNTER_PATH: counterPath,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await proc.exited;

      // Exactly one side effect; no fabricated success, torn tail tolerated.
      expect(readFileSync(counterPath, "utf-8")).toBe("1\n");

      // Both records survived kill -9: the started-record fsync also carried
      // the preceding (un-fsynced) assistant tool_calls entry across the kill.
      const entries = await readSessionEntries(sessionId);
      expect(entries.map((e) => e.source)).toEqual([
        LOG_SOURCE.LLM,
        LOG_SOURCE.TOOL_STARTED,
      ]);

      // Replay the recovered log as-is -- real bytes, no hand-built pairing:
      // the started call synthesizes outcome-unknown, never success.
      const { agent, log } = recorder();
      const result = replayEntriesIntoContext(agent, entries);
      expect(result.replayed).toBe(2); // assistant + synthesized tool result
      const synthesized = log.find((m) => m.role === "tool");
      expect(synthesized!.toolCallId).toBe("call_crash");
      expect(synthesized!.content).toBe(INTERRUPTED_OUTCOME_UNKNOWN);
    } finally {
      cleanup(sessionId);
      try { rmSync(counterPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: the disposable session index mirrors these same durability records.
// ---------------------------------------------------------------------------

function openCallIds(sessionId: string): string[] {
  return openSessionIndex()
    .query<{ tool_call_id: string }, [string]>(
      "SELECT tool_call_id FROM open_calls WHERE session_id = ? ORDER BY tool_call_id",
    )
    .all(sessionId)
    .map((r) => r.tool_call_id);
}

describe("session index mirrors durability commit points", () => {
  it("started/question/result flow through the real hooks; interrupted comes only from reconcile", async () => {
    const sessionId = uniqueId("mirror");
    try {
      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      const agent = { sessionId, profileName: "prof", model: "mod" };

      await ext.hooks[HOOKS.CONTEXT_MESSAGE]!({
        message: { sessionId, role: "user", content: "go", getTextContent: () => "go" },
        agent,
      });
      await ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
        toolCallId: "c1",
        toolName: "bash",
        input: "echo 1",
        agent,
      });

      // Live session mid tool call, row built by the missing-row sync: the
      // state reflects the log's facts (an unanswered started IS what the
      // ledger shows) and self-corrects when the result lands. The writer
      // never DECLARES a state here -- TOOL_BEFORE_EXECUTE only mirrors the
      // open call and the position.
      let row = getSessionRow(sessionId);
      expect(row?.state).toBe(SESSION_STATE.INTERRUPTED);
      expect(row?.model).toBe("mod");
      expect(row?.profile).toBe("prof");
      expect(openCallIds(sessionId)).toEqual(["c1"]);

      await ext.hooks[HOOKS.OUTPUT_EVENT]!({
        type: "question",
        data: { toolCallId: "c2", questions: [{ prompt: "which?" }] },
        agent,
      });
      row = getSessionRow(sessionId);
      expect(row?.state).toBe(SESSION_STATE.AWAITING_QUESTION);

      // A plain tool result must not clear an open question...
      await ext.hooks[HOOKS.CONTEXT_MESSAGE]!({
        message: { sessionId, role: "tool", toolCallId: "c1", content: "1" },
        agent,
      });
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.AWAITING_QUESTION);

      // ...but answering the question does.
      await ext.hooks[HOOKS.CONTEXT_MESSAGE]!({
        message: { sessionId, role: "tool", toolCallId: "c2", content: "this one" },
        agent,
      });
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.IDLE);
      expect(openCallIds(sessionId)).toEqual([]);

      // Crash simulation: a started record fsynced without an index txn (the
      // writer died in between). The row is now stale; the next boot
      // reconcile re-reads the log and is the only one who may call this
      // session interrupted.
      appendFileSync(
        join(SESSIONS_DIR, `${sessionId}.jsonl`),
        JSON.stringify(
          entry({
            session_id: sessionId,
            source: LOG_SOURCE.TOOL_STARTED,
            tool_call_id: "c3",
            tool_name: "bash",
            content: "echo never",
          }),
        ) + "\n",
      );
      const stats = await reconcileSessionIndex();
      expect(stats.reindexed).toBeGreaterThanOrEqual(1);
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.INTERRUPTED);
      expect(openCallIds(sessionId)).toEqual(["c3"]);
    } finally {
      cleanup(sessionId);
    }
  });
});

describe("resume_attempt record (livelock cap counter)", () => {
  it("restoreSessionIntoAgent fsyncs the record, mirrors the count, replays it silently", async () => {
    const sessionId = uniqueId("resume");
    const logPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      writeFileSync(
        logPath,
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "u" })) + "\n",
      );

      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      const log: Message[] = [];
      const agent = {
        sessionId,
        isRestoring: false,
        addMessage: (m: Message) => void log.push(m),
        hooks: {
          notifyHooks: async (name: string, payload: unknown) => {
            if (name === HOOKS.SESSION_RESUME_ATTEMPT) {
              await ext.hooks[HOOKS.SESSION_RESUME_ATTEMPT]!(payload);
            }
          },
        },
      };

      await restoreSessionIntoAgent(agent, sessionId);
      await restoreSessionIntoAgent(agent, sessionId);

      // Two attempts recorded IN THE LOG (the system of record)...
      const entries = await readSessionEntries(sessionId);
      expect(entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT)).toHaveLength(2);

      // ...mirrored in the index (survivable: deleting the index re-derives it)...
      expect(getSessionRow(sessionId)?.resume_count).toBe(2);

      // ...and never replayed as a conversation message.
      expect(log.filter((m) => m.content === "u")).toHaveLength(2); // one per restore
      expect(log.filter((m) => (m.content ?? "") === "")).toHaveLength(0);
    } finally {
      cleanup(sessionId);
    }
  });

  it("restoreSessionIntoAgent returns the last profile from SESSION_START and PROFILE_SWITCH entries", async () => {
    const sessionId = uniqueId("resume-profile");
    const logPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      writeFileSync(
        logPath,
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", profile: "default", model: "m1" })) + "\n" +
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "u1" })) + "\n" +
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.PROFILE_SWITCH, content: "", from_profile: "default", profile: "auditor" })) + "\n" +
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.LLM, content: "response" })) + "\n",
      );

      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      const agent = {
        sessionId,
        isRestoring: false,
        addMessage: (_m: Message) => {},
        hooks: {
          notifyHooks: async (name: string, payload: unknown) => {
            if (name === HOOKS.SESSION_RESUME_ATTEMPT) {
              await ext.hooks[HOOKS.SESSION_RESUME_ATTEMPT]!(payload);
            }
          },
        },
      };

      const result = await restoreSessionIntoAgent(agent, sessionId);
      expect(result.profile).toBe("auditor");
    } finally {
      cleanup(sessionId);
    }
  });

  it("restoreSessionIntoAgent returns null profile when log has no profile entries", async () => {
    const sessionId = uniqueId("resume-no-profile");
    const logPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      writeFileSync(
        logPath,
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "u1" })) + "\n",
      );

      const ext = (await create(createMockCore() as never)) as never as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
      };
      const agent = {
        sessionId,
        isRestoring: false,
        addMessage: (_m: Message) => {},
        hooks: {
          notifyHooks: async (name: string, payload: unknown) => {
            if (name === HOOKS.SESSION_RESUME_ATTEMPT) {
              await ext.hooks[HOOKS.SESSION_RESUME_ATTEMPT]!(payload);
            }
          },
        },
      };

      const result = await restoreSessionIntoAgent(agent, sessionId);
      expect(result.profile).toBeNull();
    } finally {
      cleanup(sessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 3: the livelock cap on consecutive auto-resumes.
// ---------------------------------------------------------------------------

function autoResumeEntry(): LogEntry {
  return entry({ source: LOG_SOURCE.RESUME_ATTEMPT, content: { origin: "auto" } });
}
function manualResumeEntry(): LogEntry {
  return entry({ source: LOG_SOURCE.RESUME_ATTEMPT, content: { origin: "manual" } });
}
/** Pre-cap record: no origin field (counts as manual). */
function legacyResumeEntry(): LogEntry {
  return entry({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" });
}
function progressEntry(): LogEntry {
  return entry({ source: LOG_SOURCE.LLM, content: "ok" });
}

describe("consecutive auto-resume counter", () => {
  it("counts auto resumes since the last progress entry", () => {
    expect(collectDurabilityFacts([progressEntry(), autoResumeEntry(), autoResumeEntry()]).consecutiveAutoResumes).toBe(2);
    // Manual resumes never count, and do not reset the chain.
    expect(collectDurabilityFacts([autoResumeEntry(), manualResumeEntry(), autoResumeEntry()]).consecutiveAutoResumes).toBe(2);
    // Pre-cap records (no origin) count as manual.
    expect(collectDurabilityFacts([legacyResumeEntry(), autoResumeEntry()]).consecutiveAutoResumes).toBe(1);
    // Progress resets.
    expect(collectDurabilityFacts([autoResumeEntry(), autoResumeEntry(), progressEntry(), autoResumeEntry()]).consecutiveAutoResumes).toBe(1);
    // A held question is not progress (waiting on a human is not churn).
    const q = entry({ source: LOG_SOURCE.QUESTION_ASKED, tool_call_id: "q", content: [] });
    expect(collectDurabilityFacts([autoResumeEntry(), q, autoResumeEntry()]).consecutiveAutoResumes).toBe(2);
    // resume_attempt itself is not progress.
    expect(collectDurabilityFacts([autoResumeEntry(), manualResumeEntry()]).resumeAttempts).toBe(2);
  });

  it("harness-origin input is not progress (machine nudges must not reset the cap)", () => {
    // The session-log extension logs every harness message (empty-turn
    // nudge, truncated-stop notice) under source INPUT. A crash loop that
    // nudges once per cycle must not recharge the cap forever: only real
    // user/LLM/tool activity is progress.
    const nudge = entry({ source: LOG_SOURCE.INPUT, origin: "harness", content: "nudge" });
    expect(collectDurabilityFacts([autoResumeEntry(), nudge, autoResumeEntry()]).consecutiveAutoResumes).toBe(2);
    // Real user input still resets.
    const user = entry({ source: LOG_SOURCE.INPUT, origin: "user", content: "hi" });
    expect(collectDurabilityFacts([autoResumeEntry(), user, autoResumeEntry()]).consecutiveAutoResumes).toBe(1);
    // Model responses are origin-agnostic progress (their origin is "model").
    expect(collectDurabilityFacts([autoResumeEntry(), progressEntry(), autoResumeEntry()]).consecutiveAutoResumes).toBe(1);
    // v1 entries carry no origin at all: treated as progress (pre-cap logs
    // have no auto-resume records anyway, so this cannot park a legacy log).
    const legacy = entry({ source: LOG_SOURCE.INPUT, content: "hi" });
    expect(collectDurabilityFacts([autoResumeEntry(), legacy, autoResumeEntry()]).consecutiveAutoResumes).toBe(1);
  });

  it("deriveSessionState prioritizes parked", () => {
    const base = { started: new Set<string>(), answered: new Set<string>(), asked: [] as Array<{ toolCallId: string }> };
    expect(deriveSessionState({ ...base, consecutiveAutoResumes: 5 })).toBe(SESSION_STATE.PARKED);
    expect(deriveSessionState({ ...base, consecutiveAutoResumes: 4 })).toBe(SESSION_STATE.IDLE);
    // parked outranks an open question too: it gates the next auto-resume.
    expect(deriveSessionState({ ...base, asked: [{ toolCallId: "q" }], consecutiveAutoResumes: 5 })).toBe(SESSION_STATE.PARKED);
  });
});

describe("livelock cap on auto-resume (restoreSessionIntoAgent)", () => {
  /** Write a log: one input, then n auto resume attempts. */
  function writeLivelockLog(sessionId: string, autos: number): void {
    const lines = [JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "work" }))];
    for (let i = 0; i < autos; i++) {
      lines.push(JSON.stringify(autoResumeEntry()));
    }
    writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  type ResumeExt = { hooks: Record<string, (p: unknown) => Promise<unknown>> };

  function resumeAgent(sessionId: string, ext: ResumeExt) {
    const log: Message[] = [];
    return {
      sessionId,
      isRestoring: false,
      addMessage: (m: Message) => void log.push(m),
      hooks: {
        notifyHooks: async (name: string, payload: unknown) => {
          if (name === HOOKS.SESSION_RESUME_ATTEMPT) {
            await ext.hooks[HOOKS.SESSION_RESUME_ATTEMPT]!(payload);
          }
        },
      },
    };
  }

  it("refuses an auto-resume at the cap and writes no attempt record", async () => {
    const sessionId = uniqueId("cap-refused");
    try {
      writeLivelockLog(sessionId, 5);
      const ext = (await create(createMockCore() as never)) as never as ResumeExt;
      const agent = resumeAgent(sessionId, ext);

      await expect(restoreSessionIntoAgent(agent, sessionId, { auto: true })).rejects.toThrow("parked");
      // A refusal is not an attempt: the counter must not climb on refusal.
      const entries = await readSessionEntries(sessionId);
      expect(entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT)).toHaveLength(5);
    } finally {
      cleanup(sessionId);
    }
  });

  it("manual resume bypasses the cap (the escape hatch)", async () => {
    const sessionId = uniqueId("cap-manual");
    try {
      writeLivelockLog(sessionId, 5);
      const ext = (await create(createMockCore() as never)) as never as ResumeExt;
      const agent = resumeAgent(sessionId, ext);

      const result = await restoreSessionIntoAgent(agent, sessionId); // manual
      expect(result.replayed).toBeGreaterThan(0);
      const entries = await readSessionEntries(sessionId);
      const attempts = entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT);
      expect(attempts).toHaveLength(6);
      expect((attempts[5] as { content: unknown }).content).toEqual({ origin: "manual" });
    } finally {
      cleanup(sessionId);
    }
  });

  it("records origin auto and parks the row when the cap is reached", async () => {
    const sessionId = uniqueId("cap-reached");
    try {
      writeLivelockLog(sessionId, 4);
      const ext = (await create(createMockCore() as never)) as never as ResumeExt;
      const agent = resumeAgent(sessionId, ext);

      // The 5th auto-resume is still allowed (cap = refuse at 5); this one
      // pushes the consecutive count to the cap and must park the row.
      await restoreSessionIntoAgent(agent, sessionId, { auto: true });
      const entries = await readSessionEntries(sessionId);
      const attempts = entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT);
      expect(attempts).toHaveLength(5);
      expect((attempts[4] as { content: unknown }).content).toEqual({ origin: "auto" });
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.PARKED);
      // The index is disposable: reconcile re-derives parked from the log.
      await reconcileSessionIndex();
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.PARKED);
    } finally {
      cleanup(sessionId);
    }
  });

  it("a RESET between auto-resumes does not recharge the cap (lifetime-scoped counter)", async () => {
    const sessionId = uniqueId("cap-reset");
    try {
      // input (progress), 2 autos, a mid-turn checkpoint (RESET), 3 more
      // autos: 5 consecutive since the last progress in the FULL log, but
      // only 3 in the post-RESET epoch -- an epoch-scoped counter would
      // wrongly allow this resume.
      const lines = [
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "work" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.RESET, content: "" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
      ];
      writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");
      const ext = (await create(createMockCore() as never)) as never as ResumeExt;
      const agent = resumeAgent(sessionId, ext);

      await expect(restoreSessionIntoAgent(agent, sessionId, { auto: true })).rejects.toThrow("parked");
      // The refusal writes no record across the reset either.
      const entries = await readSessionEntries(sessionId, { full: true });
      expect(entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT)).toHaveLength(5);
    } finally {
      cleanup(sessionId);
    }
  });

  it("under-cap churn across a RESET still resumes (the cap counts, the epoch replays)", async () => {
    const sessionId = uniqueId("cap-reset-under");
    try {
      // input, 2 autos, RESET, 2 autos: 4 consecutive < cap in the full log.
      const lines = [
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "work" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.RESET, content: "" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
      ];
      writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");
      const ext = (await create(createMockCore() as never)) as never as ResumeExt;
      const agent = resumeAgent(sessionId, ext);

      const result = await restoreSessionIntoAgent(agent, sessionId, { auto: true });
      expect(result.openTurn).toBe(false);
      const entries = await readSessionEntries(sessionId, { full: true });
      expect(entries.filter((e) => e.source === LOG_SOURCE.RESUME_ATTEMPT)).toHaveLength(5);
    } finally {
      cleanup(sessionId);
    }
  });

  it("reconcile re-derives parked across a RESET (full-log lifetime facts)", async () => {
    const sessionId = uniqueId("cap-reset-reconcile");
    try {
      // 5 consecutive autos in the full log, split by a RESET: the epoch
      // alone only holds 4, so a boot resync must still land on parked.
      const lines = [
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.INPUT, content: "work" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(entry({ session_id: sessionId, source: LOG_SOURCE.RESET, content: "" })),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
        JSON.stringify(autoResumeEntry()),
      ];
      writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join("\n") + "\n");

      await reconcileSessionIndex();
      expect(getSessionRow(sessionId)?.state).toBe(SESSION_STATE.PARKED);
      // The mirror count is lifetime-scoped too: all 5 attempts, not the
      // epoch's 4.
      expect(getSessionRow(sessionId)?.resume_count).toBe(5);
    } finally {
      cleanup(sessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 3.5: turn lifecycle records (protocol v2) and auto-resume.
// ---------------------------------------------------------------------------

describe("turn lifecycle records (protocol v2)", () => {
  function turnStarted(kind = "input"): LogEntry {
    return entry({ source: LOG_SOURCE.TURN_STARTED, v: 2, content: { kind } });
  }
  function turnEnd(status = "completed"): LogEntry {
    return entry({ source: LOG_SOURCE.TURN_END, v: 2, content: { status } });
  }

  it("openTurn tracks the v2 turn_started/turn_end pair", () => {
    // Open: a turn_started with no turn_end after it.
    expect(collectDurabilityFacts([turnStarted()]).openTurn).toBe(true);
    // Closed: the turn_end lands.
    expect(collectDurabilityFacts([turnStarted(), turnEnd()]).openTurn).toBe(false);
    // A later turn re-opens.
    expect(collectDurabilityFacts([turnStarted(), turnEnd(), turnStarted()]).openTurn).toBe(true);
    // v1 logs carry no turn records: never open, never auto-resumed.
    expect(collectDurabilityFacts([entry({ source: LOG_SOURCE.INPUT, content: "hi" })]).openTurn).toBe(false);
  });

  it("deriveSessionState reports an open v2 turn as interrupted", () => {
    const base = { started: new Set<string>(), answered: new Set<string>(), asked: [] as Array<{ toolCallId: string }> };
    // Crash mid-generation: no dangling calls, but the turn is open.
    expect(deriveSessionState({ ...base, openTurn: true })).toBe(SESSION_STATE.INTERRUPTED);
    // A held question outranks: the session waits on a human, not a resume.
    expect(deriveSessionState({ ...base, openTurn: true, asked: [{ toolCallId: "q" }] })).toBe(
      SESSION_STATE.AWAITING_QUESTION,
    );
    // Parked still outranks everything.
    expect(deriveSessionState({ ...base, openTurn: true, consecutiveAutoResumes: 5 })).toBe(SESSION_STATE.PARKED);
  });

  describe("turn records written by the session-log extension", () => {
    type TurnExt = {
      hooks: Record<string, (p: unknown) => Promise<unknown>>;
    };
    let ext: TurnExt;

    beforeEach(async () => {
      ext = (await create(createMockCore() as never)) as never as TurnExt;
    });

    it("writes turn_started on the first iteration only, with kind and v2", async () => {
      const sessionId = uniqueId("turn-start");
      try {
        await ext.hooks[HOOKS.TURN_START]!({ turnIndex: 2, agent: { sessionId } });
        await ext.hooks[HOOKS.TURN_START]!({ turnIndex: 1, agent: { sessionId }, kind: "continuation" });
        const entries = (await readSessionEntries(sessionId)).filter(
          (e) => e.source === LOG_SOURCE.TURN_STARTED,
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]!.content).toEqual({ kind: "continuation" });
        expect(entries[0]!.v).toBe(2);
      } finally {
        cleanup(sessionId);
      }
    });

    it("writes turn_end only when the turn stops, with the mapped status", async () => {
      const sessionId = uniqueId("turn-end");
      // [stopped, reason, cancelled?]
      const fired: Array<[boolean, string, boolean?]> = [
        [false, "continue"], // in-turn advance: no record
        [true, "completion"],
        [true, "tool_return"],
        [true, "max_iterations"],
        [true, "cancelled"],
        // Cancel that lands after the final response assembled: reason is
        // still "completion", the flag must carry the cancellation.
        [true, "completion", true],
        [true, "error"],
        [true, "empty_response"],
      ];
      try {
        for (const [stopped, reason, cancelled] of fired) {
          await ext.hooks[HOOKS.TURN_END]!({ stopped, reason, cancelled, agent: { sessionId } });
        }
        const ends = (await readSessionEntries(sessionId)).filter((e) => e.source === LOG_SOURCE.TURN_END);
        expect(ends.map((e) => (e.content as { status: string }).status)).toEqual([
          "completed",
          "completed",
          "completed",
          "cancelled",
          "cancelled",
          "error",
          "error",
        ]);
        expect(ends.every((e) => e.v === 2)).toBe(true);
      } finally {
        cleanup(sessionId);
      }
    });

    it("stamps v2 on conversation entries", async () => {
      const sessionId = uniqueId("v-stamp");
      try {
        await ext.hooks[HOOKS.CONTEXT_MESSAGE]!({
          message: { role: "user", content: "hi" },
          agent: { sessionId },
        });
        const entries = await readSessionEntries(sessionId);
        expect(entries.every((e) => e.v === 2)).toBe(true);
      } finally {
        cleanup(sessionId);
      }
    });

    it("re-emits the open-turn marker after a mid-turn checkpoint", async () => {
      const sessionId = uniqueId("rewind-reemit");
      try {
        // Open the turn, then checkpoint (compaction): the reset truncates the
        // epoch view, and the marker must be re-emitted below it.
        await ext.hooks[HOOKS.TURN_START]!({ turnIndex: 1, agent: { sessionId }, kind: "input" });
        await ext.hooks[HOOKS.CONTEXT_REWOUND]!({
          agent: { sessionId },
          newContext: [{ role: "harness", content: "summary" }],
        });
        const entries = await readSessionEntries(sessionId); // epoch after the reset
        const starts = entries.filter((e) => e.source === LOG_SOURCE.TURN_STARTED);
        expect(starts).toHaveLength(1);
        expect(starts[0]!.content).toEqual({ kind: "input" });
        expect(collectDurabilityFacts(entries).openTurn).toBe(true);
      } finally {
        cleanup(sessionId);
      }
    });
  });

  describe("auto-resume continuation (restoreSessionIntoAgent)", () => {
    function resumeAgent(sessionId: string, ext: never) {
      const log: Message[] = [];
      return {
        sessionId,
        isRestoring: false,
        addMessage: (m: Message) => void log.push(m),
        hooks: {
          notifyHooks: async (name: string, payload: unknown) => {
            if (name === HOOKS.SESSION_RESUME_ATTEMPT) {
              await (ext as { hooks: Record<string, (p: unknown) => Promise<unknown>> }).hooks[
                HOOKS.SESSION_RESUME_ATTEMPT
              ]!(payload);
            }
          },
        },
      };
    }

    it("reports openTurn from a v2 open log, closed from a finished log, absent from v1", async () => {
      const ext = (await create(createMockCore() as never)) as never;
      const v2open = uniqueId("open");
      const v2closed = uniqueId("closed");
      const v1 = uniqueId("v1");
      const line = (sessionId: string, e: LogEntry) => JSON.stringify({ ...e, session_id: sessionId });
      try {
        // v2, open: input, turn started, died mid-tool (started, no result).
        writeFileSync(
          join(SESSIONS_DIR, `${v2open}.jsonl`),
          [
            line(v2open, entry({ source: LOG_SOURCE.INPUT, v: 2, content: "work" })),
            line(v2open, entry({ source: LOG_SOURCE.TURN_STARTED, v: 2, content: { kind: "input" } })),
            line(v2open, entry({ source: LOG_SOURCE.TOOL_STARTED, v: 2, content: "{}", tool_call_id: "c1" })),
          ].join("\n") + "\n",
        );
        // v2, closed: the turn ended (final response).
        writeFileSync(
          join(SESSIONS_DIR, `${v2closed}.jsonl`),
          [
            line(v2closed, entry({ source: LOG_SOURCE.INPUT, v: 2, content: "work" })),
            line(v2closed, entry({ source: LOG_SOURCE.TURN_STARTED, v: 2, content: { kind: "input" } })),
            line(v2closed, entry({ source: LOG_SOURCE.LLM, v: 2, content: "done" })),
            line(v2closed, entry({ source: LOG_SOURCE.TURN_END, v: 2, content: { status: "completed" } })),
          ].join("\n") + "\n",
        );
        // v1: the same shape without turn records (pre-protocol log).
        writeFileSync(
          join(SESSIONS_DIR, `${v1}.jsonl`),
          [
            line(v1, entry({ source: LOG_SOURCE.INPUT, content: "work" })),
            line(v1, entry({ source: LOG_SOURCE.TOOL_STARTED, content: "{}", tool_call_id: "c1" })),
          ].join("\n") + "\n",
        );

        const open = await restoreSessionIntoAgent(resumeAgent(v2open, ext), v2open, { auto: true });
        expect(open.openTurn).toBe(true);
        const closed = await restoreSessionIntoAgent(resumeAgent(v2closed, ext), v2closed, { auto: true });
        expect(closed.openTurn).toBe(false);
        const old = await restoreSessionIntoAgent(resumeAgent(v1, ext), v1, { auto: true });
        expect(old.openTurn).toBe(false);
      } finally {
        cleanup(v2open);
        cleanup(v2closed);
        cleanup(v1);
      }
    });
  });
});
