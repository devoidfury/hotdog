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
 * marker names a dead pid on this host (or is corrupt, or names THIS process
 * without a live lease object -- the missed-release watchdog, see
 * `processSlots`) is reclaimed by
 * renaming a temporary claiming marker ONTO the
 * slot: rename replaces atomically, so while a slot is held (or being
 * reclaimed) the path never momentarily lacks a file and a concurrent
 * acquirer's exclusive create can never slip into a gap beside a live holder
 * (closing the old rename-aside protocol's over-admission window). A reclaim
 * finalizes by reading back: the last rename stands, and a reclaimer that
 * sees a rival's marker simply gives the slot up untouched, so a loser never
 * clobbers or deletes the winner's marker.
 *
 * A foreign-host marker counts as occupied: its liveness cannot be checked
 * from here and the safe failure is under-admission. A wedged foreign marker
 * (a crash with a filesystem shared across hosts) needs a manual delete.
 *
 * Missed-release watchdog (`processSlots`): a marker naming a live pid is
 * otherwise unreclaimable, so a leaked lease -- a dropped slot file unlink, a
 * release that never ran -- would strand that lane for the rest of the
 * process's life and every waiter behind it. This process therefore registers
 * every lease it takes in a module-level `WeakRef` table; a marker whose pid
 * is ours with no reachable lease object is treated as free and reclaimed. It
 * is exactly the lease the caller dropped on the floor: a slot in use is
 * referenced by its holder (TaskEntry.lease, or the bus's turn-scoped
 * release). Reclaim lands on a GC tick, not the instant of the leak.
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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createExclusive } from "@utils/fs-atomic.ts";

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
}

interface SlotMarker {
  pid: number;
  host: string;
  token: string;
  since: string;
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

  constructor(opts: LaneLedgerOptions) {
    this.#dir = opts.dir;
    this.#pid = opts.pid ?? process.pid;
    this.#host = opts.host ?? hostname();
    this.#pidAlive = opts.pidAlive ?? pidAliveDefault;
  }

  /** Lane "" (bare model names) gets a literal "_" dir; names are percent-encoded. */
  laneDir(lane: string): string {
    return join(this.#dir, lane === "" ? "_" : encodeURIComponent(lane));
  }

  /**
   * Take a slot on `lane` (cap >= 1 slots). null when every slot is held by a
   * live owner (same-host pid alive, a same-pid lease object still reachable
   * here, or a foreign host we cannot judge).
   */
  async acquire(lane: string, cap: number): Promise<LaneLease | null> {
    const dir = this.laneDir(lane);
    await mkdir(dir, { recursive: true });
    const token = `${this.#pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const marker = `${JSON.stringify({
      pid: this.#pid,
      host: this.#host,
      token,
      since: new Date().toISOString(),
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
      return lease;
    };
    try {
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
        if (cur && this.#occupied(cur)) continue; // live holder (any host)
        // Corrupt or dead on this host: take the slot over without ever letting
        // it look free. Our marker is renamed onto the old one atomically.
        if (await this.#reclaimInPlace(path, marker, token)) return won(path);
        // A rival reclaimer's rename landed last; its marker is judged next pass.
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
   * Occupied = foreign host (unknowable, conservative), a live same-host pid,
   * or -- for our own pid -- a lease object still reachable in this process.
   * Our pid is trivially alive, so liveness says nothing there; the WeakRef
   * table is what distinguishes a held slot from a missed release.
   */
  #occupied(m: SlotMarker): boolean {
    if (m.host !== this.#host) return true;
    if (m.pid === this.#pid) {
      const ref = processSlots.get(m.token);
      if (ref === undefined) return false; // no owner here: leaked marker
      if (ref.deref() === undefined) {
        processSlots.delete(m.token);
        return false; // lease object was dropped without a release
      }
      return true;
    }
    return this.#pidAlive(m.pid);
  }

  async #readSafe(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Take over a slot whose present marker we judged free (dead same-host pid
   * or corrupt). Our marker is written to a sibling temp file and renamed
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
