/**
 * Cross-process task-lane slot ledger
 *
 * `taskLanesPerProvider` bounds concurrent task agents on the *machine*, not
 * per process: an interactive session, a foreground `hotdog workflow run`,
 * and any other hotdog process all hit the same llama-swap endpoint. The
 * ledger is a filesystem counting semaphore: one directory per provider lane
 * under `dir`, up to `cap` numbered slot files. A slot is taken by an atomic
 * exclusive create (fs-atomic: contents and existence land as one event, so a
 * held slot can never read as an empty/corrupt file mid-write); a slot whose
 * marker is corrupt, names a dead pid on this host, names THIS process
 * without a live lease object (the missed-release watchdog, see
 * `processSlots`), or has stopped beating (see below) is reclaimed by renaming
 * a temporary claiming marker ONTO the slot: rename replaces atomically, so
 * while a slot is held (or being
 * reclaimed) the path never momentarily lacks a file and a concurrent
 * acquirer's exclusive create can never slip into a gap beside a live holder
 * (closing the old rename-aside protocol's over-admission window). A reclaim
 * finalizes by reading back: the last rename stands, and a reclaimer that
 * sees a rival's marker simply gives the slot up untouched, so a loser never
 * clobbers or deletes the winner's marker.
 *
 * Heartbeat leases: every holder refreshes its slot's mtime on a timer
 * (`#beat`), so liveness is provable by ANY reader, on any host. A slot whose
 * heartbeat has gone quiet for `leaseMs` is reclaimable whatever its marker
 * claims -- foreign host, live-looking pid, suspended holder. This is what
 * makes a shared ledger dir safe when host identity is not stable (a config
 * dir mounted into containers, where the hostname is a container id that
 * changes every run): without the heartbeat, the foreign-host rule below is a
 * permanent wedge that only a manual delete clears, and a recycled pid can
 * read as a live holder.
 *
 * Fresh heartbeat + foreign host is still occupied: the safe failure remains
 * under-admission while the owner is demonstrably still beating. A holder that
 * stalls past `leaseMs` without dying (SIGSTOP, a laptop sleep, a synchronous
 * block longer than the lease) loses its slot, and the lane then over-admits
 * by one until it notices -- token-checked release means it cannot evict the
 * new holder, it just runs alongside for a turn.
 *
 * Missed-release watchdog (`processSlots`): a marker naming a live pid is
 * otherwise unreclaimable, so a leaked lease -- a dropped slot file unlink, a
 * release that never ran -- would strand that lane for the rest of the
 * process's life and every waiter behind it. This process therefore registers
 * every lease it takes in a module-level `WeakRef` table; a marker whose pid
 * is ours with no reachable lease object is treated as free and reclaimed. It
 * is exactly the lease the caller dropped on the floor: a slot in use is
 * referenced by its holder (TaskEntry.lease, or the bus's turn-scoped
 * release). Reclaim lands on a GC tick, not the instant of the leak. Other
 * processes see the same marker as live only while its heartbeat stays fresh.
 *
 * Residual race (deliberate): two reclaimers that judged the *same* stale
 * marker can both rename onto the slot; ordering decides, and a read-back
 * that lands before a rival's rename misreports a win, stranding one phantom
 * lease on a slot whose prior holder was already dead. That is strictly
 * narrower than the momentary-absence window it replaces, and a phantom's
 * release is token-checked, so it cannot evict the true holder.
 *
 * Filesystem errors THROW to the caller, which fails open: an unusable state
 * dir must not deadlock every task. Occupied is not an error -- acquire
 * returns null and the caller queues.
 */

import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createExclusive } from "@utils/fs-atomic.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "../error.ts";

/** Interval between mtime refreshes on a held slot. */
export const DEFAULT_LANE_HEARTBEAT_MS = 15_000;
/**
 * A slot quiet for this long has no live holder, whoever its marker names.
 * Sized well above the heartbeat so a stalled-but-alive beat never trips, and
 * above any clock skew between hosts sharing the ledger dir (mtime is written
 * by the holder's clock and compared against ours).
 */
export const DEFAULT_LANE_LEASE_MS = 120_000;

/**
 * Holders must keep the EXACT object `acquire()` returned for as long as the
 * slot is in use: the missed-release watchdog identifies live leases by
 * object reachability (`processSlots`), so a reconstructed or field-copied
 * lease reads as leaked and its slot gets reclaimed out from under it.
 */
export interface LaneLease {
  lane: string;
  path: string;
  token: string;
}

export interface LaneLedgerOptions {
  dir: string;
  /** Test seams: identity + liveness for stale-slot reclaims. */
  pid?: number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
  /** Test seams: heartbeat cadence and the quiet-period after which a slot is dead. */
  heartbeatMs?: number;
  leaseMs?: number;
}

/**
 * Slot contents. Written once and never rewritten: liveness lives in file's mtime (refreshed by `#beat`).
 */
interface SlotMarker {
  pid: number;
  host: string;
  token: string;
}

/**
 * Missed-release watchdog: every lease this process holds, weakly. A slot
 * marker written by this pid whose token is absent here (or whose lease
 * object has been collected) has no owner left in the only process that could
 * release it -- a lost handle or a release() that failed after unregistering
 * -- so the next acquire reclaims it instead of queueing behind a ghost.
 * Foreign processes still see the marker as live (pid-liveness rule).
 */
const processSlots = new Map<string, WeakRef<LaneLease>>();

/** Test seam: watchdog table size. Orphaned entries are this module's leak mode. */
export function processSlotCount(): number {
  return processSlots.size;
}

function pidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM"; // exists, not ours
  }
}

function parseMarker(text: string): SlotMarker | null {
  try {
    const m = JSON.parse(text) as SlotMarker;
    if (typeof m?.pid !== "number" || typeof m?.host !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

export class LaneLedger {
  #dir: string;
  #pid: number;
  #host: string;
  #pidAlive: (pid: number) => boolean;
  #heartbeatMs: number;
  #leaseMs: number;
  /** Held slots to heartbeat, by token. Timer runs only while non-empty. */
  #held = new Map<string, string>();
  #hb: ReturnType<typeof setInterval> | null = null;
  #beating = false;

  constructor(opts: LaneLedgerOptions) {
    this.#dir = opts.dir;
    this.#pid = opts.pid ?? process.pid;
    this.#host = opts.host ?? hostname();
    this.#pidAlive = opts.pidAlive ?? pidAliveDefault;
    this.#heartbeatMs =
      typeof opts.heartbeatMs === "number" && opts.heartbeatMs >= 1
        ? opts.heartbeatMs
        : DEFAULT_LANE_HEARTBEAT_MS;
    this.#leaseMs =
      typeof opts.leaseMs === "number" && opts.leaseMs >= 1 ? opts.leaseMs : DEFAULT_LANE_LEASE_MS;
  }

  /** Lane "" (bare model names) gets a literal "_" dir; names are percent-encoded. */
  laneDir(lane: string): string {
    return join(this.#dir, lane === "" ? "_" : encodeURIComponent(lane));
  }

  /**
   * Take a slot on `lane` (cap >= 1 slots). null when every slot has a live owner:
   * its own lease in this process, a fresh heartbeat, or (same host) a pid that is still alive.
   * Slots we can heartbeat -- ours -- are never blocked by their own staleness.
   */
  async acquire(lane: string, cap: number): Promise<LaneLease | null> {
    const dir = this.laneDir(lane);
    await mkdir(dir, { recursive: true });
    const token = `${this.#pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const marker = `${JSON.stringify({
      pid: this.#pid,
      host: this.#host,
      token,
    } satisfies SlotMarker)}\n`;
    // Register before any file write: a marker of ours that reaches disk is
    // never momentarily orphaned in `processSlots` (else a rival acquirer in
    // this process could watchdog-reclaim our slot out from under us).
    const lease: LaneLease = { lane, path: "", token };
    processSlots.set(token, new WeakRef(lease));
    let claimed = false;
    const won = (path: string): LaneLease => {
      claimed = true;
      lease.path = path;
      this.#startBeating(token, path);
      return lease;
    };
    try {
      const holders: string[] = [];
      for (let i = 0; i < cap; i++) {
        const path = join(dir, `slot-${i}`);
        if (await createExclusive(path, marker)) return won(path);

        const raw = await this.#readSafe(path);
        if (raw === null) {
          // Released while we were looking. Retry the exclusive create: under
          // this protocol an absent slot never HIDES a live marker (contents
          // only leave via atomic-rename takeover or token-checked release), so
          // creating here cannot slip in beside a live holder the way the old
          // rename-aside reclaim did.
          if (await createExclusive(path, marker)) return won(path);
          continue; // a rival create won
        }
        const cur = parseMarker(raw);
        // Read-then-stat ordering is deliberate: an intervening takeover makes the stat fresher than the content we judged,
        // which reads as occupied (under-admission). The reverse order could hand a live holder's fresh marker a stale timestamp and steal it.
        const quiet = await this.#isQuiet(path);
        if (quiet === null) continue; // vanished between read and stat
        if (this.#occupied(cur, !quiet)) {
          holders.push(
            `slot-${i}=${cur ? `pid ${cur.pid}@${cur.host}` : "corrupt"}`,
          );
          continue;
        }
        // Corrupt, dead on this host, or heartbeat gone: take the slot over
        // without ever letting it look free. Our marker is renamed onto the old
        // one atomically.
        if (await this.#reclaimInPlace(path, marker, token)) {
          logger.debug(
            `[lanes] reclaimed ${quiet ? "quiet" : "dead/leaked"} slot ${path}` +
              (cur ? ` (was pid ${cur.pid}@${cur.host})` : ""),
          );
          return won(path);
        }
        // A rival reclaimer's rename landed last; its marker is judged next pass.
      }
      if (holders.length === cap) {
        logger.debug(`[lanes] lane '${lane || "_"}' full (cap ${cap}): ${holders.join(", ")}`);
      }
      return null;
    } finally {
      // Never took a slot -- including a mid-loop fs throw, whose error the
      // caller swallows into a fail-open retry: no ghost registrations, or a
      // broken state dir would grow `processSlots` one entry per retry tick.
      if (!claimed) processSlots.delete(token);
    }
  }

  /**
   * Release a lease. A no-op when the file is gone or now belongs to someone
   * else (token mismatch: we were reclaimed as stale and the slot re-taken).
   * The watchdog unregisters only AFTER the unlink completes: while an
   * in-flight release could still rm the slot, its token must keep reading
   * as held (the `lease` parameter also roots the object), or a same-process
   * acquirer could orphan-reclaim the slot in the read->rm window and the
   * pending `rm` would then force-delete the new owner's marker. Once release
   * returns, a failed unlink still self-heals: the dropped lease object fails
   * the WeakRef check and the next acquirer reclaims.
   */
  async release(lease: LaneLease): Promise<void> {
    this.#held.delete(lease.token);
    if (this.#held.size === 0 && this.#hb) {
      clearInterval(this.#hb);
      this.#hb = null;
    }
    let raw: string | null;
    try {
      raw = await readFile(lease.path, "utf8");
    } catch {
      processSlots.delete(lease.token);
      return; // already gone
    }
    const m = parseMarker(raw);
    if (m && m.token !== lease.token) {
      processSlots.delete(lease.token);
      return; // not ours anymore; never delete a live slot
    }
    try {
      await rm(lease.path, { force: true });
    } finally {
      processSlots.delete(lease.token);
    }
  }

  /**
   * Occupancy of a slot whose marker parsed.
   *
   * Our own live lease first, and freshness cannot touch it: we know what this
   * process holds, and a beat that failed on a hiccup must not make us
   * double-book our own lane (other processes may still take a quiet slot --
   * that tradeoff is the price of cross-host liveness, and `#beat` reports it).
   *
   * Everything else is heartbeat-first. A quiet slot is free whoever it names,
   * which is what makes the ledger survivable when neither half of the old
   * identity story holds: a config dir mounted into containers has no stable
   * hostname and no meaningful pid space, and a shared NFS ledger cannot read
   * another machine's process table. A fresh heartbeat is then occupied, except
   * on this host where a dead -- or recycled, identity-less -- pid still says
   * free.
   */
  #occupied(m: SlotMarker | null, fresh: boolean): boolean {
    if (m === null) return false; // corrupt: a writer died mid-create
    if (m.host === this.#host && m.pid === this.#pid) {
      const ref = processSlots.get(m.token);
      if (ref === undefined) return false; // no owner here: leaked marker
      if (ref.deref() === undefined) {
        processSlots.delete(m.token);
        return false; // lease object was dropped without a release
      }
      return true;
    }
    if (!fresh) return false;
    if (m.host !== this.#host) return true; // beating, and not ours to judge further
    return this.#pidAlive(m.pid);
  }

  /**
   * True when the slot's mtime is older than the lease. `null` = the file
   * vanished mid-look (judge it again next pass). A stat failure that is not
   * ENOENT throws to the caller's fail-open path: an fs we cannot stat is not
   * evidence anyone died, so it must never read as "quiet" and free the slot.
   */
  async #isQuiet(path: string): Promise<boolean | null> {
    let st;
    try {
      st = await stat(path);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") return null;
      throw e;
    }
    return Date.now() - st.mtimeMs > this.#leaseMs;
  }

  /**
   * Start refreshing `path`'s mtime. Unref'd: bookkeeping must never be the
   * reason a process stays alive (a session with nothing left but a leaked
   * lease should exit, and the heartbeat expiry is what frees its lane).
   */
  #startBeating(token: string, path: string): void {
    this.#held.set(token, path);
    if (this.#hb) return;
    const timer = setInterval(() => void this.#beat(), this.#heartbeatMs);
    timer.unref();
    this.#hb = timer;
  }

  /**
   * Refresh every held slot we still own. The read-back is not redundant:
   * touching a slot a reclaimer handed to someone else would keep renewing
   * that holder's lease from the outside, so a beat only ever lands on a
   * marker carrying our own token. Losing the slot stops the beat, and says
   * so loudly -- a silent lease loss is how a lane ends up over-admitted.
   */
  async #beat(): Promise<void> {
    if (this.#beating) return; // a slow/stalled fs must not stack beats behind a timer
    this.#beating = true;
    try {
      await this.#beatAll();
    } finally {
      this.#beating = false;
    }
  }

  async #beatAll(): Promise<void> {
    for (const [token, path] of [...this.#held]) {
      // Refresh only what this process still actually holds. A lease the
      // caller dropped without releasing must NOT keep renewing its slot: the
      // whole point of the watchdog is that a ghost lease becomes reclaimable,
      // and a perpetually-renewed mtime would make it un-reclaimable from
      // another host, where the WeakRef check is invisible.
      const ref = processSlots.get(token);
      if (ref === undefined || ref.deref() === undefined) {
        // No lease object left to release this slot: stop renewing, and prune a
        // collected watchdog entry so the ghost reads as free immediately on this
        // host instead of refreshing forever.
        this.#held.delete(token);
        if (ref) processSlots.delete(token);
        continue;
      }
      let raw: string | null;
      try {
        raw = await readFile(path, "utf8");
      } catch (e: unknown) {
        if ((e as { code?: string }).code === "ENOENT") {
          this.#held.delete(token); // released elsewhere or cleaned up by hand
        } else {
          // A read blip is not evidence we lost the slot; stopping here would
          // expire a live lease on a transient fs hiccup and over-admit the lane.
          logger.debug(`[lanes] slot heartbeat read failed: ${formatError(e)}`);
        }
        continue;
      }
      const m = parseMarker(raw);
      if (!m || m.token !== token) {
        // Reclaimed as stale: our lease no longer stands. Drop both
        // registrations -- keeping the watchdog entry would advertise a lease
        // we can no longer release.
        this.#held.delete(token);
        processSlots.delete(token);
        logger.warn(`[lanes] lost slot ${path} (reclaimed as stale)`);
        continue;
      }
      try {
        const now = new Date();
        await utimes(path, now, now);
      } catch (e: unknown) {
        // Transient fs trouble: keep the registration and retry next beat.
        logger.debug(`[lanes] slot heartbeat failed: ${formatError(e)}`);
      }
    }
    if (this.#held.size === 0 && this.#hb) {
      clearInterval(this.#hb);
      this.#hb = null;
    }
  }

  async #readSafe(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Take over a slot whose present marker we judged free (corrupt, dead
   * same-host pid, or heartbeat quiet). Our marker is written to a sibling
   * temp file and renamed
   * ONTO the slot: rename(2) replaces the target atomically, so the slot path
   * is never momentarily absent -- no window for a third acquirer to create
   * beside a holder. Verify by read-back: our token in place means the
   * takeover stands; a rival's token means we lost and give the slot up
   * without touching it. A filesystem error is thrown so the caller fails
   * open, like every other ledger fs failure.
   */
  async #reclaimInPlace(path: string, marker: string, token: string): Promise<boolean> {
    const tmp = `${path.slice(0, path.lastIndexOf("/") + 1)}.slot.claiming-${this.#pid}-${token}`;
    try {
      await writeFile(tmp, marker);
      await rename(tmp, path);
    } catch (e: unknown) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    const back = await this.#readSafe(path);
    if (back === null) return false; // deleted out from under us (manual cleanup)
    const m = parseMarker(back);
    return m !== null && m.token === token;
  }
}
