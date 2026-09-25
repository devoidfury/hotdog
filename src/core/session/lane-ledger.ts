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
 * marker names a dead pid on this host (or is corrupt) is reclaimed by
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
   * live owner (same-host pid alive, or a foreign host we cannot judge).
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

    for (let i = 0; i < cap; i++) {
      const path = join(dir, `slot-${i}`);
      if (await createExclusive(path, marker)) return { lane, path, token };

      const raw = await this.#readSafe(path);
      if (raw === null) {
        // Released while we were looking. Retry the exclusive create: under
        // this protocol an absent slot never HIDES a live marker (contents
        // only leave via atomic-rename takeover or token-checked release), so
        // creating here cannot slip in beside a live holder the way the old
        // rename-aside reclaim did.
        if (await createExclusive(path, marker)) return { lane, path, token };
        continue; // a rival create won
      }
      const cur = parseMarker(raw);
      if (cur && this.#occupied(cur)) continue; // live holder (any host)
      // Corrupt or dead on this host: take the slot over without ever letting
      // it look free. Our marker is renamed onto the old one atomically.
      if (await this.#reclaimInPlace(path, marker, token)) return { lane, path, token };
      // A rival reclaimer's rename landed last; its marker is judged next pass.
    }
    return null;
  }

  /**
   * Release a lease. A no-op when the file is gone or now belongs to someone
   * else (token mismatch: we were reclaimed as stale and the slot re-taken).
   */
  async release(lease: LaneLease): Promise<void> {
    let raw: string | null;
    try {
      raw = await readFile(lease.path, "utf8");
    } catch {
      return; // already gone
    }
    const m = parseMarker(raw);
    if (m && m.token !== lease.token) return; // not ours anymore; never delete a live slot
    await rm(lease.path, { force: true });
  }

  /** Occupied = foreign host (unknowable, conservative) or a live same-host pid. */
  #occupied(m: SlotMarker): boolean {
    if (m.host !== this.#host) return true;
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
