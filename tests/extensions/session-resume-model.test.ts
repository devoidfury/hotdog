// Cold-resume model fidelity at the ws adoption boundary (improvement #7,
// loud half). adoptSessionLog reads the index row (rebuilt or live) and
// hands its attested model/profile to registry.create. When the log attests
// NO model, the session does land on the host default -- but that swap must
// be announced loudly (logger.error), never discovered later from a
// transcript that looked fine.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  reconcileSessionIndex,
  closeSessionIndex,
} from "@core/session/session-index.ts";
import { readSessionEntries, LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { adoptSessionLog } from "@extensions/websocket/resume.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import type { AgentLike } from "@core/session/index.ts";
import { createHooks } from "@core/hooks.ts";
import {
  initializeLogger,
  resetLoggerForTesting,
  type LogEvent,
} from "@utils/logger.ts";
import { makeWsMockAgent, createWsMockCore, createWsMockWs } from "../mocks/websocket.ts";

const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-resume-model-"));

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

function writeLog(sessionId: string, lines: string[]): void {
  writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join(""));
}

function line(over: Partial<LogEntry>): string {
  const entry: LogEntry = {
    ts: new Date(1700000000000).toISOString(),
    session_id: "s",
    source: LOG_SOURCE.INPUT,
    content: "hello",
    ...over,
  };
  return JSON.stringify(entry) + "\n";
}

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

/** Registry whose buildAgent records the config it was handed. */
function recordingRegistry(): { registry: SessionRegistry; configs: Record<string, unknown>[] } {
  const configs: Record<string, unknown>[] = [];
  const registry = new SessionRegistry({
    buildAgent: async (config: { model?: string; sessionId?: string }) => {
      configs.push({ ...config });
      return makeWsMockAgent({ sessionId: config.sessionId || "x" }) as AgentLike;
    },
  });
  return { registry, configs };
}

describe("adoptSessionLog model fidelity", () => {
  beforeEach(() => {
    closeSessionIndex();
  });

  it("resumes with the model the rebuilt index attests (restored value, no swap)", async () => {
    const sessionId = uniqueId("attested");
    writeLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "attested-model", profile: "attested-profile" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    const entries = await reconcileAndRead(sessionId);
    const { registry, configs } = recordingRegistry();
    try {
      const logged = captureLoggedErrors();
      try {
        const res = await adoptSessionLog(sessionId, registry, false, entries);
        expect(configs[0]!.model).toBe("attested-model");
        expect(configs[0]!.profileName).toBe("attested-profile");
        expect(logged.some((l) => /no model attested/i.test(l))).toBe(false);
        expect(res.modelWarning).toBeNull();
      } finally {
        resetLoggerForTesting();
      }
    } finally {
      registry.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });

  it("warns loudly when the log attests no model, instead of swapping silently", async () => {
    const sessionId = uniqueId("unattested");
    writeLog(sessionId, [line({ session_id: sessionId, content: "u" })]);
    const entries = await reconcileAndRead(sessionId);
    const { registry, configs } = recordingRegistry();
    try {
      const logged = captureLoggedErrors();
      try {
        const res = await adoptSessionLog(sessionId, registry, false, entries);
        // Host default lands -- but only after an explicit, loud warning.
        expect(configs[0]!.model).toBeUndefined();
        expect(logged.some((l) => /no model attested/i.test(l))).toBe(true);
        // The warning text is handed back so the attach path can deliver it
        // to the resuming socket (a pre-attach sink emit reaches no one).
        expect(String(res.modelWarning)).toMatch(/no model attested/i);
      } finally {
        resetLoggerForTesting();
      }
    } finally {
      registry.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });
});

// ── The adoption seam is idempotent ─────────────────────────────────────
// pendingAdoptions only dedupes adoptions that are IN FLIGHT. The attach
// flow's live-session check runs before its log reads, so a slow read (the
// 2-core CI race behind "enqueues exactly once for concurrent adopters")
// can land after the first adoption settled and the map cleared. A late
// joiner must never re-adopt a live session: that forks a second writer
// onto one JSONL and double-fires the open-turn continuation.

describe("adoptSessionLog idempotency", () => {
  it("never re-adopts a session that is already live under its id", async () => {
    const sessionId = uniqueId("adopt-twice");
    writeLog(sessionId, [line({ session_id: sessionId, content: "u" })]);
    const entries = await reconcileAndRead(sessionId);
    const { registry, configs } = recordingRegistry();
    try {
      captureLoggedErrors(); // the unattested-model warning is expected here
      try {
        const first = await adoptSessionLog(sessionId, registry, false, entries);
        expect(first.adopted).toBe(true);
        expect(registry.get(sessionId)).not.toBeNull();
        // The map is empty again (settled) and the session is live: the
        // exact state the racing second tab observes.
        const second = await adoptSessionLog(sessionId, registry, false, entries);
        expect(second.adopted).toBe(false);
        expect(configs).toHaveLength(1); // no second agent for one id
      } finally {
        resetLoggerForTesting();
      }
    } finally {
      registry.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });
});

// ── The warning must reach the resuming client ─────────────────────────────
// The pre-attach sink emit died unheard: output events are neither persisted
// nor replayed, and the resuming socket only subscribes during attach. The
// fix emits the warning AFTER attach (same slot the held-question replay
// uses), so a resuming client's transcript carries it.

async function waitForMessage(
  ws: { messages: string[] },
  type: string,
  timeoutMs = 2000,
): Promise<any> {
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === type);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${type}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function parsedMessages(ws: { messages: string[] }): any[] {
  return ws.messages
    .map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .filter(Boolean);
}

describe("resuming client receives the unknown-model warning", () => {
  function resumeServer(): ReturnType<typeof createWsServer> {
    return createWsServer(createWsMockCore(), {
      buildAgent: async (cfg: { sessionId?: string }) =>
        makeWsMockAgent({ sessionId: cfg.sessionId || "x" }),
    });
  }

  it("gets the systemMessage after attach when the log attests no model", async () => {
    const sessionId = uniqueId("warn-visible");
    writeLog(sessionId, [line({ session_id: sessionId, content: "u" })]);
    await reconcileSessionIndex();
    const server = resumeServer();
    try {
      const ws = createWsMockWs();
      server.onUpgrade({ url: `/ws?session=${sessionId}`, headers: { host: "localhost" } }, ws);
      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).toBe(sessionId);
      const sys = await waitForMessage(ws, S2C.SYSTEM_MESSAGE);
      expect(String(sys.content)).toMatch(/no model attested/i);
      expect(sys.sessionId).toBe(sessionId);
    } finally {
      server.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });

  it("stays silent on attach when the index attests a model", async () => {
    const sessionId = uniqueId("warn-silent");
    writeLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "attested-model" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await reconcileSessionIndex();
    const server = resumeServer();
    try {
      const ws = createWsMockWs();
      server.onUpgrade({ url: `/ws?session=${sessionId}`, headers: { host: "localhost" } }, ws);
      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).toBe(sessionId);
      await waitForMessage(ws, S2C.SESSION_STATE);
      // The warning (missing) would land right after the attach burst; give
      // it a beat before asserting absence.
      await new Promise((r) => setTimeout(r, 100));
      expect(
        parsedMessages(ws).some(
          (m) => m.type === S2C.SYSTEM_MESSAGE && /no model attested/i.test(String(m.content)),
        ),
      ).toBe(false);
    } finally {
      server.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });
});

async function reconcileAndRead(sessionId: string): Promise<LogEntry[]> {
  await reconcileSessionIndex();
  return readSessionEntries(sessionId, { full: true });
}
