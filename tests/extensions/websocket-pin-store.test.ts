// Server-side pin store suite: the pinned-id set persists to the dedicated
// JSON file across store reloads (restart simulated by closePinStore +
// re-read), missing/corrupt files load as empty without crashing, HOTDOG_
// SESSIONS_DIR relocation repoints the store, an unwritable store home
// fails loudly without crashing or leaving debris, delete handlers prune
// pins, the pinned flag rides the SESSIONS and LOGS_LISTED wires, and a
// setPinned broadcast reaches a second attached socket. Harness idioms
// follow websocket-sidebar-rows.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { TMP_PARENT } from "../mocks/io.ts";
import { join } from "node:path";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import {
  closePinStore,
  dropPinned,
  getPinnedIds,
  isPinned,
  pinStorePath,
  setPinned,
} from "@extensions/websocket/pin-store.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createHooks } from "@core/hooks.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const authStub = undefined as unknown as AuthMiddleware;
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-pin-store-"));
let prevSessionsDir: string | undefined;

beforeAll(() => {
  prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
  process.env.HOTDOG_SESSIONS_DIR = TMP;
  closePinStore();
});

afterAll(() => {
  closePinStore();
  if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
  else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
  rmSync(TMP, { recursive: true, force: true });
});

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeRegistry(agent: AgentLike): SessionRegistry {
  return new SessionRegistry({ buildAgent: async () => agent });
}

/** Write a cold fixture log into the temp sessions dir. */
function writeColdLog(logId: string): void {
  writeFileSync(
    join(TMP, `${logId}.jsonl`),
    JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: logId, source: "input", content: "hi" }) + "\n",
  );
}

function parseMessages(ws: { messages: string[] }): Array<Record<string, unknown>> {
  return ws.messages
    .map((m) => {
      try {
        return JSON.parse(m) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

/** Capture logger.error lines through the real logger plumbing (house
 *  pattern from session-index-quarantine.test.ts). */
function captureLoggedErrors(): string[] {
  resetLoggerForTesting();
  const hooks = createHooks();
  const lines: string[] = [];
  hooks.on("log", (data) => {
    const ev = data as LogEvent;
    if (ev.level === "error") lines.push(ev.message);
  });
  initializeLogger({ hooks, minLevel: "error", target: "none" });
  return lines;
}

// ── The store itself ────────────────────────────────────────────────────────

describe("pin store: durability", () => {
  it("persists across a store reload (restart simulation)", () => {
    expect(setPinned("pin-restart", true)).toBe(true);
    expect(isPinned("pin-restart")).toBe(true);
    expect(existsSync(pinStorePath())).toBe(true);

    // "Restart": forget the memory, the file re-hydrates the set.
    closePinStore();
    expect(getPinnedIds().has("pin-restart")).toBe(true);

    setPinned("pin-restart", false);
    closePinStore();
    expect(getPinnedIds().has("pin-restart")).toBe(false);
  });

  it("HOTDOG_SESSIONS_DIR relocation repoints the store (sessionIndexPath semantics)", () => {
    const other = mkdtempSync(join(TMP_PARENT, "hotdog-pin-store-other-"));
    try {
      setPinned("pin-home-a", true);
      process.env.HOTDOG_SESSIONS_DIR = other;
      // The new home has no pins file: empty, no crash, no bleed-over.
      expect(getPinnedIds().size).toBe(0);
      setPinned("pin-home-b", true);
      process.env.HOTDOG_SESSIONS_DIR = TMP;
      expect(getPinnedIds()).toEqual(new Set(["pin-home-a"]));
      expect(existsSync(join(other, "pinned-sessions.json"))).toBe(true);
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = TMP;
      dropPinned("pin-home-a");
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("missing file loads as an empty set", () => {
    rmSync(pinStorePath(), { force: true });
    closePinStore();
    expect(getPinnedIds().size).toBe(0);
    // Reading an absent store never blocks later writes.
    expect(setPinned("pin-after-missing", true)).toBe(true);
    dropPinned("pin-after-missing");
  });

  it("corrupt payloads load as empty, junk entries are dropped, nothing throws", () => {
    writeFileSync(pinStorePath(), "{ this is not json");
    closePinStore();
    expect(getPinnedIds().size).toBe(0);

    writeFileSync(pinStorePath(), JSON.stringify({ pinned: true }));
    closePinStore();
    expect(getPinnedIds().size).toBe(0);

    // Array payload with poison: only ids passing the core session-id gate
    // survive the load.
    writeFileSync(
      pinStorePath(),
      JSON.stringify(["good-pin", 42, "../escape", "", "a/b", null]),
    );
    closePinStore();
    expect(getPinnedIds()).toEqual(new Set(["good-pin"]));
    rmSync(pinStorePath(), { force: true });
  });

  it("refuses ids the core session-id gate rejects", () => {
    expect(setPinned("../escape", true)).toBe(false);
    expect(setPinned("", true)).toBe(false);
    expect(isPinned("../escape")).toBe(false);
    expect(existsSync(pinStorePath())).toBe(false);
  });

  it("unwritable store home: honest failure -- no throw, loud log, no debris, memory stays authoritative", () => {
    // chmod is toothless as root (lane-ledger precedent): skip there rather
    // than fake a pass. Read-only store home = both the tmp write and the
    // rename target the EACCES wall inside persistPins.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    rmSync(pinStorePath(), { force: true });
    closePinStore();
    chmodSync(TMP, 0o500);
    const logged = captureLoggedErrors();
    try {
      // The connection survives the flip: no throw out of the store.
      expect(() => setPinned("pin-ro", true)).not.toThrow();
      // Loud, never silent: exactly one logger error naming the store path.
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("[pin-store]");
      expect(logged[0]).toContain("could not persist");
      // Documented degradation: the in-memory set stays authoritative for
      // this process, so the sidebar keeps its pin marks.
      expect(isPinned("pin-ro")).toBe(true);
      // Nothing half-landed: no store file, no tmp debris in the dir.
      expect(existsSync(pinStorePath())).toBe(false);
      expect(readdirSync(TMP).some((f) => f.includes(".tmp"))).toBe(false);
    } finally {
      resetLoggerForTesting();
      chmodSync(TMP, 0o700);
    }
    // The promised recovery: the next successful write re-persists the
    // whole in-memory set, the pin that failed to land included.
    expect(setPinned("pin-ro-2", true)).toBe(true);
    expect(JSON.parse(readFileSync(pinStorePath(), "utf8"))).toEqual(["pin-ro", "pin-ro-2"]);
    dropPinned("pin-ro");
    dropPinned("pin-ro-2");
  });
});

// ── Prune-on-delete hooks ───────────────────────────────────────────────────

describe("pin store: stale-prune on delete", () => {
  it("session delete drops the pin (store + file)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-del-live" }));
    await registry.create({ profile: "manager" });
    setPinned("pin-del-live", true);

    const ws = createWsMockWs();
    await routeMessage(
      ws,
      { type: C2S.DELETE_SESSION, sessionId: "pin-del-live" } as never,
      registry,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();

    expect(isPinned("pin-del-live")).toBe(false);
    closePinStore();
    expect(getPinnedIds().has("pin-del-live")).toBe(false);
  });

  it("log delete drops the pin (store + file)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-del-holder" }));
    await registry.create();
    writeColdLog("pin-del-cold");
    setPinned("pin-del-cold", true);

    const ws = createWsMockWs();
    await routeMessage(
      ws,
      { type: C2S.DELETE_LOG, logId: "pin-del-cold" } as never,
      registry,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();

    expect(isPinned("pin-del-cold")).toBe(false);
    closePinStore();
    expect(getPinnedIds().has("pin-del-cold")).toBe(false);
    registry.delete("pin-del-holder");
  });

  it("deleting an unpinless row leaves the store bytes untouched", async () => {
    writeColdLog("pin-untouched");
    setPinned("pin-survivor", true);
    const before = readFileSync(pinStorePath(), "utf8");

    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-untouched-holder" }));
    await registry.create();
    const ws = createWsMockWs();
    await routeMessage(
      ws,
      { type: C2S.DELETE_LOG, logId: "pin-untouched" } as never,
      registry,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();

    expect(readFileSync(pinStorePath(), "utf8")).toBe(before);
    dropPinned("pin-survivor");
    registry.delete("pin-untouched-holder");
  });
});

// ── Wire: flags + setPinned broadcast ───────────────────────────────────────

describe("pin store: wire surface", () => {
  it("pinned flag present on the SESSIONS wire, false by default", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-flag-live" }));
    await registry.create({ profile: "manager" });

    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.LIST_SESSIONS } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const msg = parseMessages(ws).pop()!;
    expect(msg.type).toBe(S2C.SESSIONS);
    const rows = msg.sessions as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === "pin-flag-live")!.pinned).toBe(false);

    setPinned("pin-flag-live", true);
    await routeMessage(ws, { type: C2S.LIST_SESSIONS } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const rows2 = (parseMessages(ws).pop()!.sessions as Array<Record<string, unknown>>);
    expect(rows2.find((r) => r.id === "pin-flag-live")!.pinned).toBe(true);

    registry.delete("pin-flag-live");
    dropPinned("pin-flag-live");
  });

  it("pinned flag present on the LOGS_LISTED wire for cold rows", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-flag-holder" }));
    await registry.create();
    writeColdLog("pin-flag-cold");
    setPinned("pin-flag-cold", true);

    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.LIST_LOGS } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const msg = parseMessages(ws).pop()!;
    expect(msg.type).toBe(S2C.LOGS_LISTED);
    const cold = (msg.logs as Array<Record<string, unknown>>).find((l) => l.id === "pin-flag-cold")!;
    expect(cold.pinned).toBe(true);

    dropPinned("pin-flag-cold");
    registry.delete("pin-flag-holder");
  });

  it("setPinned broadcasts SESSIONS + LOGS_LISTED to every attached socket", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-bcast-live" }));
    await registry.create({ profile: "manager" });
    writeColdLog("pin-bcast-cold");

    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    registry.registerConnection(wsA);
    registry.registerConnection(wsB);

    await routeMessage(
      wsA,
      { type: C2S.SET_PINNED, sessionId: "pin-bcast-cold", pinned: true } as never,
      registry,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();

    // The second tab's sidebar updates without asking: same refreshed
    // payloads as the requesting socket got.
    const bTypes = parseMessages(wsB);
    const sessionsMsg = bTypes.find((m) => m.type === S2C.SESSIONS)!;
    expect(sessionsMsg).toBeTruthy();
    const logsMsg = bTypes.find((m) => m.type === S2C.LOGS_LISTED)!;
    expect(logsMsg).toBeTruthy();
    const cold = (logsMsg.logs as Array<Record<string, unknown>>).find((l) => l.id === "pin-bcast-cold")!;
    expect(cold.pinned).toBe(true);

    // Unpin broadcast carries the flip back to false.
    await routeMessage(
      wsA,
      { type: C2S.SET_PINNED, sessionId: "pin-bcast-cold", pinned: false } as never,
      registry,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();
    const logsMsg2 = parseMessages(wsB).filter((m) => m.type === S2C.LOGS_LISTED).pop()!;
    const cold2 = (logsMsg2.logs as Array<Record<string, unknown>>).find((l) => l.id === "pin-bcast-cold")!;
    expect(cold2.pinned).toBe(false);

    registry.unregisterConnection(wsA);
    registry.unregisterConnection(wsB);
    registry.delete("pin-bcast-live");
  });

  it("malformed setPinned frames are dropped without touching the store", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "pin-bad-frame" }));
    await registry.create();
    const ws = createWsMockWs();
    registry.registerConnection(ws);

    await routeMessage(ws, { type: C2S.SET_PINNED, sessionId: "../escape", pinned: true } as never, registry, authStub, bridgeStub, coreStub);
    await routeMessage(ws, { type: C2S.SET_PINNED, sessionId: "pin-bad-frame" } as never, registry, authStub, bridgeStub, coreStub);
    await routeMessage(ws, { type: C2S.SET_PINNED, sessionId: "pin-bad-frame", pinned: "yes" } as never, registry, authStub, bridgeStub, coreStub);
    await flush();

    expect(isPinned("pin-bad-frame")).toBe(false);
    expect(parseMessages(ws).length).toBe(0);
    registry.unregisterConnection(ws);
    registry.delete("pin-bad-frame");
  });
});
