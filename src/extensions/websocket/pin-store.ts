// Server-persisted sidebar pins: the set of session/log ids pinned in the
// webui sidebar, stored in a dedicated JSON file.
//
// Storage-home precedent: sessionIndexPath() parks the sqlite index INSIDE
// the sessions dir, so HOTDOG_SESSIONS_DIR moves the whole world and one
// `rm -rf` of that dir sweeps every server-owned artifact. The pins file
// follows the same rule -- it lives next to the logs whose ids it stores,
// and its path is re-derived on every access so an env relocation (tests,
// tmpfs setups) takes effect exactly like the index's reopen-on-move.
//
// Failure posture: a missing file is the normal cold start (empty set, debug
// note); corrupt bytes get a logger error and an empty set. The store never
// crashes the server over its convenience file. Writes are atomic (temp
// file + rename), so a crash mid-write can only leave the previous good
// file or the new one, never a torn payload. A failed write keeps the
// in-memory set authoritative for this process; the next successful write
// re-persists it.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { isSafeSessionId, sessionsDir } from "@core/session/session-log.ts";

/** The pins file lives inside the sessions dir (sessionIndexPath precedent). */
export function pinStorePath(): string {
  return join(sessionsDir(), "pinned-sessions.json");
}

let pins: Set<string> | null = null;
let pinsFile: string | null = null;

function readPins(path: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Missing (or unreadable): the normal first-run state, hence debug.
    logger.debug(
      `[pin-store] no readable pin store at ${path} (${formatError(err)}); starting with no pins`,
    );
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("payload is not an array");
    const next = new Set<string>();
    for (const entry of parsed) {
      // Same id gate as the core path helpers: junk entries never load.
      if (typeof entry === "string" && isSafeSessionId(entry)) next.add(entry);
    }
    return next;
  } catch (err) {
    logger.error(
      `[pin-store] pin store at ${path} is corrupt (${formatError(err)}); starting with no pins`,
    );
    return new Set();
  }
}

/** Load once per store home: a HOTDOG_SESSIONS_DIR change reloads from the
 *  new location (mirrors openSessionIndex's reopen-on-path-change). */
function ensureLoaded(): Set<string> {
  const path = pinStorePath();
  if (!pins || pinsFile !== path) {
    pins = readPins(path);
    pinsFile = path;
  }
  return pins;
}

function persistPins(): void {
  const path = pinStorePath();
  // Pid-unique temp name: concurrent writers (sibling hotdog processes)
  // never truncate each other's in-flight file.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify([...(pins ?? [])]));
    renameSync(tmp, path);
  } catch (err) {
    logger.error(`[pin-store] could not persist ${path}: ${formatError(err)}`);
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Snapshot of the pinned ids (list payload builders read from this). */
export function getPinnedIds(): Set<string> {
  return new Set(ensureLoaded());
}

/** True when the id carries a pin. Invalid ids can never be pinned (both
 *  the loader and setPinned gate them), so membership alone answers. */
export function isPinned(id: string): boolean {
  return ensureLoaded().has(id);
}

/** Pin/unpin one id. Invalid ids are refused (the frame carries them raw).
 *  Returns whether the store accepted the id. */
export function setPinned(id: string, pinned: boolean): boolean {
  if (!isSafeSessionId(id)) return false;
  const current = ensureLoaded();
  const had = current.has(id);
  if (pinned) current.add(id);
  else current.delete(id);
  if (pinned ? !had : had) persistPins();
  return true;
}

/** Drop a dead row's pin (hooked into the session/log delete handlers;
 *  replaces the old client-side stale-prune). Persists only on a hit. */
export function dropPinned(id: string): void {
  if (ensureLoaded().delete(id)) persistPins();
}

/** @internal Forget the in-memory cache: the next read comes off disk again
 *  (restart simulation for tests). */
export function closePinStore(): void {
  pins = null;
  pinsFile = null;
}
