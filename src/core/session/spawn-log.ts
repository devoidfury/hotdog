/**
 * Restart sidecar for task records: one append-only JSONL file beside the
 * task-lanes/ and sessions/ dirs (resolved config: taskSpawnsPath). One
 * spawn line per spawn (engine-owned parked spawns carry `parked: true` and
 * optionally their `run` dir), one agent line when the worker's own session
 * id is known, one end line per terminal transition. A later process
 * lifetime reads it to surface restart orphans (plan_status section, honest
 * task_status answers) and to rebuild the webui subagent lineage
 * (lineage(): per-task records for the sidebar feed) -- detection and
 * surfacing only; nothing is ever auto-respawned. Parked spawns rebuild the
 * lineage but never read as orphans: the workflow run journal owns their
 * reconciliation, and a double report in task_status would lie twice.
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
import { parseJsonLines } from "@utils/json-lines.ts";
import { logger } from "@utils/logger.ts";
import { pidAlive } from "@utils/process-group.ts";
import { formatError } from "../error.ts";

/** A task spawned by a process lifetime that ended without a terminal record. */
export interface OrphanedTask {
  taskId: string;
  description: string;
  sessionId: string | null;
  /** Spawn wall-clock (epoch ms); null when the record carried no usable timestamp. */
  spawnedAt: number | null;
}

/**
 * Everything the sidecar still attests about one task id, for the webui's
 * rebuilt subagent feed (live-card TASK_LIST rows and cold-row nesting).
 * The spawn line is the base; an `agent` line adds the worker's durable-log
 * key when the writer recorded one (records predating the agent line carry
 * null -- there is no key to join the worker transcript by); an end line
 * lands `endedAt`/`outcome`. `observedAt` is this read's clock: the upper
 * bound on an open task's death (it died between spawn and boot, nobody can
 * attest the exact moment) and the freeze anchor for display clocks.
 */
export interface LineageRecord {
  taskId: string;
  description: string;
  /** The delegating (manager) session; null: no parent. */
  sessionId: string | null;
  /** The worker's own session id (key of its durable log); null when unrecorded. */
  agentSessionId: string | null;
  spawnedAt: number | null;
  /** Terminal line's clock; null while the record is open (never ended). */
  endedAt: number | null;
  /** Recorded terminal status; null while open, "" if the end line lost it. */
  outcome: string | null;
  /** The engine run dir (workflow rows' reveal target); null when unrecorded. */
  runDir: string | null;
  observedAt: number;
}

/** Upper bound on the orphan list handed to status surfaces (plan_status stays small). */
const MAX_ORPHANS = 50;

export class SpawnLog {
  #path: string;
  #pidAlive: (pid: number) => boolean;
  /** Appends chain through one promise: lines stay whole and ordered. */
  #chain: Promise<void> = Promise.resolve();
  #dirReady = false;
  #orphans: Promise<OrphanedTask[]> | null = null;
  #lineage: Promise<LineageRecord[]> | null = null;

  /** `pidAliveFn` is the restart-simulation test seam (default: signal-0 check). */
  constructor(path: string, pidAliveFn?: (pid: number) => boolean) {
    this.#path = path;
    this.#pidAlive = pidAliveFn ?? pidAlive;
  }

  recordSpawn(rec: {
    taskId: string;
    description: string;
    sessionId: string | null;
    /** Engine-owned (workflow) spawn: lineage-only, never an orphan. */
    parked?: boolean;
    /** The engine run dir (reveal target for workflow rows). */
    runDir?: string | null;
  }): void {
    this.#append({
      ev: "spawn",
      id: rec.taskId,
      desc: rec.description,
      session: rec.sessionId,
      ...(rec.parked === true ? { parked: true } : {}),
      ...(typeof rec.runDir === "string" && rec.runDir !== "" ? { run: rec.runDir } : {}),
      pid: process.pid,
      host: hostname(),
    });
  }

  recordEnd(taskId: string, outcome: string): void {
    this.#append({ ev: "end", id: taskId, outcome });
  }

  /** The worker agent's own session id, recorded when the agent is built.
   *  This is the durable manager->worker join: it lets the next lifetime open
   *  the subagent's transcript. A line for an id with no live spawn record
   *  stays inert on read (same stance as a stray end line). */
  recordAgent(taskId: string, agentSessionId: string): void {
    this.#append({ ev: "agent", id: taskId, agent: agentSessionId });
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
   * lifetime, and drop out. Engine-owned (parked) spawns drop out too: their
   * lifecycle is reconciled from the run journal (plan_status), and an orphan
   * line for them would double-report the same dead run.
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
    const open = new Map<string, { task: OrphanedTask; pid?: number; host?: string; parked?: boolean }>();
    // Torn or foreign lines are skipped, never fatal: the sidecar is a hint surface.
    for (const ev of parseJsonLines(text, "skip")) {
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
          parked: ev.parked === true,
        });
      } else if (ev.ev === "end") {
        open.delete(ev.id);
      }
    }
    const out: OrphanedTask[] = [];
    for (const rec of open.values()) {
      if (rec.parked) continue;
      if (rec.host === host && rec.pid !== undefined && this.#pidAlive(rec.pid)) continue;
      out.push(rec.task);
    }
    return out.slice(-MAX_ORPHANS);
  }

  /**
   * Full lineage view: one record per task id the sidecar still attests,
   * spawn order, once-cached (the boot doctrine `orphans()` already follows:
   * the read is a snapshot of the lifetimes that ended before this process
   * started, and this lifetime's own tasks answer from memory anyway).
   * The LAST line for an id decides (terminal ids get reused: a re-spawn
   * resets the record, its stray agent/end lines included). `agent` lines
   * merge into the record they name; strays stay inert. OPEN records owned by
   * a pid alive on this host belong to a live process -- surfacing them as
   * interrupted would lie -- so they drop out (the orphan rule); closed
   * records always survive, whoever wrote them. Engine-owned (parked)
   * spawns ride like any other: the parked mark parks them out of the
   * ORPHAN view only (the run journal reconciles the run itself), and the
   * sidebar needs those workers too. Torn/unparsable lines skip.
   */
  lineage(): Promise<LineageRecord[]> {
    if (!this.#lineage) this.#lineage = this.#readLineage();
    return this.#lineage;
  }

  async #readLineage(): Promise<LineageRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch {
      return []; // no sidecar yet: no lineage
    }
    const observedAt = Date.now();
    const host = hostname();
    const byId = new Map<string, { rec: LineageRecord; pid?: number; host?: string }>();
    for (const ev of parseJsonLines(text, "skip")) {
      if (typeof ev.id !== "string") continue;
      if (ev.ev === "spawn") {
        byId.set(ev.id, {
          rec: {
            taskId: ev.id,
            description: typeof ev.desc === "string" ? ev.desc : "",
            sessionId: typeof ev.session === "string" ? ev.session : null,
            agentSessionId: null,
            spawnedAt: typeof ev.t === "string" ? Date.parse(ev.t) || null : null,
            endedAt: null,
            outcome: null,
            runDir: typeof ev.run === "string" && ev.run !== "" ? ev.run : null,
            observedAt,
          },
          pid: typeof ev.pid === "number" ? ev.pid : undefined,
          host: typeof ev.host === "string" ? ev.host : undefined,
        });
      } else if (ev.ev === "agent") {
        const cur = byId.get(ev.id);
        if (cur && typeof ev.agent === "string") cur.rec.agentSessionId = ev.agent;
      } else if (ev.ev === "end") {
        const cur = byId.get(ev.id);
        if (cur) {
          cur.rec.endedAt = typeof ev.t === "string" ? Date.parse(ev.t) || null : null;
          cur.rec.outcome = typeof ev.outcome === "string" ? ev.outcome : "";
        }
      }
    }
    const out: LineageRecord[] = [];
    for (const { rec, pid, host: recHost } of byId.values()) {
      if (rec.outcome === null && recHost === host && pid !== undefined && this.#pidAlive(pid)) continue;
      out.push(rec);
    }
    return out;
  }
}
