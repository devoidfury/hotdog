// The codemode run store: one directory per run under
// `joinDataDir("codemode")/<runId>`. The journal (`run.jsonl`, append-only,
// one JSON object per line, fsync'd before `append` resolves so a record is
// on disk before the act it describes takes effect) lives in the run dir
// PROPER; the child's scratch -- the dir bound as /tmp inside the fence -- is
// the `scratch/` SUBDIR (created HOST-side; bwrap bind sources must exist).
// The jailed script can therefore never reach the journal: the jail's rw
// surface is the subdir, the run dir itself never enters the plan. A durable
// record a script could forge or truncate is not one.
//
// Lines are caller-supplied plain JSON objects; `ts` is stamped when absent.
// Readers fold tolerantly: a torn tail or a foreign line is inert noise
// (parseJsonLines "warn").
//
// The store is journal-backed the same way: `store.jsonl` under the runs
// root, append-only `store_set` lines that ARE the committed
// state (fold: last write per key wins). Quotas live here and count ENTRY
// bytes (key + JSON value): 1 KiB key cap, 256 KiB/value, 1 MiB total,
// <=4096 entries (the count bounds per-line framing -- runId/ts -- so the
// committed file, the pending overlay, and every re-fold stay bounded even
// at tiny values), JSON only. A run's writes stay in memory (the StoreSession
// overlay) until the script ends OK, and only then commit -- one batched
// fsync'd append. A failed or killed script commits nothing.

import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { joinDataDir } from "@core/session/session-log.ts";
import { parseJsonLines } from "@utils/json-lines.ts";
import {
  STORE_KEY_MAX_BYTES,
  STORE_MAX_ENTRIES,
  STORE_TOTAL_MAX_BYTES,
  STORE_VALUE_MAX_BYTES,
} from "./options.ts";

export const RUN_JOURNAL_FILE = "run.jsonl";

/** Session-scoped store backing: a file under the data dir, surviving runs,
 *  not branch-scoped. */
export const STORE_FILE = "store.jsonl";

export type JournalLine = Record<string, unknown>;

/** Root for all codemode run dirs: `<data-dir>/codemode`. */
export function codemodeRunsRoot(): string {
  return joinDataDir("codemode");
}

/** Directory identity for one run (journal + jail scratch). */
export function runDirFor(runId: string): string {
  return join(codemodeRunsRoot(), runId);
}

/** The jail's writable scratch (bound as /tmp) -- a subdir so the journal in
 *  the run dir proper stays out of the script's reach. */
export function scratchDirFor(runDir: string): string {
  return join(runDir, "scratch");
}

/**
 * Fresh run id: date-ordered stamp plus entropy, safe to embed in a path
 * ([a-z0-9][a-z0-9._-]*), unique per call within a second across processes
 * (pid) and within a process (random).
 */
export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One run's append-only journal. The handle stays open for the run's
 * lifetime: lines append in order, and every append fsyncs BEFORE resolving
 * -- whatever happens to the host afterwards, the line is there. Appends
 * serialize on an internal queue (concurrent callers keep line order), which
 * is what lets parallel dispatches journal without interleaving.
 */
export class RunJournal {
  #fh: FileHandle | null;
  #tail: Promise<void> = Promise.resolve();

  private constructor(fh: FileHandle) {
    this.#fh = fh;
  }

  /** Creates the run dir when missing (the jail scratch appears with it). */
  static async open(runDir: string): Promise<RunJournal> {
    await mkdir(runDir, { recursive: true });
    return new RunJournal(await open(join(runDir, RUN_JOURNAL_FILE), "a"));
  }

  async append(ev: JournalLine): Promise<void> {
    const line = `${JSON.stringify({ ...ev, ts: ev.ts ?? new Date().toISOString() })}\n`;
    await this.#enqueue(line);
  }

  /** Batch append (one write + one fsync): the settle-time output record. */
  async appendMany(evs: readonly JournalLine[]): Promise<void> {
    if (evs.length === 0) return;
    const lines = evs
      .map((ev) => `${JSON.stringify({ ...ev, ts: ev.ts ?? new Date().toISOString() })}\n`)
      .join("");
    await this.#enqueue(lines);
  }

  #enqueue(payload: string): Promise<void> {
    const write = this.#tail.then(async () => {
      if (!this.#fh) throw new Error("codemode journal already closed");
      await this.#fh.appendFile(payload);
      await this.#fh.sync();
    });
    // The queue survives a failed write; the failure still rejects THIS
    // caller (the caller's durability promise is the point of fsync).
    this.#tail = write.catch(() => {});
    return write;
  }

  async close(): Promise<void> {
    // Close after everything already queued: settle-time ordering means the
    // output record and run_finished land, not evaporate behind a close().
    const fh = this.#fh;
    await this.#tail.catch(() => {});
    this.#fh = null;
    if (fh) await fh.close();
  }
}

/** Disk view of a run's journal; [] when the file does not exist yet. */
export async function readRunJournal(runDir: string): Promise<JournalLine[]> {
  const text = await readFile(join(runDir, RUN_JOURNAL_FILE), "utf8").catch(() => null);
  if (text === null) return [];
  return parseJsonLines<JournalLine>(text, "warn", "codemode-journal");
}

// ── store() / load() backing ─────────────────────────────────────────────────

export interface StoreEntry {
  value: unknown;
  /** Key bytes + serialized (JSON) value bytes -- what both quotas count:
   *  a key costs the same to store, commit, and re-fold as a value does. */
  bytes: number;
}

export function storeFilePath(): string {
  return join(codemodeRunsRoot(), STORE_FILE);
}

/** ENTRY bytes (key + JSON value) of one store write. */
export function storeEntryBytes(key: string, value: unknown): number {
  return (
    Buffer.byteLength(key) +
    Buffer.byteLength(JSON.stringify(value) ?? "null")
  );
}

/** Fold the committed store: last `store_set` per key wins; a torn or
 *  foreign line is inert noise (the fsync'd batch append means a partial
 *  commit can only ever lose whole lines). */
export async function readStoreState(): Promise<Map<string, StoreEntry>> {
  const text = await readFile(storeFilePath(), "utf8").catch(() => null);
  const state = new Map<string, StoreEntry>();
  if (text === null) return state;
  for (const line of parseJsonLines<JournalLine>(text, "warn", "codemode-store")) {
    if (line.ev !== "store_set" || typeof line.key !== "string") continue;
    const entry: StoreEntry = { value: line.value, bytes: storeEntryBytes(line.key, line.value) };
    state.set(line.key, entry);
  }
  return state;
}

/**
 * One run's store: the committed snapshot (folded at open) overlaid with
 * this run's pending writes. `set` answers the quota verdict up front (so
 * the script's rejected store() carries the reason), but touches only
 * memory -- the durable commit happens once, on script success, as one
 * batched fsync'd append. Failed/killed runs simply never call commit.
 * NOTE (v1 semantics): the total-quota view is the snapshot folded at open,
 * so two CONCURRENT runs can each commit up to the cap (a commit-time
 * recheck would close that window; runs are already rare next to the cap).
 */
export class StoreSession {
  #committed: Map<string, StoreEntry>;
  #pending = new Map<string, StoreEntry>();
  #total: number;

  private constructor(committed: Map<string, StoreEntry>) {
    this.#committed = committed;
    this.#total = [...committed.values()].reduce((n, e) => n + e.bytes, 0);
  }

  /** The committed quota check is lazy at the first store/load frame, so a
   *  run that never touches the store never reads the file. */
  static async open(): Promise<StoreSession> {
    return new StoreSession(await readStoreState());
  }

  /** Committed ∪ pending (read-your-writes inside the run). */
  lookup(key: string): StoreEntry | undefined {
    return this.#pending.get(key) ?? this.#committed.get(key);
  }

  /** Quota-check and stage. Returns an error message, or null when
   *  the write is queued for the success-time commit. Every quota counts
   *  ENTRY bytes (key + JSON value): a 500 KB key is not free storage. The
   *  entry-count cap bounds pending-overlay RAM, commit size, and
   *  store.jsonl's per-line framing overhead (runId/ts) all at once. */
  set(key: string, value: unknown): string | null {
    if (!key) return "store: key must be a non-empty string";
    const keyBytes = Buffer.byteLength(key);
    if (keyBytes > STORE_KEY_MAX_BYTES) {
      return `store: key is ${keyBytes} bytes, over the ${STORE_KEY_MAX_BYTES}-byte key cap`;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return "store: value is not JSON-serializable (JSON only)";
    }
    if (json === undefined) {
      return "store: value is required -- undefined is not a JSON value";
    }
    const valueBytes = Buffer.byteLength(json);
    const bytes = keyBytes + valueBytes;
    if (bytes > STORE_VALUE_MAX_BYTES) {
      return (
        `store: entry is ${bytes} bytes (key ${keyBytes} + value ${valueBytes}), ` +
        `over the ${STORE_VALUE_MAX_BYTES}-byte per-value cap`
      );
    }
    const live = this.lookup(key);
    if (!live && this.#committed.size + this.#pending.size >= STORE_MAX_ENTRIES) {
      return `store: the store holds at most ${STORE_MAX_ENTRIES} entries`;
    }
    const nextTotal = this.#total - (live?.bytes ?? 0) + bytes;
    if (nextTotal > STORE_TOTAL_MAX_BYTES) {
      return `store: total store would be ${nextTotal} bytes, over the ${STORE_TOTAL_MAX_BYTES}-byte cap`;
    }
    this.#pending.set(key, { value, bytes });
    this.#total = nextTotal;
    return null;
  }

  /** The commit point: append this run's writes to the store journal, one
   *  batched fsync, then fold them into the committed view. */
  async commit(runId: string): Promise<number> {
    if (this.#pending.size === 0) return 0;
    const batch = [...this.#pending].map(([key, entry]) =>
      JSON.stringify({
        ev: "store_set",
        runId,
        key,
        value: entry.value,
        bytes: entry.bytes,
        ts: new Date().toISOString(),
      }),
    );
    const fh = await open(storeFilePath(), "a");
    try {
      await fh.appendFile(`${batch.join("\n")}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // #total already counts the pending overlay; the commit only merges
    // pending into the committed map.
    for (const [key, entry] of this.#pending) this.#committed.set(key, entry);
    const n = this.#pending.size;
    this.#pending.clear();
    return n;
  }
}
