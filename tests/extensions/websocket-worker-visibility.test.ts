// B5: worker-log visibility on the COLD side (R4/D7 -- hidden from the live
// list AND Recent Logs, search reaches, unattested stays plain-visible) plus
// D6 promotion made durable and D8 pin honesty.
//
// Pins (design section (e) B5 + (d) "Resume of a worker session from a cold
// log"):
// - a log the sidecar attests as a worker (ev:"agent" join) is ABSENT from
//   LOGS_LISTED, from the boot fixture AND -- the batch's centerpiece -- from
//   a current-process spawn with NO restart (the boot-cache gap; the
//   once-cached lineage view stays stale while joinedAgentSessionIds answers
//   from the live set);
// - unattested logs (no sidecar, torn agent line) ride the list plain
//   (honest non-claim, the spawn-log sidecar doctrine);
// - exclusion is the LIST ONLY: viewLog/loadOlder/search keep reaching the
//   worker log by id; a search hit carries the additive `subagentOf` label;
// - manual Continue (handleLoadLog) PROMOTES: interactive live row (kind
//   absent), pinnable, and after going cold again the log reappears as a
//   plain row -- surviving a simulated restart via the append-only
//   ev:"promote" sidecar line. Auto/reconnect adoption does NOT promote.
// - a pin persisted on an excluded worker id is pruned on the list-build
//   path; a promoted session's pin survives.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { TMP_PARENT } from "../mocks/io.ts";
import { SpawnLog } from "@core/session/spawn-log.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { closeSessionIndex } from "@core/session/session-index.ts";
import {
  coldLogsPayload,
  handleListLogs,
  handleLoadLog,
  handleLoadOlder,
  handleViewLog,
  searchSessionLogs,
} from "@extensions/websocket/handlers-logs.ts";
import { handleSetPinned, handleDeleteSession } from "@extensions/websocket/handlers-sessions.ts";
import { handleSend, handleCancel } from "@extensions/websocket/handlers-send.ts";
import { handleQuestionAnswer } from "@extensions/websocket/handlers-tasks.ts";
import { HOOKS } from "@core/hooks.ts";
import { attachResumedSession } from "@extensions/websocket/attach.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { closePinStore, getPinnedIds, isPinned, setPinned } from "@extensions/websocket/pin-store.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const SPAWN = Date.parse("2026-11-14T10:00:00.000Z");
const END = Date.parse("2026-11-14T10:10:00.000Z");

const SESSIONS = mkdtempSync(join(TMP_PARENT, "hotdog-vis-sessions-"));
const SIDECARS = mkdtempSync(join(TMP_PARENT, "hotdog-vis-sidecars-"));

// Fire-and-forget sidecar writes: poll until the line lands (the doctrine
// the lineage suites already use).
async function waitForFileText(path: string, needle: string): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {}
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${path}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function sidecar(name: string, lines: Array<Record<string, unknown>>, raw = ""): string {
  const path = join(SIDECARS, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + raw);
  return path;
}

function spawnLine(over: Record<string, unknown>): Record<string, unknown> {
  return { t: new Date(SPAWN).toISOString(), ev: "spawn", pid: 777, host: hostname(), ...over };
}

function manager(path: string | null): TaskManager {
  return new TaskManager({
    buildAgent: async () => ({ sessionId: "w", run: async () => undefined, notifyCompletion: () => {} }) as never,
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
    spawnLogPath: path,
    spawnLogPidAlive: () => false, // a fresh lifetime over the old sidecar
  });
}

function registryFor(tm: TaskManager | null): SessionRegistry {
  const registry = new SessionRegistry({
    buildAgent: async (config: { sessionId?: string }) =>
      makeWsMockAgent({ sessionId: config.sessionId || "fresh-1" }),
    // The boot resolved bag the real server hands over (a bare {} would
    // make the sessionCreated posture read reject).
    toolExecResolved: { toolExec: "inline", execFence: "probe" },
  });
  if (tm) registry.setTaskManager(tm);
  return registry;
}

const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

function ctxFor(
  registry: SessionRegistry,
  msg: Record<string, unknown>,
  ws = createWsMockWs(),
): { ctx: any; ws: ReturnType<typeof createWsMockWs> } {
  return {
    ctx: { ws, msg, registry, authMiddleware: undefined, bridge: bridgeStub, core: coreStub },
    ws,
  };
}

function frames(ws: ReturnType<typeof createWsMockWs>): Array<Record<string, unknown>> {
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

const mkLog = (id: string, content = "hi") =>
  writeFileSync(
    join(SESSIONS, `${id}.jsonl`),
    JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: id, source: "input", content }) + "\n",
  );

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS;
  closeSessionIndex();
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  closePinStore();
  try { rmSync(SESSIONS, { recursive: true, force: true }); } catch {}
  try { rmSync(SIDECARS, { recursive: true, force: true }); } catch {}
});

// ── SpawnLog: the joined-set semantics (boot UNION live, minus promoted) ───

describe("SpawnLog.joinedAgentSessionIds", () => {
  it("boot lineage attestation joins; a torn or stray agent line claims nothing", async () => {
    const path = sidecar(
      "joined-boot",
      [
        spawnLine({ id: "t-ok", desc: "d", session: "mgr" }),
        { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "t-ok", agent: "w-attested" },
        { t: new Date(END).toISOString(), ev: "end", id: "t-ok", outcome: "completed" },
        // A torn agent line: skipped, no join (honest non-claim).
        { t: new Date(SPAWN).toISOString(), ev: "spawn", id: "t-torn", desc: "d", session: "mgr", pid: 778, host: hostname() },
      ],
      '{"t":"2026-11-14T10:00:01.000Z","ev":"agent","id":"t-torn","agent":"w-tor', // truncated
    );
    const sl = new SpawnLog(path, () => false);
    const joined = await sl.joinedAgentSessionIds();
    expect(joined.has("w-attested")).toBe(true);
    expect(joined.has("w-torn")).toBe(false);
  });

  it("the boot-cache gap closes: a join recorded AFTER the lineage cache builds is joined without restart", async () => {
    const path = sidecar("joined-live", [spawnLine({ id: "t-boot", desc: "d", session: "mgr" })]);
    const sl = new SpawnLog(path, () => false);
    // Warm the boot cache BEFORE the live spawn (the boot-snapshot doctrine).
    await sl.lineage();
    sl.recordSpawn({ taskId: "t-now", description: "live join", sessionId: "mgr" });
    sl.recordAgent("t-now", "w-live");
    // The stale boot view proves the gap exists at the lineage layer...
    const boot = await sl.lineage();
    expect(boot.some((r) => r.taskId === "t-now")).toBe(false);
    // ...while the union answers with no restart.
    const joined = await sl.joinedAgentSessionIds();
    expect(joined.has("w-live")).toBe(true);
    await waitForFileText(path, '"w-live"'); // the append itself still lands
  });

  it("promotions subtract on both sides; the promote line survives a fresh lifetime", async () => {
    const path = sidecar("joined-promote", [
      spawnLine({ id: "t-p", desc: "d", session: "mgr" }),
      { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "t-p", agent: "w-p" },
      { t: new Date(END).toISOString(), ev: "end", id: "t-p", outcome: "completed" },
    ]);
    const sl = new SpawnLog(path, () => false);
    expect((await sl.joinedAgentSessionIds()).has("w-p")).toBe(true);
    sl.recordPromote("w-p");
    expect((await sl.joinedAgentSessionIds()).has("w-p")).toBe(false); // in-memory, no re-read
    await waitForFileText(path, '"ev":"promote"');
    // Restart simulation: a fresh lifetime reads the promote line from boot.
    const sl2 = new SpawnLog(path, () => false);
    expect((await sl2.joinedAgentSessionIds()).has("w-p")).toBe(false);
  });
});

// ── TaskManager passthroughs ────────────────────────────────────────────────

describe("TaskManager joined/promote passthrough", () => {
  it("no sidecar: nothing attests, nothing hides; promote without sidecar still subtracts", async () => {
    const tm = manager(null);
    try {
      expect((await tm.joinedAgentSessionIds()).size).toBe(0);
      tm.promoteAgentSession("w-none"); // must not throw on the no-SpawnLog path
      expect((await tm.joinedAgentSessionIds()).size).toBe(0);
    } finally {
      tm.stop();
    }
  });
});

// ── coldLogsPayload: the list filter (boot fixture) ─────────────────────────

describe("coldLogsPayload: attested worker logs leave the list", () => {
  let tm: TaskManager;
  let registry: SessionRegistry;

  beforeAll(() => {
    mkLog("vis-mgr");
    mkLog("vis-worker"); // attested: ev:"agent" join below
    mkLog("vis-torn"); // spawn attested, agent line torn -> plain row
    mkLog("vis-plain"); // never touched by the sidecar -> plain row
    const path = sidecar(
      "cold-list",
      [
        spawnLine({ id: "run:v1", desc: "audit the parser", session: "vis-mgr" }),
        { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:v1", agent: "vis-worker" },
        { t: new Date(END).toISOString(), ev: "end", id: "run:v1", outcome: "completed" },
        spawnLine({ id: "run:v2", desc: "torn join", session: "vis-mgr", pid: 778, host: hostname() }),
      ],
      '{"t":"2026-11-14T10:00:02.000Z","ev":"agent","id":"run:v2","agent":"vis-t',
    );
    tm = manager(path);
    registry = registryFor(tm);
  });

  afterAll(() => {
    tm.stop();
  });

  it("the attested worker row is absent; unattested logs ride plain; nesting stays under the manager", async () => {
    const rows = (await coldLogsPayload(registry)).logs;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("vis-mgr");
    expect(ids).toContain("vis-plain");
    expect(ids).toContain("vis-torn"); // torn attestation: no claim, plain-visible
    expect(ids).not.toContain("vis-worker");
    // R4 stays intact: the worker survives NESTED under its manager row
    // (taskLineageWire grammar unchanged), it never loses its record.
    const mgr = rows.find((r) => r.id === "vis-mgr")!;
    const subs = mgr.subagents as Array<Record<string, unknown>>;
    expect(subs.map((s) => s.taskId)).toEqual(["run:v1", "run:v2"]);
    expect(subs[0]!.agentSessionId).toBe("vis-worker");
    expect(subs[0]!.durable).toBe(true);
  });

  it("the LOGS_LISTED wire itself omits the worker id (handleListLogs)", async () => {
    const { ctx, ws } = ctxFor(registry, { type: C2S.LIST_LOGS });
    await handleListLogs(ctx);
    const frame = frames(ws).find((m) => m.type === S2C.LOGS_LISTED)!;
    const ids = (frame.logs as Array<Record<string, unknown>>).map((l) => l.id);
    expect(ids).not.toContain("vis-worker");
    expect(ids).toContain("vis-plain");
  });

  it("D8 pin honesty: a pin persisted on an excluded worker id is pruned", async () => {
    setPinned("vis-worker", true);
    expect(isPinned("vis-worker")).toBe(true); // persisted before the list build
    await coldLogsPayload(registry); // the list-build path prunes it
    closePinStore(); // restart simulation: the re-read must show it gone
    expect(getPinnedIds().has("vis-worker")).toBe(false);
  });

  it("viewLog/loadOlder keep reaching the excluded id (the list hides, the log stays addressable)", async () => {
    // A bigger log: 8 user turns + 8 responses = 16 messages, K=5 window.
    const lines = [
      JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: "vis-worker", source: "session_start", content: "", model: "m", profile: "default" }),
    ];
    for (let i = 0; i < 8; i++) {
      lines.push(JSON.stringify({ ts: new Date(SPAWN + 1000 + i * 2000).toISOString(), session_id: "vis-worker", source: "input", content: `turn ${i}` }));
      lines.push(JSON.stringify({ ts: new Date(SPAWN + 2000 + i * 2000).toISOString(), session_id: "vis-worker", source: "llm", content: `reply ${i}` }));
    }
    writeFileSync(join(SESSIONS, "vis-worker.jsonl"), lines.join("\n") + "\n");

    const { ctx, ws } = ctxFor(registry, { type: C2S.VIEW_LOG, logId: "vis-worker" });
    await handleViewLog(ctx);
    const viewed = frames(ws).find((m) => m.type === S2C.LOG_VIEWED)!;
    expect(viewed.logId).toBe("vis-worker");
    const entries = viewed.entries as Array<Record<string, unknown>>;
    // Trailing window of FIVE messages: reply 5 opens it (a page may start
    // mid-turn), with the older history behind the seam.
    expect(entries.length).toBe(5);
    expect(entries[0]!.content).toBe("reply 5");
    expect(viewed.hasOlder).toBe(true);
    expect(viewed.oldestIndex).toBe(12);

    // Walk the seam to the top: window + every page == the full log, entry
    // for entry, nothing shipped twice; the last page ships from 0 with the
    // leading session_start riding and hasOlder false.
    let cursor = viewed.oldestIndex as number;
    let hasOlder = viewed.hasOlder === true;
    const collected = [...entries];
    let lastPage: { entries: Array<Record<string, unknown>>; hasOlder: boolean } | null = null;
    let guard = 0;
    while (hasOlder && guard++ < 10) {
      const older = ctxFor(registry, {
        type: C2S.LOAD_OLDER,
        logId: "vis-worker",
        requestId: 4,
        olderThan: cursor,
        epochToken: viewed.epochToken,
      });
      await handleLoadOlder(older.ctx);
      const page = frames(older.ws).find((m) => m.type === S2C.LOAD_OLDER_RESULT)!;
      expect(page.requestId).toBe(4);
      expect(page.error).toBeUndefined();
      lastPage = { entries: page.entries as Array<Record<string, unknown>>, hasOlder: page.hasOlder === true };
      collected.unshift(...lastPage.entries);
      cursor = page.oldestIndex as number;
      hasOlder = page.hasOlder === true;
    }
    expect(hasOlder).toBe(false);
    expect(lastPage!.entries[0]!.source).toBe("session_start"); // leading bookkeeping rides
    expect(lastPage!.entries[1]!.content).toBe("turn 0");
    const raw = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(JSON.stringify(collected)).toBe(JSON.stringify(raw));
  });

  it("search reaches the excluded log and labels the hit; interactive hits stay byte-identical", async () => {
    // Give the plain log searchable text too (interactive-hit half).
    writeFileSync(
      join(SESSIONS, "vis-plain.jsonl"),
      [
        JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: "vis-plain", source: "input", content: "quantumvis needle on a plain interactive log" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(SESSIONS, "vis-worker.jsonl"),
      readFileSync(join(SESSIONS, "vis-worker.jsonl"), "utf8") +
        JSON.stringify({ ts: new Date(SPAWN + 60000).toISOString(), session_id: "vis-worker", source: "input", content: "quantumvis needle in the worker log" }) + "\n",
    );
    closeSessionIndex(); // re-scan the fresh files (staleness-checked mirror)

    const hits = await searchSessionLogs("quantumvis needle", registry);
    const workerHit = hits.find((h) => h.logId === "vis-worker")!;
    // The exclusion NEVER removes the hit from the corpus...
    expect(workerHit).toBeDefined();
    // ...but the row says what it is (additive field).
    expect(workerHit.subagentOf).toBe("audit the parser");
    expect(workerHit.live).toBe(false);
    const plainHit = hits.find((h) => h.logId === "vis-plain")!;
    expect("subagentOf" in plainHit).toBe(false); // interactive: key never present
    // A torn-join log is NOT attested: reached, and NOT labelled (honest).
    writeFileSync(
      join(SESSIONS, "vis-torn.jsonl"),
      JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: "vis-torn", source: "input", content: "quantumvis needle plain as day" }) + "\n",
    );
    closeSessionIndex();
    const tornHit = (await searchSessionLogs("quantumvis needle", registry)).find((h) => h.logId === "vis-torn")!;
    expect("subagentOf" in tornHit).toBe(false);
  });

  it("no TaskManager: every log rides the list (existing suites' world, byte-identical)", async () => {
    const bare = registryFor(null);
    const rows = (await coldLogsPayload(bare)).logs;
    expect(rows.map((r) => r.id)).toContain("vis-worker");
    const hits = await searchSessionLogs("quantumvis needle", bare);
    for (const h of hits) expect("subagentOf" in h).toBe(false);
  });
});

// ── The centerpiece: a CURRENT-process spawn hides its log, no restart ─────

describe("coldLogsPayload: current-process spawn (the boot-cache gap)", () => {
  it("record the join in-process, rebuild the payload: the log is gone WITHOUT restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vis-live-"));
    const path = join(dir, "task-spawns.jsonl");
    mkLog("vis2-mgr");
    mkLog("vis2-worker"); // written BEFORE any attestation exists
    // ONE TaskManager for the whole lifetime (as on the real server): the
    // worker agent owns the log key vis2-worker (the agent-factory mints
    // it; the mock stands in with the same id).
    const tm = new TaskManager({
      buildAgent: async () =>
        ({
          sessionId: "vis2-worker",
          run: () => new Promise<never>(() => {}), // hang until interrupted
          notifyCompletion: () => {},
        }) as never,
      modelRegistry: {},
      config: {},
      maxIterations: 3,
      taskProfile: "default",
      spawnLogPath: path,
      spawnLogPidAlive: () => false,
    });
    const registry = registryFor(tm);
    try {
      // Warm the boot cache (this is the state a running server is in: the
      // lineage/lineageTasks reads happened long before this spawn).
      const before = (await coldLogsPayload(registry)).logs;
      expect(before.map((r) => r.id)).toContain("vis2-worker");
      expect((await tm.lineageTasks()).some((r) => r.taskId === "t-vis-live")).toBe(false);

      // The live spawn: recordSpawn + recordAgent append AFTER the cache.
      await tm.spawnTask("t-vis-live", "live delegation", {
        managerAgent: { sessionId: "vis2-mgr" } as never,
      });
      await waitForFileText(path, '"vis2-worker"'); // the agent line landed
      // The boot-cache gap, stated: the cached lineage view stays stale...
      expect((await tm.lineageTasks()).some((r) => r.taskId === "t-vis-live")).toBe(false);
      // ...yet the list answer flips with NO restart.
      const after = (await coldLogsPayload(registry)).logs;
      expect(after.map((r) => r.id)).not.toContain("vis2-worker");
      expect(after.map((r) => r.id)).toContain("vis2-mgr");
    } finally {
      tm.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── D6 promotion round trip ─────────────────────────────────────────────────

describe("promotion: manual Continue adopts, pins, and survives cold + restart", () => {
  const PROMOTED = "vis3-promoted";
  const AUTO = "vis3-autocold";
  let path: string;
  let tm: TaskManager;
  let registry: SessionRegistry;

  const restorableLog = (id: string) =>
    writeFileSync(
      join(SESSIONS, `${id}.jsonl`),
      [
        JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: id, source: "session_start", content: "", model: "m", profile: "default" }),
        JSON.stringify({ ts: new Date(SPAWN + 1000).toISOString(), session_id: id, source: "input", content: `work on ${id}` }),
        JSON.stringify({ ts: new Date(SPAWN + 2000).toISOString(), session_id: id, source: "llm", content: "done" }),
      ].join("\n") + "\n",
    );

  beforeAll(() => {
    restorableLog(PROMOTED);
    restorableLog(AUTO);
    path = sidecar("promote", [
      spawnLine({ id: "run:p1", desc: "promoted job", session: "vis3-mgr" }),
      { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:p1", agent: PROMOTED },
      { t: new Date(END).toISOString(), ev: "end", id: "run:p1", outcome: "completed" },
      spawnLine({ id: "run:p2", desc: "auto job", session: "vis3-mgr", pid: 778, host: hostname() }),
      { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:p2", agent: AUTO },
      { t: new Date(END).toISOString(), ev: "end", id: "run:p2", outcome: "completed" },
    ]);
    tm = manager(path);
    registry = registryFor(tm);
  });

  afterAll(() => {
    tm.stop();
  });

  it("the promoted round trip: Continue -> interactive live row -> pinnable -> plain cold row, surviving restart", async () => {
    expect((await coldLogsPayload(registry)).logs.map((r) => r.id)).not.toContain(PROMOTED);

    // Manual Continue (handleLoadLog, auto=false -- this route IS manual).
    const { ctx, ws } = ctxFor(registry, { type: C2S.LOAD_LOG, logId: PROMOTED });
    await handleLoadLog(ctx);
    const created = frames(ws).find((m) => m.type === S2C.SESSION_CREATED)!;
    expect(created.sessionId).toBe(PROMOTED);
    // The adopted row is a NORMAL interactive session: the create() rows
    // carry no kind field (pinned here, not assumed), and the subagent
    // chrome of sessionCreated never rides it.
    expect(registry.get(PROMOTED)).toBeTruthy();
    expect(registry.getRow(PROMOTED)!.kind).toBeUndefined();
    expect("kind" in created).toBe(false);

    // Pinnable: B3's refusal keys on the live ROW kind, absent = interactive.
    const pin = ctxFor(registry, { type: C2S.SET_PINNED, sessionId: PROMOTED, pinned: true });
    await handleSetPinned(pin.ctx);
    expect(frames(pin.ws).some((m) => m.type === S2C.ERROR)).toBe(false);
    expect(isPinned(PROMOTED)).toBe(true);

    // The promote landed in the sidecar (durable across lifetimes).
    const text = await waitForFileText(path, '"ev":"promote"');
    expect(text).toContain(`"id":"${PROMOTED}"`);

    // Goes cold again -> REAPPEARS as a plain Recent Logs row.
    expect(registry.delete(PROMOTED)).toBe(true);
    const rows = (await coldLogsPayload(registry)).logs;
    const row = rows.find((r) => r.id === PROMOTED);
    expect(row).toBeDefined();
    expect("subagents" in row!).toBe(false); // plain row, not nested anywhere
    expect(row!.pinned).toBe(true); // D8: the promoted session KEEPS its pin

    // Restart simulation: fresh TaskManager/SpawnLog over the same sidecar
    // (boot read sees the promote line), pin store re-read from disk.
    const tm2 = manager(path);
    const registry2 = registryFor(tm2);
    closePinStore();
    try {
      const rows2 = (await coldLogsPayload(registry2)).logs;
      const row2 = rows2.find((r) => r.id === PROMOTED);
      expect(row2).toBeDefined();
      expect(row2!.pinned).toBe(true);
    } finally {
      tm2.stop();
    }
  });

  it("auto/reconnect adoption does NOT promote (only a human claim does)", async () => {
    // The reconnect path: attachResumedSession(auto=true) -- adopted live,
    // yet the log stays worker-attested: cold again, it stays hidden.
    const ws = createWsMockWs();
    await attachResumedSession(ws, registry, bridgeStub, AUTO, 0, true);
    expect(registry.get(AUTO)).toBeTruthy();
    expect(registry.delete(AUTO)).toBe(true);
    const rows = (await coldLogsPayload(registry)).logs;
    expect(rows.map((r) => r.id)).not.toContain(AUTO);
    // The sidecar holds exactly ONE promote line -- the manual one.
    const text = readFileSync(path, "utf8");
    expect((text.match(/"ev":"promote"/g) ?? []).length).toBe(1);
    // ...and a fresh lifetime agrees.
    const tm2 = manager(path);
    try {
      const rows2 = (await coldLogsPayload(registryFor(tm2))).logs;
      expect(rows2.map((r) => r.id)).not.toContain(AUTO);
    } finally {
      tm2.stop();
    }
  });
});

// ── Restart adoption of an attested worker (the honest middle state) ───────
// The browser-reconnect auto path cold-adopts a worker log whose sidecar
// record still attests the worker join. The auto-resume MIDDLE STATE stays
// alive (the interactive engine runs the continuation) and stays honest:
// the row carries the worker birth attributes the sidecar attests
// (kind/taskId/parentSessionId), list() hides it, the attach payload badges
// the pane, the manager's durable card nests the same agentSessionId, the
// refusal texts never name a task the adopted session cannot touch, and the
// turn's settle writes the adopted terminal attestation
// ("adopted-completed"/"adopted-died") that closes the card. A manual
// Continue stays the only promotion; ordinary logs adopt interactive
// untouched.

const ADOPT = "vis5-adopted";
const ADOPT_DIED = "vis5-died";
const ADOPT_TORN = "vis5-torn";
const ADOPT_CLOSED = "vis5-closed";
const PLAIN5 = "vis5-plain";
const ADOPT_MGR = "vis5-mgr";

function makeAdoptFixture(name: string) {
  const log = (id: string) =>
    writeFileSync(
      join(SESSIONS, `${id}.jsonl`),
      [
        JSON.stringify({ ts: new Date(SPAWN).toISOString(), session_id: id, source: "session_start", content: "", model: "m", profile: "default" }),
        JSON.stringify({ ts: new Date(SPAWN + 1000).toISOString(), session_id: id, source: "input", content: `work on ${id}` }),
        JSON.stringify({ ts: new Date(SPAWN + 2000).toISOString(), session_id: id, source: "llm", content: "done" }),
      ].join("\n") + "\n",
    );
  for (const id of [ADOPT, ADOPT_DIED, ADOPT_TORN, ADOPT_CLOSED, PLAIN5, ADOPT_MGR]) log(id);
  const path = sidecar(name, [
    spawnLine({ id: "run:a1", desc: "adopted job", session: ADOPT_MGR }),
    { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:a1", agent: ADOPT },
    spawnLine({ id: "run:a2", desc: "dying job", session: ADOPT_MGR }),
    { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:a2", agent: ADOPT_DIED },
    spawnLine({ id: "run:a3", desc: "settled job", session: ADOPT_MGR }),
    { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:a3", agent: ADOPT_CLOSED },
    { t: new Date(END).toISOString(), ev: "end", id: "run:a3", outcome: "completed" },
    spawnLine({ id: "run:a4", desc: "torn job", session: ADOPT_MGR }),
    { t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: "run:a4", agent: ADOPT_TORN },
  ]);
  // TURN_END-capable agents: the settle latch reads hooks.on, the test
  // fires the hook by hand (real Agents carry the real HookSystem).
  const hooks: Record<string, Array<(d: unknown) => unknown>> = {};
  const tm = manager(path);
  const registry = new SessionRegistry({
    buildAgent: async (config: { sessionId?: string }) =>
      makeWsMockAgent({
        sessionId: config.sessionId || "fresh-5",
        hooks: {
          notifyHooks: () => {},
          runHookPipeline: async () => undefined,
          registerHook: () => {},
          unregisterHook: () => {},
          on: (hook: string, h: (d: unknown) => unknown) => {
            (hooks[hook] ||= []).push(h);
            return () => {};
          },
        } as never,
      }),
    toolExecResolved: { toolExec: "inline", execFence: "probe" },
  });
  registry.setTaskManager(tm);
  return {
    path,
    tm,
    registry,
    fire: (hook: string, data: unknown) => {
      for (const h of hooks[hook] ?? []) h(data);
    },
  };
}

describe("restart adoption: an attested worker returns honest, not top-level", () => {
  it("auto adoption stamps the worker row: hidden, linked, badged, nested under the manager", async () => {
    const f = makeAdoptFixture("adopt-stamp");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT, 0, true);

      const row = f.registry.getRow(ADOPT)!;
      expect(row.kind).toBe("worker");
      expect(row.adoptedWorker).toBe(true);
      expect(row.taskId).toBe("run:a1");
      expect(row.parentSessionId).toBe(ADOPT_MGR);
      expect(row.workerTerminal).toBe(false);
      expect(row.attestPending).toBe(true); // the record was OPEN at adoption
      expect(row.getAgent?.()).toBeTruthy(); // the engine keeps running it

      // The worker projection holds THROUGH adoption: the orphan is never
      // a top-level live row (the SESSIONS payload is built from list()).
      expect(f.registry.list().map((s) => s.id)).not.toContain(ADOPT);
      expect(f.registry.size).toBe(0);

      // The RENDER inputs, pinned: the pane's payload badges it as a
      // subagent of the attested parent (adopted tell rides too), and the
      // manager's cold row nests the durable card for the SAME task -- the
      // agentSessionId is the client's join key between the two.
      const created = frames(ws).find((m) => m.type === S2C.SESSION_CREATED)!;
      expect(created.kind).toBe("subagent");
      expect(created.parentSessionId).toBe(ADOPT_MGR);
      expect(created.adopted).toBe(true);
      const rows = (await coldLogsPayload(f.registry)).logs;
      expect(rows.map((r) => r.id)).not.toContain(ADOPT); // hidden from the cold list too
      const nested = (rows.find((r) => r.id === ADOPT_MGR)!.subagents ?? []) as Array<Record<string, unknown>>;
      const card = nested.find((t) => t.taskId === "run:a1");
      expect(card).toBeDefined();
      expect(card!.status).toBe("interrupted");
      expect(card!.durable).toBe(true);
      expect(card!.agentSessionId).toBe(ADOPT);
    } finally {
      f.tm.stop();
    }
  });

  it("the refusal table stays honest with no task to name (the Stop button included)", async () => {
    const f = makeAdoptFixture("adopt-refusals");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT, 0, true);

      // Stop on the adopted pane: refused, and the text does NOT send the
      // user hunting for a task control that cannot reach this session.
      const cancel = ctxFor(f.registry, { type: C2S.CANCEL, sessionId: ADOPT });
      handleCancel(cancel.ctx);
      const cancelErr = frames(cancel.ws).find((m) => m.type === S2C.ERROR)!;
      expect(String(cancelErr.message)).toContain("adopted");
      expect(String(cancelErr.message)).not.toContain("interrupt_task");

      // Send: refused; the follow-up route the book-row text names has no
      // task to steer here either.
      const send = ctxFor(f.registry, { type: C2S.SEND, sessionId: ADOPT, content: "steer me" });
      handleSend(send.ctx);
      const sendErr = frames(send.ws).find((m) => m.type === S2C.ERROR)!;
      expect(String(sendErr.message)).toContain("adopted");
      expect(String(sendErr.message)).not.toContain("follow-up");

      // Delete: refused (posture unchanged), saying what actually ends it.
      const del = ctxFor(f.registry, { type: C2S.DELETE_SESSION, sessionId: ADOPT });
      handleDeleteSession(del.ctx);
      const delErr = frames(del.ws).find((m) => m.type === S2C.ERROR)!;
      expect(String(delErr.message)).toContain("adopted");
      expect(String(delErr.message)).not.toContain("task lifecycle");

      // Question answers DO land from the pane: the delegating manager lane
      // is gone (that is what adoption means), and the human answer is not
      // the defaults-as-answer breach the refusal guards.
      const answered: string[] = [];
      const qBridge = {
        ...bridgeStub,
        answer: (sid: string) => {
          answered.push(sid);
          return true;
        },
      };
      const qws = createWsMockWs();
      await handleQuestionAnswer({
        ws: qws,
        msg: { sessionId: ADOPT, answers: { ok: "yes" } },
        registry: f.registry,
        bridge: qBridge,
        core: coreStub,
      } as never);
      expect(answered).toEqual([ADOPT]);
      expect(frames(qws).some((m) => m.type === S2C.ERROR)).toBe(false);
    } finally {
      f.tm.stop();
    }
  });

  it("the adopted turn settling lands the terminal attestation and closes the card", async () => {
    const f = makeAdoptFixture("adopt-settle");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT, 0, true);
      expect(f.registry.getRow(ADOPT)!.attestPending).toBe(true);

      f.fire(HOOKS.TURN_END, { stopped: true, reason: "completion" });
      const text = await waitForFileText(f.path, "adopted-completed");
      expect(text).toContain('"ev":"end"');
      expect(text).toContain('"id":"run:a1"');
      const row = f.registry.getRow(ADOPT)!;
      expect(row.attestPending).toBe(false);
      expect(row.workerTerminal).toBe(true); // sweep may reclaim it once unwatched

      // The card stops claiming "interrupted" -- THIS lifetime reads the
      // record CLOSED (the cached boot view follows its own line)...
      const rec = (await f.tm.lineageTasks()).find((r) => r.taskId === "run:a1")!;
      expect(rec.outcome).toBe("adopted-completed");
      expect(rec.endedAt).not.toBeNull();
      // ...and so does the next lifetime (a fresh boot snapshot).
      const tm2 = manager(f.path);
      try {
        const rec2 = (await tm2.lineageTasks()).find((r) => r.taskId === "run:a1")!;
        expect(rec2.outcome).toBe("adopted-completed");
      } finally {
        tm2.stop();
      }

      // Once-only: a later turn-end and a teardown never rewrite the line.
      f.fire(HOOKS.TURN_END, { stopped: true, reason: "completion" });
      expect(f.registry.delete(ADOPT)).toBe(true);
      const ends = readFileSync(f.path, "utf8")
        .split("\n")
        .filter((l) => l.includes('"ev":"end"') && l.includes('"run:a1"'));
      expect(ends.length).toBe(1);
    } finally {
      f.tm.stop();
    }
  });

  it("an abnormal turn end attests adopted-died; a teardown before any settle does too", async () => {
    const f = makeAdoptFixture("adopt-died");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT_DIED, 0, true);
      f.fire(HOOKS.TURN_END, { stopped: true, reason: "error" });
      const text = await waitForFileText(f.path, "adopted-died");
      expect(text).toContain('"id":"run:a2"');
    } finally {
      f.tm.stop();
    }
  });

  it("a teardown while the adopted turn is unsettled still closes the card", async () => {
    const f = makeAdoptFixture("adopt-teardown");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT_TORN, 0, true);
      expect(f.registry.getRow(ADOPT_TORN)!.attestPending).toBe(true);
      // No turn ever settled: deleting the session writes the died
      // attestation (the alternative is a card frozen on "interrupted").
      expect(f.registry.delete(ADOPT_TORN)).toBe(true);
      const text = await waitForFileText(f.path, "adopted-died");
      expect(text).toContain('"id":"run:a4"');
      expect(f.registry.getRow(ADOPT_TORN)).toBeNull();
    } finally {
      f.tm.stop();
    }
  });

  it("adopting an already-closed attested worker never rewrites its recorded outcome", async () => {
    const f = makeAdoptFixture("adopt-closed");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, ADOPT_CLOSED, 0, true);
      const row = f.registry.getRow(ADOPT_CLOSED)!;
      expect(row.kind).toBe("worker"); // worker posture holds...
      expect(row.attestPending).toBeFalsy(); // ...but the closed card is owed nothing
      f.fire(HOOKS.TURN_END, { stopped: true, reason: "completion" });
      expect(row.workerTerminal).toBe(true); // settle still frees the sweep
      const text = readFileSync(f.path, "utf8");
      const ends = text.split("\n").filter((l) => l.includes('"ev":"end"') && l.includes('"run:a3"'));
      expect(ends.length).toBe(1); // only the original "completed" line
      expect(text).not.toContain("adopted-completed");
      // The recorded outcome stands in the rebuilt view.
      expect((await f.tm.lineageTasks()).find((r) => r.taskId === "run:a3")!.outcome).toBe("completed");
    } finally {
      f.tm.stop();
    }
  });

  it("an ordinary (unattested) log adopts interactive -- zero regression", async () => {
    const f = makeAdoptFixture("adopt-plain");
    try {
      const ws = createWsMockWs();
      await attachResumedSession(ws, f.registry, bridgeStub, PLAIN5, 0, true);
      const row = f.registry.getRow(PLAIN5)!;
      expect(row.kind).toBeUndefined();
      expect(row.taskId).toBeUndefined();
      expect(row.parentSessionId).toBeUndefined();
      expect(f.registry.list().map((s) => s.id)).toContain(PLAIN5);
      const created = frames(ws).find((m) => m.type === S2C.SESSION_CREATED)!;
      expect("kind" in created).toBe(false);
      expect(f.registry.delete(PLAIN5)).toBe(true);
    } finally {
      f.tm.stop();
    }
  });
});
