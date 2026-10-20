/**
 * Restart sidecar for delegate_task records: one append-only JSONL file
 * beside the task-lanes/ and sessions/ dirs (resolved config:
 * taskSpawnsPath). One spawn line per non-parked spawn, one end line per
 * terminal transition. A later process lifetime reads it to surface restart
 * orphans (plan_status section, honest task_status answers) -- detection and
 * surfacing only; nothing is ever auto-respawned.
 *
 * Fire-and-forget by contract: a sidecar write must NEVER break task
 * execution (debug-log and continue), and torn/unparsable lines are skipped
 * on read. The sidecar is a hint surface, not a scheduler input.
 *
 * Spawn lines carry the writer's pid + host: a co-resident live process
 * (webui daemon + CLI share the data dir) must not read as a restart orphan,
 * so survivors whose pid is alive on this host are excluded. A foreign-host
 * record cannot be liveness-checked and is reported, mirroring the workflow
 * run-dir claim stance.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { logger } from "@utils/logger.ts";
import { formatError } from "../error.ts";

/** A task spawned by a process lifetime that ended without a terminal record. */
export interface OrphanedTask {
  taskId: string;
  description: string;
  sessionId: string | null;
  /** Spawn wall-clock (epoch ms); null when the record carried no usable timestamp. */
  spawnedAt: number | null;
}

/** Upper bound on the orphan list handed to status surfaces (plan_status stays small). */
const MAX_ORPHANS = 50;

function pidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM"; // exists, not ours
  }
}

export class SpawnLog {
  #path: string;
  #pidAlive: (pid: number) => boolean;
  /** Appends chain through one promise: lines stay whole and ordered. */
  #chain: Promise<void> = Promise.resolve();
  #dirReady = false;
  #orphans: Promise<OrphanedTask[]> | null = null;

  /** `pidAlive` is the restart-simulation test seam (default: signal-0 check). */
  constructor(path: string, pidAlive?: (pid: number) => boolean) {
    this.#path = path;
    this.#pidAlive = pidAlive ?? pidAliveDefault;
  }

  recordSpawn(rec: { taskId: string; description: string; sessionId: string | null }): void {
    this.#append({
      ev: "spawn",
      id: rec.taskId,
      desc: rec.description,
      session: rec.sessionId,
      pid: process.pid,
      host: hostname(),
    });
  }

  recordEnd(taskId: string, outcome: string): void {
    this.#append({ ev: "end", id: taskId, outcome });
  }

  #append(rec: Record<string, unknown>): void {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`;
    this.#chain = this.#chain
      .then(async () => {
        if (!this.#dirReady) {
          await mkdir(dirname(this.#path), { recursive: true });
          this.#dirReady = true;
        }
        await appendFile(this.#path, line); // O_APPEND single-line append, never a rewrite
      })
      .catch((e: unknown) =>
        logger.debug(`[task-log] spawn sidecar write failed (continuing): ${formatError(e)}`),
      );
  }

  /**
   * Spawned-but-never-ended records from the file, spawn order, once-cached.
   * The LAST line for an id decides (terminal ids get reused). Survivors
   * whose pid is alive on this host belong to a live process, not to a past
   * lifetime, and drop out.
   */
  orphans(): Promise<OrphanedTask[]> {
    if (!this.#orphans) this.#orphans = this.#readOrphans();
    return this.#orphans;
  }

  async #readOrphans(): Promise<OrphanedTask[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch {
      return []; // no sidecar yet: nothing orphaned
    }
    const host = hostname();
    const open = new Map<string, { task: OrphanedTask; pid?: number; host?: string }>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // torn or foreign line: skipped, never fatal
      }
      if (typeof ev.id !== "string") continue;
      if (ev.ev === "spawn") {
        open.set(ev.id, {
          task: {
            taskId: ev.id,
            description: typeof ev.desc === "string" ? ev.desc : "",
            sessionId: typeof ev.session === "string" ? ev.session : null,
            spawnedAt: typeof ev.t === "string" ? Date.parse(ev.t) || null : null,
          },
          pid: typeof ev.pid === "number" ? ev.pid : undefined,
          host: typeof ev.host === "string" ? ev.host : undefined,
        });
      } else if (ev.ev === "end") {
        open.delete(ev.id);
      }
    }
    const out: OrphanedTask[] = [];
    for (const rec of open.values()) {
      if (rec.host === host && rec.pid !== undefined && this.#pidAlive(rec.pid)) continue;
      out.push(rec.task);
    }
    return out.slice(-MAX_ORPHANS);
  }
}
