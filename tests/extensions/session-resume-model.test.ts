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
import { adoptSessionLog, SessionRegistry } from "@extensions/websocket/server.ts";
import type { AgentLike } from "@core/session/index.ts";
import { createHooks } from "@core/hooks.ts";
import {
  initializeLogger,
  resetLoggerForTesting,
  type LogEvent,
} from "@utils/logger.ts";
import { makeWsMockAgent } from "../mocks/websocket.ts";

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
        await adoptSessionLog(sessionId, registry, false, entries);
        expect(configs[0]!.model).toBe("attested-model");
        expect(configs[0]!.profileName).toBe("attested-profile");
        expect(logged.some((l) => /no model attested/i.test(l))).toBe(false);
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
        await adoptSessionLog(sessionId, registry, false, entries);
        // Host default lands -- but only after an explicit, loud warning.
        expect(configs[0]!.model).toBeUndefined();
        expect(logged.some((l) => /no model attested/i.test(l))).toBe(true);
      } finally {
        resetLoggerForTesting();
      }
    } finally {
      registry.stopCleanupLoop();
      rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), { force: true });
    }
  });
});

async function reconcileAndRead(sessionId: string): Promise<LogEntry[]> {
  await reconcileSessionIndex();
  return readSessionEntries(sessionId, { full: true });
}
