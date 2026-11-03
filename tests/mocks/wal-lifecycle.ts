// walLifecycleProbe: does THIS bun binary's SQLite survive the two WAL
// lifecycle moments the durability suite depends on? bun on macOS links
// Apple's proprietary SQLite build whose WAL lifecycle breaks on macOS 26
// (oven-sh/bun#45171 family: bun disables SQLITE_FCNTL_PERSIST_WAL on
// darwin; IOERR_VNODE / 6922 is the "cannot map -shm" signature). The
// session index is pinned to journal_mode=WAL + synchronous=FULL (the
// durability contract), so on a host with broken lifecycle the
// crash-recovery tests can only fail -- or pass for the wrong (poisoned-
// WAL masking) reason. Loud skip is the only honest option. Both legs
// spawn real `process.execPath` children against a throwaway mkdtemp under
// TMP_PARENT; the probe process itself never opens sqlite. ANY throw or
// timeout makes that leg false -- the probe never throws up, never claims
// a pass it did not witness. Cached per process like
// bwrapAvailable/probeSeatbelt; `force` re-runs.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "./io.ts";

export interface WalLifecycle {
  /** crash child commits under WAL+FULL then is SIGKILLed; a fresh open
   *  reads the row back. The durability suite's definition-of-done in
   *  miniature. */
  recovery: boolean;
  /** a clean close of a WAL db leaves NO -wal AND NO -shm (checkpointed
   *  + unlinked). The quarantine "renames exactly 1 file" counts ride
   *  this. */
  cleanClose: boolean;
}

// Child: mirrors openPrepared's pragmas exactly. synchronous=FULL means the
// commit below already fsynced the WAL -- no extra fsync call exists to
// make, and the marker file (written after the committed INSERT) is the
// sync proof the parent polls. Modes:
//   crash: create+insert, marker, then park until SIGKILLed.
//   read:  fresh process, like the post-crash boot: print the row.
//   clean: create+insert, close, exit.
const CHILD_SRC = `
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [mode, dbPath, marker] = process.argv.slice(2);
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = FULL;");
if (mode === "crash") {
  db.exec("CREATE TABLE probe (x INTEGER)");
  db.run("INSERT INTO probe (x) VALUES (42)");
  writeFileSync(marker, "committed");
  const park = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(park, 0, 0, 3_600_000); // hang until killed
} else if (mode === "clean") {
  db.exec("CREATE TABLE probe (x INTEGER)");
  db.run("INSERT INTO probe (x) VALUES (42)");
  db.close(); // last close: checkpoint + unlink sidecars
} else if (mode === "read") {
  const row = db.query("SELECT x FROM probe LIMIT 1").get();
  process.stdout.write(row ? "row=" + row.x + "\\n" : "missing\\n");
  db.close();
} else {
  process.exit(2);
}
`;

const READY_MS = 8_000; // spawn + WAL open + fsynced commit on a cold CI mac
const SPAWN_MS = 15_000; // generous: recovery open on a slow runner

let cached: WalLifecycle | undefined;

export function walLifecycleProbe(force = false): WalLifecycle {
  if (cached !== undefined && !force) return cached;
  cached = runProbe();
  return cached;
}

function runProbe(): WalLifecycle {
  let dir: string;
  try {
    dir = mkdtempSync(join(TMP_PARENT, "hotdog-wal-probe-"));
  } catch {
    return { recovery: false, cleanClose: false };
  }
  try {
    const child = join(dir, "wal-child.ts");
    writeFileSync(child, CHILD_SRC);
    return {
      recovery: tryLeg(() => legRecovery(dir, child)),
      cleanClose: tryLeg(() => legCleanClose(dir, child)),
    };
  } catch {
    return { recovery: false, cleanClose: false };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort, same as the seatbelt probe.
    }
  }
}

/** Any throw or timeout makes the leg false: a leg can only pass by
 *  witnessing its outcome. */
function tryLeg(leg: () => boolean): boolean {
  try {
    return leg();
  } catch {
    return false;
  }
}

function legRecovery(dir: string, child: string): boolean {
  const dbPath = join(dir, "recovery.sqlite");
  const marker = join(dir, "crash-committed");
  const doomed = Bun.spawn([process.execPath, child, "crash", dbPath, marker], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    // Poll for the fsynced commit; a child that dies BEFORE the marker
    // (e.g. IOERR_VNODE on the WAL open itself) just starves the deadline.
    const deadline = Date.now() + READY_MS;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) return false;
      Bun.sleepSync(20);
    }
    process.kill(doomed.pid, 9); // kill -9, the suite's crash
  } finally {
    try {
      process.kill(doomed.pid, 9); // starved/crashed path: never leak a parked bun
    } catch {
      // already dead -- ESRCH is the normal success signal here
    }
  }
  // Fresh process reopens the poisoned-looking WAL -- this exact open is
  // what throws SQLITE_IOERR_VNODE on the broken Apple build.
  const r = Bun.spawnSync([process.execPath, child, "read", dbPath], { timeout: SPAWN_MS });
  return r.exitCode === 0 && r.stdout.toString().includes("row=42");
}

function legCleanClose(dir: string, child: string): boolean {
  const dbPath = join(dir, "clean.sqlite");
  const r = Bun.spawnSync([process.execPath, child, "clean", dbPath], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: SPAWN_MS,
  });
  if (r.exitCode !== 0) return false;
  // Sidecars that ride a "clean" close turn the quarantine into a 3-file
  // rename where the count assertion expects 1.
  return !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`);
}
