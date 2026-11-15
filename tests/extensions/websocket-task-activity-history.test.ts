// Subagent feed session scoping + activity replay (C2S taskActivityRequest).
// The feed is scoped on the wire: task updates/activity reach only sockets
// whose active session owns the task, snapshots are per-session, and replay
// requests cannot cross sessions.

import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import {
  C2S,
  S2C,
  MAX_TASK_ACTIVITY_CHARS,
  taskActivityFromLogEntries,
  type TaskActivityWire,
} from "@extensions/websocket/protocol.ts";
import {
  ctxByIndex,
  deriveCallDurationsByIndex,
  turnFinalDurationsByIndex,
} from "@utils/session-turns.ts";
import { LOG_SOURCE } from "@core/session/session-log.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import type { AgentLike } from "@core/session/index.ts";
import {
  createWsMockCore,
  createWsMockWs,
} from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;
type WsServer = ReturnType<typeof createWsServer>;

function messages(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

// buildAgent whose task run streams the given event script through the sink
// (default: text + reasoning + a tool call). Parent (non-sink) agents get
// unique session ids so scoping can be tested against the ids the sockets
// actually attach to.
const DEFAULT_TASK_SCRIPT: OutputEvent[] = [
  { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "working" },
  { type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "hmm" },
  { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "ls", toolCallId: "c1" },
];

function makeServer(streamEvents?: OutputEvent[]): WsServer {
  const core = createWsMockCore();
  let sessionSeq = 0;
  const buildAgent = async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit: (e: unknown) => void } | undefined;
    const agent: any = {
      sessionId: sink ? `task-agent-${sessionSeq}` : `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => {
        for (const ev of streamEvents ?? DEFAULT_TASK_SCRIPT) sink?.emit(ev);
        return { type: "completion", content: "done" };
      },
      notifyCompletion: () => {},
    };
    if (!sink) {
      agent.getMessages = () => [];
      agent.hooks = {
        notifyHooks: () => {},
        runHookPipeline: async () => undefined,
        registerHook: () => {},
        unregisterHook: () => {},
      };
      agent.serialize = () => ({});
      agent.applyProfile = () => {};
      agent.cancel = () => {};
      agent.resetCancel = () => {};
      agent.executeCommand = async () => null;
      agent.addMessage = () => {};
      agent.clearContext = async () => {};
      agent.profileName = "default";
      agent.modelRegistry = {};
      agent.sink = null;
      agent.enqueueCallback = null;
      agent.toolWhitelist = null;
      agent.profileBody = undefined;
    }
    return agent as AgentLike;
  };
  return createWsServer(core, { buildAgent: buildAgent as never });
}

function openSocket(wsServer: WsServer): MockWs {
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  return ws;
}

/** Wait for the async attach to land; returns the sessionCreated id.
 * Generous deadline: the attach is in-memory, so the only way it misses is
 * event-loop starvation under `bun test --parallel` on loaded runners. */
async function attachedSessionId(ws: MockWs): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const created = messages(ws).find((m) => m.type === S2C.SESSION_CREATED);
    if (created) return created.sessionId as string;
    if (Date.now() > deadline) throw new Error("socket never attached");
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function settle(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("subagent feed session scoping", () => {
  let wsServer: WsServer | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  it("routes task updates and activity only to sockets watching the owning session", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    // A second socket on the same session (attach-to-most-recent).
    const ws2 = openSocket(wsServer);
    const sid2 = await attachedSessionId(ws2);
    expect(sid2).toBe(sid);

    // A third socket moved onto its own fresh session.
    const ws3 = openSocket(wsServer);
    await attachedSessionId(ws3);
    wsServer.onMessage(ws3, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await settle(
      () => messages(ws3).filter((m) => m.type === S2C.SESSION_CREATED).length >= 2,
      "ws3 second sessionCreated",
    );
    ws3.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    expect(tm).toBeTruthy();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sid } });
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_ACTIVITY),
      "task activity on ws1",
    );

    const updates1 = messages(ws1).filter((m) => m.type === S2C.TASK_UPDATE);
    expect(updates1.length).toBeGreaterThan(0);
    expect(updates1[0].task.sessionId).toBe(sid);
    expect(messages(ws1).some((m) => m.type === S2C.TASK_ACTIVITY)).toBe(true);
    expect(messages(ws2).some((m) => m.type === S2C.TASK_ACTIVITY)).toBe(true);
    expect(ws3.messages.length).toBe(0);
  });

  it("keeps orphan tasks (no parent session) off the wire entirely", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    await attachedSessionId(ws);
    ws.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-orphan", "no parent");
    // Give any stray broadcast a chance to land.
    await new Promise((r) => setTimeout(r, 10));

    expect(messages(ws).filter((m) => String(m.type).startsWith("task"))).toEqual([]);
  });

  it("snapshots are scoped to the socket's session on attach", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sid } });

    // New socket attaches to the most-recent session (A) and gets only A's tasks.
    const ws2 = openSocket(wsServer);
    const sid2 = await attachedSessionId(ws2);
    const list = messages(ws2).find((m) => m.type === S2C.TASK_LIST);
    expect(list).toBeTruthy();
    expect(list.tasks.map((t: any) => t.taskId)).toEqual(["task-1"]);
    expect(list.tasks.every((t: any) => t.sessionId === sid2)).toBe(true);
  });

  it("re-sends the scoped snapshot when the socket attaches elsewhere and back", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sidA = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sidA } });

    // Same socket creates a fresh session B (attaches to it): empty snapshot.
    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_LIST),
      "scoped snapshot after createSession",
    );
    let lists = messages(ws1).filter((m) => m.type === S2C.TASK_LIST);
    expect(lists[lists.length - 1].tasks).toEqual([]);

    // Switch back to A: the snapshot re-scopes and task-1 returns.
    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: sidA }));
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_LIST),
      "scoped snapshot after switchSession",
    );
    lists = messages(ws1).filter((m) => m.type === S2C.TASK_LIST);
    const last = lists[lists.length - 1];
    expect(last.tasks.map((t: any) => t.taskId)).toEqual(["task-1"]);
    expect(last.tasks[0].sessionId).toBe(sidA);
  });

  it("replays recorded activity only within the owning session", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);

    const tm = wsServer.sessionRegistry.getTaskManager();
    const handle = await tm!.spawnTask("task-1", "do it", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 1000))]);

    const before = ws2.messages.length;
    ws1.messages.length = 0;
    // Awaited: the settled-task reply may ride the durable-log read (real
    // I/O, route settle contract); this fixture has no log, so the content
    // below is still the buffer's exact bytes.
    await wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "task-1" }),
    );

    const replies = messages(ws1).filter((m) => m.type === S2C.TASK_ACTIVITY_HISTORY);
    expect(replies).toHaveLength(1);
    expect(replies[0].taskId).toBe("task-1");
    expect(replies[0].activity.map((a: any) => a.kind)).toEqual([
      "text",
      "reasoning",
      "tool_call",
    ]);
    expect(replies[0].activity[0].content).toBe("working");
    // The reply goes to the requester only.
    expect(ws2.messages.length).toBe(before);
  });

  it("trims the dead attempt's partials out of the replay buffer on a mid-stream reset", async () => {
    // A real mid-stream retry shape: streamed text, a completed tool call,
    // the next attempt streams a partial, dies, resets, and the retry
    // re-streams from scratch.
    wsServer = makeServer([
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "kept " },
      { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "ls", toolCallId: "c1" },
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "dead " },
      { type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "dead-think" },
      { type: OUTPUT_EVENT.STREAM_RESET },
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "fresh take" },
    ]);
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    const handle = await tm!.spawnTask("task-1", "retry me", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 1000))]);

    // Live feed: the sentinel rides the same envelope between the dead
    // partial and the retry's deltas (that is what clears the panel).
    const kinds = messages(ws1)
      .filter((m) => m.type === S2C.TASK_ACTIVITY)
      .map((m) => m.activity.kind);
    expect(kinds).toEqual(["text", "tool_call", "text", "reasoning", "reset", "text"]);

    // Replay buffer: the sentinel is consumed as a trim, never stored, and
    // the trim stops at the tool block -- a rebuilt panel cannot see the
    // dead partial, and cannot receive a reset that would clear it.
    ws1.messages.length = 0;
    // Awaited: settled replies may ride the durable-log read; no log here,
    // so the exact buffer bytes below still answer (fallback path).
    await wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "task-1" }),
    );
    const replies = messages(ws1).filter((m) => m.type === S2C.TASK_ACTIVITY_HISTORY);
    expect(replies).toHaveLength(1);
    expect(replies[0].activity).toEqual([
      { kind: "text", content: "kept " },
      // The tool_call carries the posture fold (argsSummary, computed like
      // the session TOOL_CALL frame: no hints here, so the hint-free fold).
      { kind: "tool_call", name: "bash", args: "ls", argsSummary: "ls" },
      { kind: "text", content: "fresh take" },
    ]);
  });

  it("refuses cross-session and unknown task replays with an empty history", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    // Task owned by a DIFFERENT session id than ws1's.
    await tm!.spawnTask("task-other", "child of elsewhere", {
      managerAgent: { sessionId: "somewhere-else" },
    });

    ws1.messages.length = 0;
    wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "task-other" }),
    );
    wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "nope" }),
    );

    const replies = messages(ws1).filter((m) => m.type === S2C.TASK_ACTIVITY_HISTORY);
    expect(replies).toHaveLength(2);
    expect(replies[0].activity).toEqual([]);
    expect(replies[1].activity).toEqual([]);

    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST }));
    expect(ws1.messages.length).toBe(0);
  });
});

// ── The settled fold's user lane (unit) ─────────────────────────────────────
// A settled task's transcript authority is its worker's durable log, and that
// log is the ONE place a human follow-up survives: the live relay has no user
// lane (the worker's USER_MESSAGE event carries no provenance). Since the
// owner ruling of 2026-11-15 the lane also carries the delegated task prompt:
// the FIRST `input` entry -- whatever its origin, composed "model" prompts
// and legacy origin-less rows alike -- folds once as the leading user row.
// Everything behind it gates on provenance: origin "user" is a human steer,
// origin "harness" is injected fuel, and a later origin-less row is neither
// -- unknown is never guessed into a user row.

describe("taskActivityFromLogEntries -- the user lane (prompt-once + steering)", () => {
  it("leads with the delegated prompt once, then surfaces human follow-ups in log order", () => {
    const items = taskActivityFromLogEntries([
      { source: LOG_SOURCE.SESSION_START, role: "system", content: "" },
      // The composed task prompt: the first input, origin "model" -- the
      // leading row now, not an excluded entry.
      { source: LOG_SOURCE.INPUT, role: "user", content: "the delegating model's prompt", origin: "model" },
      { source: LOG_SOURCE.LLM, role: "assistant", content: "on it" },
      { source: LOG_SOURCE.INPUT, role: "user", content: "use the -la flag", origin: "user" },
      { source: LOG_SOURCE.LLM, role: "assistant", content: "rerunning" },
      // A second "model" input behind the prompt: another composed hand-off
      // is not a steer and not THE prompt -- it stays out.
      { source: LOG_SOURCE.INPUT, role: "user", content: "later model note", origin: "model" },
      { source: LOG_SOURCE.LLM, role: "assistant", content: "again" },
    ]);
    expect(items).toEqual([
      { kind: "user", content: "the delegating model's prompt" },
      { kind: "text", content: "on it" },
      { kind: "user", content: "use the -la flag" },
      { kind: "text", content: "rerunning" },
      { kind: "text", content: "again" },
    ]);
  });

  it("a legacy origin-less first input IS the prompt; later legacy rows stay out", () => {
    // Prompt-once covers pre-provenance logs: the first input is the
    // delegated prompt whatever its origin (or absence of one), and unknown
    // origins behind it are still never guessed into a user row.
    const items = taskActivityFromLogEntries([
      { source: LOG_SOURCE.INPUT, role: "user", content: "pre-provenance delegated prompt" },
      { source: LOG_SOURCE.LLM, role: "assistant", content: "working" },
      { source: LOG_SOURCE.INPUT, role: "user", content: "a second legacy row" },
    ]);
    expect(items).toEqual([
      { kind: "user", content: "pre-provenance delegated prompt" },
      { kind: "text", content: "working" },
    ]);
  });

  it("keeps harness fuel out of the user lane once the prompt row is taken", () => {
    const items = taskActivityFromLogEntries([
      { source: LOG_SOURCE.INPUT, role: "user", content: "the delegated prompt", origin: "model" },
      { source: LOG_SOURCE.INPUT, role: "user", content: "mid-run skill body", origin: "harness" },
      { source: LOG_SOURCE.INPUT, role: "user", content: "pre-provenance log row" },
      { source: LOG_SOURCE.LLM, role: "assistant", content: "answer" },
    ]);
    expect(items).toEqual([
      { kind: "user", content: "the delegated prompt" },
      { kind: "text", content: "answer" },
    ]);
  });

  it("applies the shared activity ceiling to the prompt row", () => {
    const items = taskActivityFromLogEntries([
      { source: LOG_SOURCE.INPUT, role: "user", content: "x".repeat(MAX_TASK_ACTIVITY_CHARS + 10), origin: "user" },
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as { content: string }).content).toBe(
      "x".repeat(MAX_TASK_ACTIVITY_CHARS) + "...[truncated]",
    );
  });
});

// ── The settled fold's usage footer (derivation parity, unit) ──────────────
// Owner ruling 2026-11-15: the settled task transcript carries the same
// response footer the session view of the SAME log shows -- clock time, ctx
// gauge, producing-call time, turn total. The fold therefore derives every
// number from the session cold-log primitives (@utils/session-turns.ts) over
// the same entries, and stamps the result as a `usage` item on the llm entry
// it closes. A task's transcript IS that log's session view, so the fold's
// numbers must equal the primitives' numbers by construction -- pinned here
// against the primitives run directly on the fixture, plus literal expected
// values so a drift in EITHER side fails.

describe("taskActivityFromLogEntries -- the usage footer", () => {
  // A two-call turn bracketed by turn markers. The first call's usage record
  // carries durationMs (recorded posture); the second is the old record shape
  // without it, so the strict-adjacency log-gap derivation (tool_result ->
  // llm, nothing intervening) has to carry the call segment instead.
  const T = (s: string) => new Date(s).getTime();
  const footerEntries = (): Array<{ source?: unknown } & Record<string, unknown>> => [
    { source: "input", role: "user", content: "the delegated prompt", origin: "model", ts: "2026-11-15T00:00:00.000Z" },
    { source: "turn_started", content: { kind: "input" }, ts: "2026-11-15T00:00:00.500Z" },
    {
      source: "llm",
      role: "assistant",
      content: "first prose",
      reasoning_content: null,
      tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      ts: "2026-11-15T00:00:03.500Z",
    },
    {
      source: "token_usage",
      content: "",
      totalTokens: 62000,
      contextWindow: 262000,
      cachedTokens: 40000,
      promptTokens: 20000,
      completionTokens: 2000,
      durationMs: 3000,
      ts: "2026-11-15T00:00:03.600Z",
    },
    { source: "tool_result", role: "tool", tool_call_id: "c1", tool_name: "bash", content: "a file", ts: "2026-11-15T00:00:04.000Z" },
    { source: "llm", role: "assistant", content: "FINAL", reasoning_content: null, tool_calls: null, ts: "2026-11-15T00:07:41.000Z" },
    {
      source: "token_usage",
      content: "",
      totalTokens: 63000,
      contextWindow: 262000,
      cachedTokens: 41000,
      promptTokens: 21000,
      completionTokens: 1000,
      ts: "2026-11-15T00:07:41.100Z",
    },
    { source: "turn_end", content: { status: "completed" }, ts: "2026-11-15T00:07:42.000Z" },
  ];

  it("stamps one usage item per attested call, in relay order, with the session-side numbers", () => {
    const entries = footerEntries();
    const items = taskActivityFromLogEntries(entries);
    // reasoning -> text -> usage -> calls: the live sink's own order.
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "text",
      "usage",
      "tool_call",
      "tool_result",
      "text",
      "usage",
    ]);
    const first = items[2] as Extract<TaskActivityWire, { kind: "usage" }>;
    const second = items[6] as Extract<TaskActivityWire, { kind: "usage" }>;
    // Literal footer numbers (the session footer's grammar: used/total gauge,
    // recorded call time, no turn total for a mid-turn round).
    expect(first).toEqual({
      kind: "usage",
      ts: T("2026-11-15T00:00:03.500Z"),
      ctx: { used: 62000, total: 262000, cached: 40000, prompt: 20000, completion: 2000 },
      callMs: 3000,
    });
    // The turn closer carries the bracket total; its call time is the
    // derivation (no recorded durationMs), flagged as derived.
    expect(second).toEqual({
      kind: "usage",
      ts: T("2026-11-15T00:07:41.000Z"),
      durationMs: T("2026-11-15T00:07:42.000Z") - T("2026-11-15T00:00:00.500Z"),
      ctx: { used: 63000, total: 262000, cached: 41000, prompt: 21000, completion: 1000 },
      callMs: T("2026-11-15T00:07:41.000Z") - T("2026-11-15T00:00:04.000Z"),
      callDerived: true,
    });
    // PARITY, mechanically: the same primitives the session cold view runs
    // over these entries yield the same gauge, turn total and derivation.
    const ctxs = ctxByIndex(entries as never);
    const turnMs = turnFinalDurationsByIndex(entries as never);
    const derivedMs = deriveCallDurationsByIndex(entries as never);
    const { callMs: _c1, ...gauge2 } = ctxs[2]!;
    const { callMs: _c2, ...gauge5 } = ctxs[5]!;
    expect(first.ctx).toEqual(gauge2);
    expect(first.callMs).toBe(ctxs[2]!.callMs);
    expect(second.ctx).toEqual(gauge5);
    expect(second.callMs).toBe(derivedMs[5]);
    expect(second.durationMs).toBe(turnMs[5]);
    expect(turnMs[2]).toBeUndefined();
  });

  it("absent or unattested usage means NO usage item: the transcript renders exactly as before", () => {
    // No records at all, and records whose gauge the provider kept private
    // (totalTokens 0 -- ctxByIndex claims nothing): inventing a footer
    // segment is not on the table.
    const items = taskActivityFromLogEntries([
      { source: "input", role: "user", content: "prompt", origin: "model", ts: "2026-11-15T00:00:00.000Z" },
      { source: "turn_started", content: { kind: "input" }, ts: "2026-11-15T00:00:00.500Z" },
      { source: "llm", role: "assistant", content: "quiet provider", tool_calls: null, ts: "2026-11-15T00:00:02.000Z" },
      { source: "token_usage", content: "", totalTokens: 0, contextWindow: 0, ts: "2026-11-15T00:00:02.100Z" },
      { source: "llm", role: "assistant", content: "no records ever", tool_calls: null, ts: "2026-11-15T00:00:05.000Z" },
      { source: "turn_end", content: { status: "completed" }, ts: "2026-11-15T00:00:05.500Z" },
    ]);
    expect(items).toEqual([
      { kind: "user", content: "prompt" },
      { kind: "text", content: "quiet provider" },
      { kind: "text", content: "no records ever" },
    ]);
  });

  it("omits footer fields the log did not attest, never zeroing or borrowing them", () => {
    // Usage WITHOUT durationMs and WITHOUT a derivable gap (a turn marker
    // sits between the trigger and the llm entry): the call segment stays
    // off. An llm entry with no ts carries no clock segment either -- the
    // client footer refuses to render time it cannot trust.
    const items = taskActivityFromLogEntries([
      { source: "turn_started", content: { kind: "input" }, ts: "2026-11-15T00:00:00.000Z" },
      { source: "tool_result", role: "tool", tool_call_id: "c1", tool_name: "bash", content: "ok", ts: "2026-11-15T00:00:01.000Z" },
      { source: "session_state", key: "working", value: true, ts: "2026-11-15T00:00:01.200Z" },
      { source: "llm", role: "assistant", content: "no clock", tool_calls: null },
      { source: "token_usage", content: "", totalTokens: 1200, ts: "2026-11-15T00:00:02.000Z" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool_result", "text", "usage"]);
    expect(items[2]).toEqual({ kind: "usage", ctx: { used: 1200 } });
  });
});
