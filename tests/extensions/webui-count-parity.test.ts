// Live-vs-cold sidebar count parity (the owner bug): the SESSIONS payload's
// live-row messageCount must equal what listSessionLogs reports for the same
// session's log at the same moment. The mechanism: the session-log writer is
// the single chokepoint (record-count.ts counts committed records under
// core's one message rule -- conversation records only), seeded once per
// registration from the existing log. These pins drive a scripted agent (the
// hook sequence a real Agent.run fires) through the real ws server, the real
// SessionRegistry, and the real session-log extension against a temp
// sessions dir.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { create as createSessionLogExt } from "@extensions/session-log/index.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { listSessionLogs } from "@core/session/session-log.ts";
import { HOOKS } from "@core/hooks.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { createWsMockCore, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";
import { TMP_PARENT } from "../mocks/io.ts";

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-count-parity-"));
const logFile = (id: string) => join(SESSIONS_DIR, `${id}.jsonl`);

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

type MockWs = ReturnType<typeof createWsMockWs>;

async function waitForMessage(ws: MockWs, type: string, opts: { timeoutMs?: number; after?: number } = {}): Promise<any> {
  const { timeoutMs = 2000, after = 0 } = opts;
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .slice(after)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === type);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${type} message`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A ws server whose mock agents fire the real session-log extension's hooks
 * exactly where the real Agent fires them, and whose run() scripts one
 * input turn with a tool round and an assistant tail:
 *   turn_started, input, llm(+tool_calls), tool_started, tool_result, llm
 *   tail, turn_end  -> 7 written records, 3 counted (input + both llms:
 *   the sidebar rule counts conversation messages only).
 */
async function harness() {
  const core = createWsMockCore();
  const ext = (await createSessionLogExt(core as never)) as unknown as {
    hooks: Record<string, (p: unknown) => Promise<void>>;
  };
  const writes: Promise<unknown>[] = [];
  const server = createWsServer(core, {
    buildAgent: async (cfg: { model?: string; sessionId?: string }) => {
      const agent: any = makeWsMockAgent({ sessionId: cfg.sessionId || "parity-anon" });
      const step = async (name: string, payload: unknown) => {
        const h = ext.hooks[name];
        if (!h) return;
        const p = Promise.resolve().then(() => h(payload));
        writes.push(p);
        await p;
      };
      agent.hooks = {
        notifyHooks: async (name: string, payload: unknown) => { await step(name, payload); },
        runHookPipeline: async () => ({}),
      };
      agent.emitOutput = (type: string, data: Record<string, unknown>) => {
        const handler = ext.hooks[HOOKS.OUTPUT_EVENT];
        if (handler) writes.push(Promise.resolve().then(() => handler({ type, data, agent })));
      };
      agent.run = async (content: unknown) => {
        const text = typeof content === "string" ? content : JSON.stringify(content);
        const msg = (over: Record<string, unknown>) => ({
          message: { sessionId: agent.sessionId, ...over },
          agent,
        });
        await step(HOOKS.TURN_START, { turnIndex: 1, kind: "input", agent });
        await step(HOOKS.CONTEXT_MESSAGE, msg({ role: "user", content: text }));
        await step(HOOKS.CONTEXT_MESSAGE, msg({
          role: "assistant",
          content: "calling the tool",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }));
        await step(HOOKS.TOOL_BEFORE_EXECUTE, { toolCallId: "c1", toolName: "bash", input: "{}", agent });
        await step(HOOKS.CONTEXT_MESSAGE, msg({ role: "tool", content: "ok", toolCallId: "c1" }));
        await step(HOOKS.CONTEXT_MESSAGE, msg({ role: "assistant", content: "done: ok" }));
        await step(HOOKS.TURN_END, { stopped: true, reason: "completion", agent });
      };
      return agent;
    },
  });

  const settle = async () => {
    for (let round = 0; round < 4; round++) {
      const batch = writes.splice(0);
      if (batch.length === 0) return;
      await Promise.all(batch.map((p) => p.catch(() => undefined)));
    }
  };

  const isRunning = (sessionId: string) =>
    server.sessionRegistry.getSessionManager().isSessionRunning(sessionId);

  /** Send via the wire (handleSend -> bus -> scripted run) and settle. */
  const send = async (ws: MockWs, sessionId: string, text: string) => {
    server.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId, content: text }));
    const start = Date.now();
    while (!isRunning(sessionId) && writes.length === 0) {
      if (Date.now() - start > 2000) throw new Error(`turn for ${sessionId} never started`);
      await new Promise((r) => setTimeout(r, 2));
    }
    while (isRunning(sessionId) || writes.length > 0) {
      await settle();
      await new Promise((r) => setTimeout(r, 2));
    }
    await settle();
  };

  /** The live SESSIONS payload (C2S listSessions -> S2C sessions frame). */
  const liveRows = async (ws: MockWs): Promise<Array<Record<string, unknown>>> => {
    const after = ws.messages.length;
    server.onMessage(ws, JSON.stringify({ type: C2S.LIST_SESSIONS }));
    const msg = await waitForMessage(ws, S2C.SESSIONS, { after });
    return msg.sessions;
  };

  const coldCount = async (sessionId: string): Promise<number | undefined> =>
    (await listSessionLogs()).find((l) => l.id === sessionId)?.messageCount;

  return { server, ws: createWsMockWs(), send, liveRows, coldCount, settle, writes };
}

describe("live sidebar count == listSessionLogs (parity contract)", () => {
  it("equals the cold messageCount after a scripted user turn with a tool round", async () => {
    const h = await harness();
    try {
      const { sessionId } = await h.server.sessionRegistry.create({});
      await h.send(h.ws, sessionId, "hello");

      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      // Of the turn's 7 records only the conversation ones count: input,
      // llm(+tool_calls), llm tail.
      expect(cold).toBe(3);
      expect(row.messageCount).toBe(cold);
      // The wire renamed in lockstep: the user-only field is gone.
      expect("userMessageCount" in row).toBe(false);
    } finally {
      h.server.stopCleanupLoop();
    }
  });

  it("repeated sends grow both numbers identically (no registry-side double count)", async () => {
    const h = await harness();
    try {
      const { sessionId } = await h.server.sessionRegistry.create({});
      await h.send(h.ws, sessionId, "first");
      // Each send drives one scripted turn (7 written records, 3 counted).
      // The removed registry.incrementUserMessageCount seam used to add an
      // eighth, user-only phantom per send -- parity would break on every
      // row below.
      await h.send(h.ws, sessionId, "second");
      await h.send(h.ws, sessionId, "third");

      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      expect(cold).toBe(9);
      expect(row.messageCount).toBe(cold);
    } finally {
      h.server.stopCleanupLoop();
    }
  });

  it("stays equal after a compaction record lands", async () => {
    const h = await harness();
    try {
      const { sessionId } = await h.server.sessionRegistry.create({});
      await h.send(h.ws, sessionId, "long story");

      // The compaction_result output event writes one compaction record.
      const agent = h.server.sessionRegistry.getSessionManager().getAgentBySessionId(sessionId)!;
      (agent as any).emitOutput("compaction_result", { summary: "a summary", messagesCompacted: 5 });
      await h.settle();

      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      expect(cold).toBe(3); // the compaction record lands but never counts
      expect(row.messageCount).toBe(cold);
    } finally {
      h.server.stopCleanupLoop();
    }
  });

  it("stays equal after a mid-turn rewind checkpoint (reset excluded, kept history re-counted, marker re-emitted)", async () => {
    const h = await harness();
    try {
      const { sessionId } = await h.server.sessionRegistry.create({});
      const agent = h.server.sessionRegistry.getSessionManager().getAgentBySessionId(sessionId) as any;
      // Open a turn without ending it (the openTurns state the re-emit keys on).
      await agent.hooks.notifyHooks(HOOKS.TURN_START, { turnIndex: 1, kind: "input", agent });
      await agent.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, {
        message: { sessionId, role: "user", content: "undo me soon" },
        agent,
      });
      // Rewind to a context of two kept messages: the writer appends reset
      // (never counted) + the kept messages (counted again, they are new
      // file records) + the re-emitted turn_started marker (bookkeeping,
      // never counted).
      await agent.hooks.notifyHooks(HOOKS.CONTEXT_REWOUND, {
        agent,
        newContext: [
          { sessionId, role: "user", content: "kept input" },
          { sessionId, role: "assistant", content: "kept reply" },
        ],
      });
      await h.settle();

      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      // input, kept input, kept llm = 3 (turn markers and the reset stay out)
      expect(cold).toBe(3);
      expect(row.messageCount).toBe(cold);
    } finally {
      h.server.stopCleanupLoop();
    }
  });

  it("seeds from the existing log at registration (resume/new-session over a file, not 0)", async () => {
    const h = await harness();
    const logId = `parity-seed-${Date.now()}`;
    try {
      // History a cold read counts as 2: only the conversation records
      // (the input and the llm reply) count -- the system_prompt, the reset
      // marker and the turn_started bookkeeping stay out, including history
      // above the reset.
      writeFileSync(logFile(logId), [
        { ts: "2024-01-01T00:00:00Z", session_id: logId, source: "system_prompt", content: "p" },
        { ts: "2024-01-01T00:00:01Z", session_id: logId, source: "input", content: "u1" },
        { ts: "2024-01-01T00:00:02Z", session_id: logId, source: "llm", content: "a1" },
        { ts: "2024-01-01T00:00:03Z", session_id: logId, source: "reset", content: "" },
        { ts: "2024-01-01T00:00:04Z", session_id: logId, source: "turn_started", content: { kind: "input" } },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n");

      const { sessionId } = await h.server.sessionRegistry.create({ sessionId: logId });
      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      expect(sessionId).toBe(logId);
      expect(cold).toBe(2);
      // The live row starts at the log's count -- not 0.
      expect(row.messageCount).toBe(2);
      expect(row.messageCount).toBe(cold);
    } finally {
      h.server.stopCleanupLoop();
      try { rmSync(logFile(logId), { force: true }); } catch {}
    }
  });

  it("degrades honestly when the log goes unwritable (count never outruns the file)", async () => {
    const h = await harness();
    const logId = `parity-locked-${Date.now()}`;
    try {
      const { sessionId } = await h.server.sessionRegistry.create({ sessionId: logId });
      await h.send(h.ws, sessionId, "committed");
      const before = await h.coldCount(sessionId);
      expect(before).toBe(3);

      // Freeze the file: every further append fails, so nothing new counts --
      // mirroring exactly what a cold read of the same file would report.
      chmodSync(logFile(logId), 0o444);
      const agent = h.server.sessionRegistry.getSessionManager().getAgentBySessionId(sessionId) as any;
      await agent.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, {
        message: { sessionId, role: "user", content: "never lands" },
        agent,
      }).catch(() => {});
      await h.settle();

      const row = (await h.liveRows(h.ws)).find((r) => r.id === sessionId)!;
      const cold = await h.coldCount(sessionId);
      expect(cold).toBe(3);
      expect(row.messageCount).toBe(3);
      expect(row.messageCount).toBe(cold);
    } finally {
      h.server.stopCleanupLoop();
      try { chmodSync(logFile(logId), 0o644); } catch {}
      try { rmSync(logFile(logId), { force: true }); } catch {}
    }
  });
});
