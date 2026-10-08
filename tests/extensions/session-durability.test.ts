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

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  replayEntriesIntoContext,
  readSessionEntries,
  LOG_SOURCE,
  type LogEntry,
} from "@core/session/session-log.ts";
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
