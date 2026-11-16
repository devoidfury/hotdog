// lock.ts — single-instance guard for LOCAL desktop mode.
//
// Why it is needed at all: the local server binds an EPHEMERAL port, so two
// `hotdog desktop` runs can never collide on a socket, and nothing else
// stops a second one — and a second server means two agents, two task lanes,
// and two config-store watchers over one shared on-disk workspace. The lock
// records pid + port so the second invocation can answer "already running,
// here is the port" instead of duplicating the stack.
//
// Known ceilings, stated honestly:
//  - A recycled pid can misreport a dead lock as live (the classic pid-file
//    race). Release-on-clean-exit covers the normal path; the stale case
//    needs a pid to roll over exactly onto the recorded one, which we accept.
//  - REMOTE mode takes no lock: several clients on one remote WebUI is a
//    supported shape, not a duplicate stack.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { joinDataDir } from "@core/session/session-log.ts";

export interface InstanceInfo {
  pid: number;
  port: number | null;
  startedAt: string;
}

export type AcquireResult = { ok: true } | { ok: false; running: InstanceInfo };

export function lockFilePath(): string {
  return joinDataDir("desktop", "instance.json");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseInfo(raw: string): InstanceInfo | null {
  try {
    const data = JSON.parse(raw) as Partial<InstanceInfo>;
    if (typeof data?.pid !== "number") return null;
    return {
      pid: data.pid,
      port: typeof data.port === "number" ? data.port : null,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Claim the lock for this process. EEXIST is the contention path: a live
 * pid refuses, a dead one (or an unparseable file) is stale and gets
 * replaced — once, because a second EEXIST means a real race with another
 * starter that won.
 */
export async function acquireInstanceLock(
  opts: { isAlive?: (pid: number) => boolean } = {},
): Promise<AcquireResult> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const path = lockFilePath();
  await mkdir(join(path, ".."), { recursive: true });
  const json = () =>
    JSON.stringify({ pid: process.pid, port: null, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, json(), { flag: "wx" });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const raw = await readFile(path, "utf8").catch(() => "");
      const running = parseInfo(raw);
      if (running && isAlive(running.pid)) return { ok: false, running };
      await rm(path, { force: true });
    }
  }
  const raw = await readFile(path, "utf8").catch(() => "");
  return { ok: false, running: parseInfo(raw) ?? { pid: -1, port: null, startedAt: "" } };
}

/** Record the bound port for the "already running" answer. Best effort: a
 *  failed refresh never takes the app down; the message just says "?". */
export async function updateInstanceLockPort(port: number): Promise<void> {
  const info = parseInfo(await readFile(lockFilePath(), "utf8").catch(() => ""));
  if (!info || info.pid !== process.pid) return;
  await writeFile(lockFilePath(), JSON.stringify({ ...info, port }), "utf8").catch(() => {});
}

export async function releaseInstanceLock(): Promise<void> {
  const info = parseInfo(await readFile(lockFilePath(), "utf8").catch(() => ""));
  // Only delete OUR lock — a raced-over file belongs to whoever won.
  if (info && info.pid === process.pid) {
    await rm(lockFilePath(), { force: true }).catch(() => {});
  }
}
