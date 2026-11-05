// Sidebar row payload on the SESSIONS wire: the live row grammar's ctx
// numbers (last token_usage snapshot cached in the registry) and their
// omission until the session's first usage. Existing LIST_SESSIONS pins in
// websocket-server.test.ts stay untouched; this file adds the new fields.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { TMP_PARENT } from "../mocks/io.ts";
import { join } from "node:path";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { sessionCreatedPayload } from "@extensions/websocket/session-created.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { HOOKS } from "@core/hooks.ts";
import { closeSessionIndex, getSessionRow, syncSessionFromLog } from "@core/session/session-index.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const authStub = undefined as unknown as AuthMiddleware;
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeTitleRegistry(agent: AgentLike): SessionRegistry {
  // toolExecResolved mirrors the boot resolved bag (as the real server wires
  // it): sessionCreatedPayload reads the tool-exec posture from it.
  return new SessionRegistry({
    buildAgent: async () => agent,
    toolExecResolved: { toolExec: "inline", execFence: "probe" },
  });
}

function makeRegistry(agent: AgentLike): SessionRegistry {
  return new SessionRegistry({
    buildAgent: async () => agent,
  });
}

/** Drive a full token_usage event through the session's event bus. */
function emitUsage(registry: SessionRegistry, sessionId: string, totalTokens: number, contextWindow: number): void {
  registry
    .getSessionManager()
    .emitToChannels(sessionId, {
      type: OUTPUT_EVENT.TOKEN_USAGE,
      sessionPromptTokens: 10,
      sessionCachedTokens: 0,
      sessionCompletionTokens: 2,
      sessionTotalTokens: totalTokens,
      turns: 1,
      promptTokens: totalTokens - 2,
      cachedTokens: 0,
      completionTokens: 2,
      totalTokens,
      contextWindow,
    } as never);
}

async function listSessionsViaWire(registry: SessionRegistry): Promise<Array<Record<string, unknown>>> {
  const ws = createWsMockWs();
  await routeMessage(ws, { type: C2S.LIST_SESSIONS } as never, registry, authStub, bridgeStub, coreStub);
  await flush();
  const msg = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
    type: string;
    sessions: Array<Record<string, unknown>>;
  };
  expect(msg.type).toBe(S2C.SESSIONS);
  return msg.sessions;
}

describe("SESSIONS rows: sidebar ctx payload", () => {
  it("carries ctxUsed/ctxTotal once a token_usage event lands", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-live" }));
    await registry.create({ profile: "manager" });

    emitUsage(registry, "ctx-live", 69000, 262144);

    const rows = await listSessionsViaWire(registry);
    const row = rows.find((r) => r.id === "ctx-live")!;
    expect(row.ctxUsed).toBe(69000);
    expect(row.ctxTotal).toBe(262144);
    // The grammar's other live slots stay on the wire unchanged. The
    // messageCount is the writer-side record tally: registered with no log
    // records yet, it is the honest 0 (seeded, not fabricated).
    expect(row.profile).toBe("manager");
    expect(row.connectedClients).toBe(0);
    expect(row.messageCount).toBe(0);
  });

  it("later usage events replace the snapshot (last usage wins)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-two" }));
    await registry.create();

    emitUsage(registry, "ctx-two", 1000, 131072);
    emitUsage(registry, "ctx-two", 2222, 262144);

    const row = (await listSessionsViaWire(registry)).find((r) => r.id === "ctx-two")!;
    expect(row.ctxUsed).toBe(2222);
    expect(row.ctxTotal).toBe(262144);
  });

  it("sessions with no usage yet omit the ctx fields outright", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-none" }));
    await registry.create();

    const row = (await listSessionsViaWire(registry)).find((r) => r.id === "ctx-none")!;
    expect("ctxUsed" in row).toBe(false);
    expect("ctxTotal" in row).toBe(false);
  });

  it("registry.list() exposes the same fields (the SESSIONS builders share it)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-direct" }));
    await registry.create();
    emitUsage(registry, "ctx-direct", 4242, 8192);

    const entry = registry.list().find((s) => s.id === "ctx-direct")!;
    expect(entry.ctxUsed).toBe(4242);
    expect(entry.ctxTotal).toBe(8192);

    registry.delete("ctx-direct");
    expect(registry.list().find((s) => s.id === "ctx-direct")).toBeUndefined();
  });
});

// ── logPath on both list payloads ──────────────────────────────────────────
// The sidebar's "Copy log file path" needs the server-side absolute path,
// computed via the core session-path helper (never re-joined client-side).
// Live rows (SESSIONS) and cold rows (LOGS_LISTED) both carry it.

describe("SESSIONS/LOGS_LISTED rows: logPath", () => {
  const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-sidebar-logpath-"));
  const COLD_ID = "cold-log-row";
  let prevSessionsDir: string | undefined;

  beforeAll(() => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = TMP;
    writeFileSync(
      join(TMP, `${COLD_ID}.jsonl`),
      JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: COLD_ID, source: "input", content: "hi" }) + "\n",
    );
  });

  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("live rows carry logPath on the SESSIONS wire and in registry.list()", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "path-live" }));
    await registry.create({ profile: "manager" });

    const row = (await listSessionsViaWire(registry)).find((r) => r.id === "path-live")!;
    expect(row.logPath).toBe(join(TMP, "path-live.jsonl"));
    expect(registry.list().find((s) => s.id === "path-live")!.logPath).toBe(join(TMP, "path-live.jsonl"));

    registry.delete("path-live");
  });

  it("cold rows carry logPath on LOGS_LISTED; live ids stay filtered out", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "path-live-2" }));
    await registry.create({ profile: "manager" });

    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.LIST_LOGS } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const msg = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
      type: string;
      logs: Array<Record<string, unknown>>;
    };
    expect(msg.type).toBe(S2C.LOGS_LISTED);
    const cold = msg.logs.find((l) => l.id === COLD_ID)!;
    expect(cold.logPath).toBe(join(TMP, `${COLD_ID}.jsonl`));
    // The dir-scan fields stay put alongside the new one.
    expect(cold.messageCount).toBe(1);
    expect(msg.logs.find((l) => l.id === "path-live-2")).toBeUndefined();

    registry.delete("path-live-2");
  });
});

// ── LOGS_LISTED rows: derived title passthrough ─────────────────────────────
// Cold rows surface the index's heuristic title (see deriveTitleFromMessages)
// so the sidebar's middle line has data for logs that never had a rename.

describe("LOGS_LISTED rows: derived title", () => {
  const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-cold-title-"));
  let prevSessionsDir: string | undefined;

  beforeAll(async () => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = TMP;
    const mk = (id: string, content: unknown) =>
      writeFileSync(
        join(TMP, `${id}.jsonl`),
        JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: id, source: "input", content }) + "\n",
      );
    mk("titled-log", "summarize the sidebar row grammar");
    mk("deadbeat-log", "hi");
    await syncSessionFromLog("titled-log");
    await syncSessionFromLog("deadbeat-log");
  });

  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("carries the title when the index derived one; omits it when the log is deadbeat", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "not-cold" }));
    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.LIST_LOGS } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const msg = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
      type: string;
      logs: Array<Record<string, unknown>>;
    };
    expect(msg.type).toBe(S2C.LOGS_LISTED);
    expect(msg.logs.find((l) => l.id === "titled-log")!.title).toBe("Summarize the sidebar row grammar");
    expect("title" in (msg.logs.find((l) => l.id === "deadbeat-log") as Record<string, unknown>)).toBe(false);
  });
});

describe("SESSIONS rows: questionPending badge flag", () => {
  it("defaults false, mirrors setQuestionPending, and only signals real transitions", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "q-live" }));
    await registry.create({ profile: "manager" });

    const find = async () =>
      (await listSessionsViaWire(registry)).find((r) => r.id === "q-live")!;

    expect((await find()).questionPending).toBe(false);

    // Real transition -> true; the repeat is a no-op (no broadcast fuel).
    expect(registry.setQuestionPending("q-live", true)).toBe(true);
    expect(registry.setQuestionPending("q-live", true)).toBe(false);
    expect((await find()).questionPending).toBe(true);

    expect(registry.setQuestionPending("q-live", false)).toBe(true);
    expect((await find()).questionPending).toBe(false);

    // Unknown ids are ignored outright.
    expect(registry.setQuestionPending("ghost", true)).toBe(false);
  });
});

// ── SESSIONS rows: live derived title ───────────────────────────────────────
// The registry surfaces the index's derived title on live rows (rename in
// meta wins > derived row title > nothing), and a live user message titles
// its untitled row exactly once, rebroadcasting the sidebar on the hit.

describe("SESSIONS rows: live derived title", () => {
  const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-live-title-ws-"));
  let prevSessionsDir: string | undefined;

  beforeAll(async () => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = TMP;
    const mk = async (id: string, content: string) => {
      writeFileSync(
        join(TMP, `${id}.jsonl`),
        JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: id, source: "input", content }) + "\n",
      );
      await syncSessionFromLog(id);
    };
    await mk("adopt-titled", "summarize the cold adoption flow");
    await mk("live-hook", "hi"); // deadbeat: row exists, title null
  });

  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
    closeSessionIndex();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("cold adoption surfaces the row title on list() and session_created", async () => {
    const registry = makeTitleRegistry(makeWsMockAgent({ sessionId: "adopt-titled" }));
    await registry.create({ sessionId: "adopt-titled" });

    expect(registry.list().find((s) => s.id === "adopt-titled")!.title).toBe(
      "Summarize the cold adoption flow",
    );
    expect(sessionCreatedPayload(registry, "adopt-titled").title).toBe(
      "Summarize the cold adoption flow",
    );
    registry.delete("adopt-titled");
  });

  it("a rename (in-memory meta) wins over the derived row title", async () => {
    const registry = makeTitleRegistry(makeWsMockAgent({ sessionId: "adopt-titled" }));
    await registry.create({ sessionId: "adopt-titled" });
    expect(registry.rename("adopt-titled", "My careful name")).toBe(true);

    expect(registry.list().find((s) => s.id === "adopt-titled")!.title).toBe("My careful name");
    expect(sessionCreatedPayload(registry, "adopt-titled").title).toBe("My careful name");
    // The row keeps the derived value: renames never write to the index.
    expect(getSessionRow("adopt-titled")!.title).toBe("Summarize the cold adoption flow");
    registry.delete("adopt-titled");
  });

  it("CONTEXT_MESSAGE titles an untitled live row once; only real hits broadcast", async () => {
    // A hooks.on-capable stand-in (the shared mock's hooks lack .on, which
    // the tracker's guard tolerates; here we need the registration seam).
    const registered: Record<string, Array<(d: unknown) => unknown>> = {};
    const agent = makeWsMockAgent({
      sessionId: "live-hook",
      hooks: {
        on: (name: string, handler: (d: unknown) => unknown) => {
          (registered[name] ||= []).push(handler);
          return () => {};
        },
        notifyHooks: () => {},
        runHookPipeline: async () => undefined,
        registerHook: () => {},
        unregisterHook: () => {},
      } as never,
    });
    const registry = makeTitleRegistry(agent);
    await registry.create({ sessionId: "live-hook" });
    const ws = createWsMockWs();
    registry.registerConnection(ws);
    const ctxHandlers = registered[HOOKS.CONTEXT_MESSAGE]!;
    const fire = (message: unknown) => {
      for (const h of ctxHandlers) h({ message });
    };

    expect(getSessionRow("live-hook")!.title).toBeNull();

    fire({ role: "user", content: "polish the live title mirror" });
    expect(getSessionRow("live-hook")!.title).toBe("Polish the live title mirror");
    const bcast = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
      type: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(bcast.type).toBe(S2C.SESSIONS);
    expect(bcast.sessions.find((s) => s.id === "live-hook")!.title).toBe(
      "Polish the live title mirror",
    );
    const bcastCount = ws.messages.filter((m) => JSON.parse(m).type === S2C.SESSIONS).length;

    // Set-once: a later title-worthy ask changes nothing and renews nothing.
    fire({ role: "user", content: "rename the mirror again please" });
    expect(getSessionRow("live-hook")!.title).toBe("Polish the live title mirror");
    expect(
      ws.messages.filter((m) => JSON.parse(m).type === S2C.SESSIONS).length,
    ).toBe(bcastCount);

    // Deadbeat user input and harness-role messages never title or broadcast.
    fire({ role: "tool", content: "rename the mirror once more" });
    fire({ role: "user", content: "ok" });
    expect(
      ws.messages.filter((m) => JSON.parse(m).type === S2C.SESSIONS).length,
    ).toBe(bcastCount);

    registry.delete("live-hook");
  });
});
