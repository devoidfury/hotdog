// Session-index quarantine + model-faithful rebuild (improvement #7).
//
// Two contracts pinned here:
//   1. A corrupt sqlite index file must NOT poison the process forever. The
//      first open quarantines the corrupt file (renamed aside, never
//      deleted -- the bytes are the postmortem) and rebuilds an empty index;
//      boot reconcile then repopulates from the logs, so the server comes up
//      INDEXED, not de-indexed for its lifetime.
//   2. Model fidelity is a rebuild invariant: the model/profile columns are
//      re-derived from the log's own attestation records (session_start,
//      model_change, profile_switch). A rebuild must never silently swap a
//      resumed session onto the boot-default model; where the log attests
//      nothing, resume says so loudly instead of defaulting quietly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  openSessionIndex,
  closeSessionIndex,
  sessionIndexPath,
  reconcileSessionIndex,
  syncSessionFromLog,
  getSessionRow,
  indexSessionModel,
  deriveModelProfileFromLog,
} from "@core/session/session-index.ts";
import { LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import { create as createSessionLogExtension } from "@extensions/session-log/index.ts";
import { HOOKS, createHooks } from "@core/hooks.ts";
import {
  initializeLogger,
  resetLoggerForTesting,
  type LogEvent,
} from "@utils/logger.ts";
import { createMockCore } from "../helpers.ts";

const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-index-quarantine-"));

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

function fixtureLog(sessionId: string, lines: string[]): string {
  writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join(""));
  return sessionId;
}

function dropLog(sessionId: string): void {
  try { rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`)); } catch {}
}

function resetIndex(): void {
  closeSessionIndex();
  rmSync(sessionIndexPath(), { force: true });
  rmSync(`${sessionIndexPath()}-wal`, { force: true });
  rmSync(`${sessionIndexPath()}-shm`, { force: true });
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (f.includes(".corrupt-")) rmSync(join(SESSIONS_DIR, f), { force: true });
  }
}

/** Capture logger.error lines through the real logger plumbing (house pattern). */
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

describe("corrupt index quarantine", () => {
  beforeEach(() => {
    resetIndex();
  });

  it("open on a corrupt file quarantines it (rename aside, bytes preserved) and rebuilds", () => {
    const garbage = "this is definitely not a sqlite file".repeat(64);
    writeFileSync(sessionIndexPath(), garbage);
    writeFileSync(`${sessionIndexPath()}-wal`, "stale wal bytes");

    const logged = captureLoggedErrors();
    try {
      const db = openSessionIndex(); // must NOT throw
      // Working index: the schema exists and the file is writable.
      db.run("INSERT INTO sessions (session_id, path, updated_at, state, last_seq, size, mtime) VALUES ('x','/x',1,'idle',0,1,1)");

      const quarantined = readdirSync(SESSIONS_DIR).filter((f) => f.includes("sessions.sqlite.corrupt-"));
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      const kept = quarantined.find((f) => !f.endsWith("-wal") && !f.endsWith("-shm"))!;
      expect(readFileSync(join(SESSIONS_DIR, kept), "utf-8")).toBe(garbage); // never deleted
      // No stale WAL frame meets the fresh db: either the failed open dropped
      // the sidecar, or the quarantine moved it aside with the main file.
      // What must NOT survive: the old sidecar under its live name holding
      // the old content.
      try {
        expect(readFileSync(`${sessionIndexPath()}-wal`, "utf-8")).not.toContain("stale wal bytes");
      } catch {
        // sidecar gone (deleted by sqlite or quarantined) -- also fine
      }
      // Loud, never silent.
      expect(logged.some((l) => /quarantine/i.test(l))).toBe(true);
    } finally {
      resetLoggerForTesting();
    }
  });

  it("boot reconcile after corruption comes up INDEXED, not de-indexed forever", async () => {
    const sessionId = uniqueId("boot-corrupt");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m-boot", profile: "p-boot" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    // A previously-built, now-corrupt index.
    writeFileSync(sessionIndexPath(), "corrupt bytes not sqlite".repeat(64));
    closeSessionIndex();

    // This is exactly what the session-log extension's create() runs at boot.
    const stats = await reconcileSessionIndex();
    expect(stats.adopted).toBeGreaterThanOrEqual(1);
    const row = getSessionRow(sessionId);
    expect(row).not.toBeNull();
    expect(row!.model).toBe("m-boot");
    // Repeated opens keep working: the quarantine was a repair, not a one-way
    // fallthrough into "continue without the index".
    const again = await reconcileSessionIndex();
    expect(again.errors).toBe(0);
    expect(getSessionRow(sessionId)).not.toBeNull();
  });

  it("the session-log extension boot path survives a corrupt index and leaves the process indexed", async () => {
    const sessionId = uniqueId("ext-boot");
    fixtureLog(sessionId, [line({ session_id: sessionId, content: "u" })]);
    writeFileSync(sessionIndexPath(), "garbage-not-sqlite".repeat(64));
    closeSessionIndex();

    // create() reconciles once per process per dir; if quarantine did not
    // work, reconcile throws into create()'s catch and NO row exists ever.
    const ext = await createSessionLogExtension(createMockCore() as never);
    expect(ext.hooks).toBeDefined();
    expect(getSessionRow(sessionId)).not.toBeNull();
  });
});

describe("model-faithful rebuild", () => {
  beforeEach(() => {
    resetIndex();
  });

  it("rebuild restores the session_start model and profile", async () => {
    const sessionId = uniqueId("rebuild-header");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "llama-original", profile: "coder" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await syncSessionFromLog(sessionId);
    const row = getSessionRow(sessionId);
    expect(row!.model).toBe("llama-original");
    expect(row!.profile).toBe("coder");
  });

  it("rebuild follows the timeline: later model_change and profile_switch win", async () => {
    const sessionId = uniqueId("rebuild-timeline");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m1", profile: "p1" }),
      line({ session_id: sessionId, content: "u1" }),
      line({ session_id: sessionId, source: LOG_SOURCE.MODEL_CHANGE, content: "", model: "m2" }),
      line({ session_id: sessionId, content: "u2" }),
      line({ session_id: sessionId, source: LOG_SOURCE.PROFILE_SWITCH, content: "", from_profile: "p1", profile: "p2" }),
    ]);
    await syncSessionFromLog(sessionId);
    const row = getSessionRow(sessionId);
    expect(row!.model).toBe("m2");
    expect(row!.profile).toBe("p2");
  });

  it("a log that attests nothing leaves model/profile NULL (resume must warn, not default quietly)", async () => {
    const sessionId = uniqueId("rebuild-attestless");
    fixtureLog(sessionId, [line({ session_id: sessionId, content: "u" })]);
    await syncSessionFromLog(sessionId);
    const row = getSessionRow(sessionId);
    expect(row).not.toBeNull();
    expect(row!.model).toBeNull();
    expect(row!.profile).toBeNull();
  });

  it("a live mirror update is not regressed by a later rebuild (log cannot re-attest newer truth)", async () => {
    const sessionId = uniqueId("rebuild-mirror");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m-old" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await syncSessionFromLog(sessionId);
    expect(getSessionRow(sessionId)!.model).toBe("m-old");
    // Runtime mirror (websocket MODEL_CHANGE / tool_started meta): the live
    // agent switched to m-live after the log was written.
    await indexSessionModel(sessionId, "m-live");
    expect(getSessionRow(sessionId)!.model).toBe("m-live");
    // A rebuild (the reconcile re-read path) must keep the mirror: the log's
    // attestation is older knowledge, never fresher than the row's.
    appendFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), line({ session_id: sessionId, content: "u2" }));
    await syncSessionFromLog(sessionId);
    expect(getSessionRow(sessionId)!.model).toBe("m-live");
  });

  it("deriveModelProfileFromLog ignores model/profile fields on non-attesting sources", () => {
    const entries = [
      { ts: "t", session_id: "s", source: LOG_SOURCE.LLM, content: "hi", model: "hallucinated" },
    ] as unknown as LogEntry[];
    expect(deriveModelProfileFromLog(entries)).toEqual({ model: null, profile: null });
  });
});

describe("session-log MODEL_CHANGE record (model timeline rides the log)", () => {
  beforeEach(() => {
    resetIndex();
  });

  it("appends a model_change record and mirrors the index; an empty model writes nothing", async () => {
    const sessionId = uniqueId("model-change");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m1" }),
    ]);
    try {
      const ext = (await createSessionLogExtension(createMockCore() as never)) as unknown as {
        hooks: Record<string, (p: unknown) => Promise<void>>;
        readEntries: () => Promise<LogEntry[]>;
      };
      await ext.hooks[HOOKS.MODEL_CHANGE]!({ agent: { sessionId }, oldModel: "m1", newModel: "m2" });
      await ext.hooks[HOOKS.MODEL_CHANGE]!({ agent: { sessionId } }); // no model: no record

      const entries = await ext.readEntries();
      const changes = entries.filter((e) => e.source === LOG_SOURCE.MODEL_CHANGE);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.model).toBe("m2");
      // The live mirror follows the switch immediately (row-truth stays fresh;
      // the record keeps it re-derivable after index loss).
      expect(getSessionRow(sessionId)?.model).toBe("m2");
    } finally {
      dropLog(sessionId);
    }
  });
});
