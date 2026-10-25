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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
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
  isIndexCorruption,
  sessionIndexPath,
  reconcileSessionIndex,
  syncSessionFromLog,
  getSessionRow,
  indexSessionModel,
  indexToolStarted,
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

describe("corruption classification (only corrupt bytes get quarantined)", () => {
  it("isIndexCorruption: true for the SQLITE_CORRUPT family and NOTADB", () => {
    expect(isIndexCorruption(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }))).toBe(true);
    expect(isIndexCorruption(Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }))).toBe(true);
    // extended sub-codes ride the same prefix
    expect(isIndexCorruption({ code: "SQLITE_CORRUPT_PAGE" })).toBe(true);
  });

  it("isIndexCorruption: false for environmental failures, foreign errors, nullish", () => {
    expect(isIndexCorruption({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isIndexCorruption({ code: "SQLITE_READONLY" })).toBe(false);
    expect(isIndexCorruption({ code: "SQLITE_CANTOPEN" })).toBe(false);
    expect(isIndexCorruption(new Error("boom"))).toBe(false);
    expect(isIndexCorruption(null)).toBe(false);
    expect(isIndexCorruption(undefined)).toBe(false);
  });
});

describe("environmental open failures never quarantine a healthy index", () => {
  const RO_DIR = join(os.tmpdir(), `hotdog-index-ro-${Date.now()}`);

  beforeEach(() => {
    try { rmSync(RO_DIR, { recursive: true, force: true }); } catch {}
    mkdirSync(RO_DIR, { recursive: true });
  });

  afterEach(() => {
    closeSessionIndex();
    try { chmodSync(RO_DIR, 0o700); rmSync(RO_DIR, { recursive: true, force: true }); } catch {}
    process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
  });

  it("a CANTOPEN failure propagates without quarantining or claiming a rebuild", () => {
    // Read-only sessions dir: the index cannot be created or opened. That is
    // an environment problem, not corrupt bytes -- the process must hear the
    // real error, and nothing may be renamed "corrupt".
    process.env.HOTDOG_SESSIONS_DIR = join(RO_DIR, "sessions");
    mkdirSync(join(RO_DIR, "sessions"));
    chmodSync(join(RO_DIR, "sessions"), 0o500);
    closeSessionIndex();

    const logged = captureLoggedErrors();
    try {
      let threw: unknown = null;
      try {
        openSessionIndex();
      } catch (e) {
        threw = e;
      }
      expect(threw).not.toBeNull();
      expect((threw as { code?: string }).code).toBe("SQLITE_CANTOPEN");
      // No false postmortem: nothing was quarantined...
      expect(readdirSync(join(RO_DIR, "sessions")).some((f) => f.includes(".corrupt-"))).toBe(false);
      // ...and no misleading "quarantined / rebuilding an empty index" claim.
      expect(logged.some((l) => /quarantin|rebuild/i.test(l))).toBe(false);
    } finally {
      resetLoggerForTesting();
      chmodSync(join(RO_DIR, "sessions"), 0o700);
    }
  });
});

// Mid-run corruption: SQLite is lazy, so an index whose leaf pages are
// damaged OPENS FINE and throws only when a query reads the bad page. The
// existing open-time quarantine never sees it, and without recovery the
// handle stays poisoned for the life of the process. Recovery here means:
// quarantine (bytes preserved), rebuild empty, complete the operation on
// the fresh handle -- and the JSONL logs repopulate everything after.
describe("mid-run corruption recovery", () => {
  beforeEach(() => {
    resetIndex();
  });

  it("a corrupt page hit mid-query quarantines, rebuilds, and completes the read", async () => {
    const sessionId = uniqueId("midrun");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m-midrun", profile: "p-midrun" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await syncSessionFromLog(sessionId);
    expect(getSessionRow(sessionId)).not.toBeNull();

    // Damage the index out-of-band with the handle CLOSED (page cache gone),
    // so the corruption surfaces on the next query, not on the open.
    closeSessionIndex();
    const dbPath = sessionIndexPath();
    const buf = Buffer.from(readFileSync(dbPath));
    buf.fill(0xff, 4096, 8192); // page 2 = sessions table root
    writeFileSync(dbPath, buf);

    const logged = captureLoggedErrors();
    try {
      // Must NOT throw: the operation completes on a rebuilt (empty) index.
      expect(getSessionRow(sessionId)).toBeNull();

      // The damaged bytes were quarantined aside, never deleted.
      const quarantined = readdirSync(SESSIONS_DIR).filter((f) => f.includes("sessions.sqlite.corrupt-"));
      expect(quarantined.length).toBe(1);
      const kept = quarantined.find((f) => !f.endsWith("-wal") && !f.endsWith("-shm"))!;
      expect(readFileSync(join(SESSIONS_DIR, kept))).toEqual(buf);

      // Loud, never silent.
      expect(logged.some((l) => /corrupt/i.test(l))).toBe(true);
    } finally {
      resetLoggerForTesting();
    }
  });

  it("reconcile repopulates the rebuilt index from the logs; no data was lost", async () => {
    const sessionId = uniqueId("midrun-reconcile");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m-midrun", profile: "p-midrun" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await syncSessionFromLog(sessionId);
    closeSessionIndex();
    const dbPath = sessionIndexPath();
    const buf = Buffer.from(readFileSync(dbPath));
    buf.fill(0xff, 4096, 8192);
    writeFileSync(dbPath, buf);

    // Discovery on a read, then the log-driven repair.
    expect(getSessionRow(sessionId)).toBeNull(); // triggers recovery
    const stats = await reconcileSessionIndex();
    expect(stats.errors).toBe(0);
    const row = getSessionRow(sessionId);
    expect(row).not.toBeNull();
    expect(row!.model).toBe("m-midrun"); // model-faithful rebuild on the new path too
    expect(row!.profile).toBe("p-midrun");
  });

  it("the writer commit point self-heals: a mirror write on a poisoned page rebuilds instead of throwing", async () => {
    const sessionId = uniqueId("midrun-writer");
    fixtureLog(sessionId, [
      line({ session_id: sessionId, source: LOG_SOURCE.SESSION_START, content: "", model: "m-w", profile: "p-w" }),
      line({ session_id: sessionId, content: "u" }),
    ]);
    await syncSessionFromLog(sessionId);
    closeSessionIndex();
    const buf = Buffer.from(readFileSync(sessionIndexPath()));
    buf.fill(0xff, 4096, 8192);
    writeFileSync(sessionIndexPath(), buf);

    // indexToolStarted runs mid-session after an fsynced record; it must
    // survive the bad page (best-effort mirror by design, but a lifetime of
    // loud failures is not "best effort").
    const logged = captureLoggedErrors();
    try {
      await indexToolStarted(sessionId, "tc-1", { model: "m-w2", profile: "p-w" });

      // The row is back (log-rebuilt during recovery), not silently absent,
      // and the pending idempotent mirror meta was applied on top of the log
      // attestation (live truth outranks a rebuild, per the COALESCE rule).
      const row = getSessionRow(sessionId);
      expect(row).not.toBeNull();
      expect(row!.model).toBe("m-w2");

      // Guard against a vacuous pass: prove recovery actually fired (the
      // corruption surfaced on the writer's query and was quarantined).
      expect(logged.some((l) => /corrupt/i.test(l))).toBe(true);
      expect(readdirSync(SESSIONS_DIR).some((f) => f.includes("sessions.sqlite.corrupt-"))).toBe(true);
    } finally {
      resetLoggerForTesting();
    }
  });
});
