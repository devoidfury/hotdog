/**
 * Workflow run store — run-dir identity, ownership, journal reading,
 * interruption scan/marking, and reconcile. Persistence only: no execution,
 * no TaskManager. The execution side (WorkflowRun) lives in engine.ts and
 * drives the write path; everything here reads or claims what was written.
 *
 * Journal format (run.jsonl, append-only): one JSON object per line,
 * `ev` in started | node | finished | resumed | interrupted. Readers fold
 * tolerantly: garbage lines and unknown events are inert noise.
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { formatError } from "@core/error.ts";
import { createExclusive } from "@utils/fs-atomic.ts";
import { parseJsonLines } from "@utils/json-lines.ts";
import { logger } from "@utils/logger.ts";
import { pidAlive } from "@utils/process-group.ts";

const VERDICTS = new Set(["pass", "fail", "reject"]);

/** Recorded fact about an output file: existence is size + mtime. */
export interface FileClaim {
  size: number;
  mtimeMs: number;
}

// run identity, log reading & reconcile
// ---------------------------------------------------------------------------

/**
 * Shape for caller-supplied run ids (`--id`, the model-supplied
 * `workflow_dispatch` run_id, status/reconcile/cancel args): the generated
 * `YYYYMMDD-HHmm-<name>` form always matches. These ids go straight into
 * `join(runsRoot, id)`, so no separators and no leading dot -- a
 * model-chosen "../anything" must not escape the runs root.
 */
export function isSafeRunId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/** Shared tail text for rejected run ids (CLI + manager tools stay in sync with the regex above). */
export const RUN_ID_SHAPE_HINT = "must match [a-z0-9][a-z0-9._-]*";

// ---------------------------------------------------------------------------
// run-dir ownership (anti double-drive)
// ---------------------------------------------------------------------------

/** Marker file inside a run dir naming the process currently driving it. */
export const RUN_OWNER_FILE = ".owner";

export interface RunOwner {
  pid: number;
  host: string;
  claimedAt: string;
}

export interface ClaimOptions {
  pid?: number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
}

function parseOwnerJson(text: string): RunOwner | null {
  try {
    const o = JSON.parse(text) as RunOwner;
    if (typeof o?.pid !== "number" || typeof o?.host !== "string") return null;
    return o;
  } catch {
    return null;
  }
}

export async function readRunOwner(runDir: string): Promise<RunOwner | null> {
  try {
    return parseOwnerJson(await readFile(join(runDir, RUN_OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically move the owner marker aside; returns its content, or null when
 * the file was already gone. rename's exclusivity means of several racing
 * reclaimers exactly one wins -- no read-modify-write window where two
 * processes both decide to overwrite. Creation is createExclusive from
 * @utils/fs-atomic.ts, so an existing `.owner` always carries full contents:
 * empty/garbage means a crashed writer, never a mid-write live claim.
 */
async function discardOwnerFile(path: string): Promise<string | null> {
  const away = `${path}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await rename(path, away);
  } catch {
    return null; // already gone (another reclaimer won) or never existed
  }
  const content = await readFile(away, "utf8").catch(() => "");
  await rm(away, { force: true }).catch(() => {});
  return content;
}

const sameClaim = (a: RunOwner | null, b: RunOwner | null): boolean =>
  !!a && !!b && a.pid === b.pid && a.host === b.host && a.claimedAt === b.claimedAt;

/**
 * Claim the run dir for this process. Refuses only a same-host claim whose
 * pid is alive (and not our own pid — re-entry for a pre-claim followed by
 * run() must pass). Stale same-host markers (crashed pid) and foreign-host
 * markers — whose liveness cannot be checked from here — are reclaimed; the
 * foreign case logs a warning.
 *
 * All writes are exclusive creates; reclaims race through the atomic
 * rename so one claimer wins the discard. What the winner moved aside is
 * checked against what it judged: a live rival's claim that landed after our
 * read is restored untouched, never overwritten. A corrupt (unreadable)
 * marker is discarded the same way, never truncated in place.
 */
export async function claimRunDir(
  runDir: string,
  opts?: ClaimOptions,
): Promise<{ ok: true; reclaimed?: RunOwner } | { ok: false; owner: RunOwner }> {
  const pid = opts?.pid ?? process.pid;
  const host = opts?.host ?? hostname();
  const alive = opts?.pidAlive ?? pidAlive;
  const ownerPath = join(runDir, RUN_OWNER_FILE);
  const mineJson = () =>
    `${JSON.stringify({ pid, host, claimedAt: new Date().toISOString() } satisfies RunOwner)}\n`;

  for (let round = 0; round < 4; round++) {
    const prior = await readRunOwner(runDir);
    if (prior) {
      if (prior.pid === pid && prior.host === host) {
        return { ok: true, reclaimed: prior };
      }
      if (prior.host === host && alive(prior.pid)) {
        return { ok: false, owner: prior };
      }
      if (prior.host !== host) {
        logger.warn(
          `[workflow] reclaiming run dir '${runDir}' claimed by '${prior.host}' pid ${prior.pid} ` +
            `(liveness cannot be checked across hosts)`,
        );
      }
      // Judged reclaimable (dead same-host or foreign). Race to move it.
      const moved = await discardOwnerFile(ownerPath);
      if (moved === null) continue; // another reclaimer won the discard
      const movedOwner = parseOwnerJson(moved);
      if (movedOwner && !sameClaim(movedOwner, prior) && movedOwner.host === host && alive(movedOwner.pid)) {
        // A live rival's claim landed between our read and rename: restore
        // it exactly and let the next round judge it.
        if (movedOwner.pid === pid) return { ok: true, reclaimed: movedOwner };
        await createExclusive(ownerPath, moved);
        continue;
      }
      if (await createExclusive(ownerPath, mineJson())) {
        return { ok: true, reclaimed: prior };
      }
      continue; // a rival created in our window; re-judge
    }
    if (await createExclusive(ownerPath, mineJson())) return { ok: true };
    // EEXIST with no readable claim: a corrupt marker (creation is atomic, so a
    // live rival's file always parses; empty/garbage means a crashed writer).
    // Re-read once in case a rival finished between reads. If still unreadable,
    // discard the corrupt marker (the rename has a single winner; should the
    // moved bytes turn out to be a live claim, they are restored here).
    if ((await readRunOwner(runDir)) === null) {
      const moved = await discardOwnerFile(ownerPath);
      if (moved !== null) {
        const movedOwner = parseOwnerJson(moved);
        if (movedOwner && movedOwner.host === host && alive(movedOwner.pid)) {
          if (movedOwner.pid === pid) return { ok: true, reclaimed: movedOwner };
          await createExclusive(ownerPath, moved);
        }
      }
    }
    // Loop retries: the slot is now free (we won the discard) or a rival
    // claim exists to be judged at the top of the next round.
  }
  throw new Error(`cannot claim run dir '${runDir}': repeated ownership races`);
}

// ---------------------------------------------------------------------------
// restart interruption scan & marking (mark + surface only; never auto-resume)
// ---------------------------------------------------------------------------
//
// A process kill mid-run leaves the run dir claimed-by-nothing (or by a dead
// pid) with a journal that never reached `finished`. At extension activation
// we mark such dirs with one `interrupted` journal event and surface them via
// workflow_status / `workflow list` -- a restart often means deliberate tree
// changes, so nothing is ever auto-resumed; a human or manager re-dispatches
// with run_id and reconcile-resume re-verifies everything on the filesystem.
/** Journal marker naming a run whose owner died mid-flight. */
export const INTERRUPTED_EV = "interrupted";
/** Resume instruction carried verbatim in the marker detail. */
export const INTERRUPTED_DETAIL = "owner lost (restart?); resumable with dispatch run_id";

/**
 * Upper bound on the journal bytes a scan may read per dir when `bounded`
 * (the activation pass): run journals are append-only and unbounded, and run
 * dirs are never GC'd, so boot-time scanning must never read one whole. The
 * marking decision lives at the edges: the `started` head line (the engine's
 * first write) and the last events (terminal status, the marker, the node
 * event a kill interrupted). Journals within twice the window are read whole,
 * so real runs judge with exact rules; larger ones fall back to the edge
 * rules below (one marker line can then be missed only in exotic shapes,
 * e.g. death moments after a `resumed` line on a >2x-window journal).
 */
const INTERRUPTED_SCAN_WINDOW = 64 * 1024;

/**
 * Journal text for the scan: whole file, or (bounded) its first window +
 * last window with a mid-line boundary fragment dropped. Null when the dir
 * holds no readable journal (not a run dir).
 */
async function readJournalForScan(
  runDir: string,
  bounded: boolean,
): Promise<{ text: string; truncated: boolean } | null> {
  const path = join(runDir, "run.jsonl");
  if (!bounded) {
    try {
      return { text: await readFile(path, "utf8"), truncated: false };
    } catch {
      return null;
    }
  }
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path);
  } catch {
    return null; // not a run dir (no journal yet)
  }
  try {
    const { size } = await fh.stat();
    if (size <= INTERRUPTED_SCAN_WINDOW * 2) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: false };
    }
    // Head: only the first line matters (the engine's `started` event). Tail:
    // a fragment cut mid-line is dropped -- the byte before the window says
    // whether the window starts on a line boundary.
    const head = Buffer.alloc(INTERRUPTED_SCAN_WINDOW);
    const { bytesRead: headRead } = await fh.read(head, 0, INTERRUPTED_SCAN_WINDOW, 0);
    const headText = head.subarray(0, headRead).toString("utf8");
    const headNl = headText.indexOf("\n");
    const headLine = headNl === -1 ? headText : headText.slice(0, headNl);
    const tail = Buffer.alloc(INTERRUPTED_SCAN_WINDOW);
    const { bytesRead: tailRead } = await fh.read(tail, 0, INTERRUPTED_SCAN_WINDOW, size - INTERRUPTED_SCAN_WINDOW);
    const boundary = Buffer.alloc(1);
    await fh.read(boundary, 0, 1, size - INTERRUPTED_SCAN_WINDOW - 1);
    let tailText = tail.subarray(0, tailRead).toString("utf8");
    if (boundary[0] !== 0x0a) {
      const nl = tailText.indexOf("\n");
      tailText = nl === -1 ? "" : tailText.slice(nl + 1);
    }
    return { text: `${headLine}\n${tailText}`, truncated: true };
  } catch {
    return null; // unreadable journal: treat like no journal
  } finally {
    await fh.close().catch(() => {});
  }
}

export interface InterruptedRunView {
  runId: string;
  workflow: string;
  runDir: string;
  /** Graph-order node ids with the last state seen for each (transient states included). */
  nodes: Array<{ id: string; state: string }>;
  /** Journal holds at least one node event: marking (not just listing) applies. */
  nodeActivity: boolean;
  /** Last parsed event is already an `interrupted` marker -- the rescan skip rule. */
  marked: boolean;
}

async function scanRunDirForInterruption(
  runDir: string,
  host: string,
  alive: (pid: number) => boolean,
  bounded = false,
): Promise<InterruptedRunView | null> {
  const journal = await readJournalForScan(runDir, bounded);
  if (!journal) return null; // not a run dir (no journal yet)
  let started: { runId: string; workflow: string; nodes: string[] } | null = null;
  let finished = false;
  let sawResumed = false;
  let nodeActivity = false;
  let lastEv: string | null = null;
  const state = new Map<string, string>();
  for (const ev of parseJsonLines(journal.text, "skip")) {
    // Same shape guard as readRunLog: garbage journals can hold valid-JSON
    // scalar lines; they are inert noise, never a crash on property access.
    if (typeof ev !== "object" || ev === null) continue;
    if (typeof ev.ev === "string") lastEv = ev.ev;
    if (ev.ev === "started") {
      started = {
        runId: String(ev.runId ?? ""),
        workflow: String(ev.workflow ?? ""),
        nodes: Array.isArray(ev.nodes) ? (ev.nodes as string[]) : [],
      };
    } else if (ev.ev === "finished") {
      finished = true;
    } else if (ev.ev === "resumed") {
      sawResumed = true;
    } else if (ev.ev === "node") {
      nodeActivity = true;
      if (ev.id != null) state.set(String(ev.id), String(ev.state ?? ""));
    }
  }
  if (!started || finished) return null;
  if (journal.truncated) {
    // Only the journal edges are visible: the head line must be the engine's
    // `started` event; anything appended after it is engine progress unless
    // the last event itself is terminal/marker-shaped (already judged above).
    if (lastEv === INTERRUPTED_EV) {
      nodeActivity = true; // a marker sits after real node activity
    } else if (lastEv !== "started" && lastEv !== null) {
      nodeActivity = true;
    } else {
      nodeActivity = nodeActivity || sawResumed;
    }
  }
  const owner = await readRunOwner(runDir);
  if (owner && owner.host === host && alive(owner.pid)) return null; // live run, hands off
  // Absent/corrupt marker, dead same-host pid, or a foreign-host claim (whose
  // liveness cannot be checked from here -- the same reclaim-with-warning
  // stance claimRunDir takes) all read as an interrupted run.
  return {
    runId: started.runId,
    workflow: started.workflow,
    runDir,
    nodes: started.nodes.map((id) => ({ id, state: state.get(id) ?? "pending" })),
    nodeActivity,
    marked: lastEv === INTERRUPTED_EV,
  };
}

/**
 * Every run dir whose journal lacks a terminal `finished` event and whose
 * owner marker is stale or absent -- whether or not this process ever knew
 * them. Read-only; live-owner and finished dirs are never returned.
 * `bounded` caps per-dir journal reads to the scan window (see
 * INTERRUPTED_SCAN_WINDOW); the activation pass uses it, on-demand surfaces
 * keep exact full-journal rules and display data.
 */
export async function scanInterruptedRuns(
  runsRoot: string,
  opts?: ClaimOptions,
  bounded = false,
): Promise<InterruptedRunView[]> {
  const host = opts?.host ?? hostname();
  const alive = opts?.pidAlive ?? pidAlive;
  let names: string[];
  try {
    names = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  names.sort();
  const out: InterruptedRunView[] = [];
  for (const name of names) {
    const v = await scanRunDirForInterruption(join(runsRoot, name), host, alive, bounded);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Activation pass: warn once per interrupted run and append the `interrupted`
 * marker where one is missing. The marker applies only to dirs with node
 * activity, and NEVER when the last parsed event already is one -- so rescans
 * (repeated activations) append at most one marker per death. The write is a
 * single-line O_APPEND (the run journal's own writer idiom): never a rewrite,
 * and the stale-owner requirement means no live process shares the file.
 * Bounded: per dir the scan reads only the head line + tail window, never a
 * whole journal (run dirs accumulate forever; boot cost must not).
 */
export async function markInterruptedRuns(
  runsRoot: string,
  opts?: ClaimOptions,
): Promise<InterruptedRunView[]> {
  const runs = await scanInterruptedRuns(runsRoot, opts, true);
  for (const r of runs) {
    logger.warn(
      `[workflows] run '${r.runId}' (${r.workflow}) interrupted: ${INTERRUPTED_DETAIL}`,
    );
    if (!r.nodeActivity || r.marked) continue;
    const line = `${JSON.stringify({
      t: new Date().toISOString(),
      ev: INTERRUPTED_EV,
      detail: INTERRUPTED_DETAIL,
    })}\n`;
    try {
      await appendFile(join(r.runDir, "run.jsonl"), line);
    } catch (e: unknown) {
      logger.warn(
        `[workflows] could not mark run '${r.runId}' interrupted: ${formatError(e)}`,
      );
    }
  }
  return runs;
}

/**
 * Run directory name: `YYYYMMDD-HHmm-<workflow-name>`.
 * The directory is RESERVED here with an exclusive mkdir, not probed for a
 * run.jsonl: two processes dispatching in the same minute would otherwise
 * both pass the probe (neither log written yet) and share one run dir. Any
 * existing directory -- started run or crashed-before-log -- belongs to an
 * earlier claim, so numeric suffixes keep run dirs one-per-execution;
 * resuming is an explicit `--id`, never a same-minute accident.
 */
export async function nextRunId(
  runsRoot: string,
  workflowName: string,
  now = new Date(),
): Promise<string> {
  const p = (n: number) => String(n).padStart(2, "0");
  const base =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}-${workflowName}`;
  await mkdir(runsRoot, { recursive: true });
  let id = base;
  for (let i = 2; ; i++) {
    try {
      await mkdir(join(runsRoot, id)); // exclusive: the reservation
      return id;
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      id = `${base}-${i}`;
    }
  }
}

export interface DiskRunSummary {
  runId: string;
  workflow: string;
  /** finished-event outcome, or null when the run never completed (crashed or still in flight elsewhere). */
  outcome: string | null;
  /** Node ids in graph order, with the last terminal state seen in the log. */
  nodes: Array<{ id: string; state: string }>;
}

/** Disk view of a run dir's run.jsonl for `workflow list|status|cancel` -- read-only, no claim validation. */
export async function readRunSummary(runDir: string): Promise<DiskRunSummary | null> {
  const prior = await readRunLog(runDir);
  if (!prior) return null;
  return {
    runId: prior.started.runId,
    workflow: prior.started.workflow,
    outcome: prior.finished?.outcome ?? null,
    nodes: prior.started.nodes.map((id) => ({ id, state: prior.lastState.get(id) ?? "pending" })),
  };
}

interface SucceededClaim {
  id: string;
  attempt: number;
  verdict: string | null;
  summary: string;
  deps: string[];
  files: Record<string, FileClaim>;
}

// RunLogEvents/readRunLog/validateClaims/readVerdictFile are exported for the
// engine (resume folds claims; gates read verdicts); external callers use the
// surface functions above.
export interface RunLogEvents {
  started: { runId: string; workflow: string; nodes: string[]; startedAt: number };
  /** node id -> last node event state seen */
  lastState: Map<string, string>;
  succeeded: Map<string, SucceededClaim>;
  finished: { outcome: string } | null;
}

export async function readRunLog(runDir: string): Promise<RunLogEvents | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, "run.jsonl"), "utf8");
  } catch {
    return null;
  }
  let started: RunLogEvents["started"] | null = null;
  let finished: RunLogEvents["finished"] = null;
  const lastState = new Map<string, string>();
  const succeeded = new Map<string, SucceededClaim>();
  for (const ev of parseJsonLines(text, "skip")) {
    // Shape guard: parseJsonLines guarantees valid JSON only; a garbage
    // journal can hold scalar lines (bare `null` throws on property access),
    // skipped like unknown ev values. The array guards cover garbage-shaped
    // object fields (`{"ev":"started","nodes":5}`) that later folds dereference.
    if (typeof ev !== "object" || ev === null) continue;
    // Unknown ev values (interrupted markers, anything a future writer adds)
    // fall through ignored: node state derives from node/finished events only,
    // so an annotated journal resumes exactly like an unmarked one.
    if (ev.ev === "started") {
      started = {
        runId: String(ev.runId),
        workflow: String(ev.workflow),
        nodes: Array.isArray(ev.nodes) ? (ev.nodes as string[]) : [],
        startedAt: Number(ev.startedAt),
      };
    } else if (ev.ev === "finished") {
      finished = { outcome: String(ev.outcome) };
    } else if (ev.ev === "node") {
      const id = String(ev.id);
      const state = String(ev.state);
      if (!["succeeded", "failed", "blocked", "cancelled"].includes(state)) continue;
      lastState.set(id, state);
      if (state === "succeeded") {
        succeeded.set(id, {
          id,
          attempt: Number(ev.attempt ?? 0),
          verdict: ev.verdict == null ? null : String(ev.verdict),
          summary: String(ev.summary ?? ""),
          deps: Array.isArray(ev.deps) ? (ev.deps as string[]) : [],
          files: (ev.files as Record<string, FileClaim>) ?? {},
        });
      } else {
        succeeded.delete(id);
      }
    }
  }
  return started ? { started, lastState, succeeded, finished } : null;
}

export interface ReconcileReport {
  runId: string;
  workflow: string;
  /** Completed claims whose files and inputs still match the filesystem. */
  valid: string[];
  /** Completed claims that no longer verify (changed/missing outputs or verdict). */
  invalid: string[];
  /** Nodes without a completed claim (need execution on resume). */
  incomplete: string[];
}

/**
 * Reconcile a run directory: check the filesystem against the nodes'
 * completed claims (openclaw resume-from-recorded-facts). A claim survives
 * only if its output files still exist unmodified, its verdict file still
 * parses to the recorded value, and every claimed upstream is itself valid.
 */
export async function reconcileRun(runDir: string): Promise<ReconcileReport> {
  const prior = await readRunLog(runDir);
  if (!prior) throw new Error(`no usable run.jsonl in '${runDir}'`);
  const report = await validateClaims(prior, (p) => join(runDir, p));
  report.runId = prior.started.runId;
  return report;
}

export async function validateClaims(
  prior: RunLogEvents,
  resolvePath: (rel: string) => string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    runId: prior.started.runId,
    workflow: prior.started.workflow,
    valid: [],
    invalid: [],
    incomplete: [],
  };
  const decided = new Map<string, boolean>(); // claim id -> valid

  // Fixed-point over succeeded claims (graphs are small; deps precede).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, claim] of prior.succeeded) {
      if (decided.has(id)) continue;
      // An upstream without a live succeeded claim (failed/blocked/cancelled,
      // never finished, or invalidated) breaks this claim outright.
      const depsBroken = claim.deps.some((d) => !prior.succeeded.has(d) || decided.get(d) === false);
      if (depsBroken) {
        decided.set(id, false);
        progressed = true;
        continue;
      }
      const unmet = claim.deps.filter((d) => !decided.has(d));
      if (unmet.length > 0) continue; // wait for upstream verdicts
      let ok = true;
      for (const [path, fc] of Object.entries(claim.files)) {
        try {
          const st = await stat(resolvePath(path));
          if (st.size !== fc.size || st.mtimeMs !== fc.mtimeMs) {
            ok = false;
            break;
          }
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) {
        const v = await readVerdictFile(resolvePath(`${id}.verdict`));
        ok = v !== null && (!claim.verdict || v.value === claim.verdict);
      }
      decided.set(id, ok);
      progressed = true;
    }
  }
  // Claims whose upstream never decided (upstream itself stale-pending) -> invalid.
  for (const id of prior.succeeded.keys()) {
    if (!decided.has(id)) decided.set(id, false);
  }
  for (const id of prior.succeeded.keys()) {
    (decided.get(id) ? report.valid : report.invalid).push(id);
  }
  for (const id of prior.started.nodes) {
    if (!prior.succeeded.has(id)) report.incomplete.push(id);
  }
  return report;
}

/**
 * A verdict file's first line is exactly one of pass|fail|reject (the enum
 * gate); anything below is a free-text note (judge critique rides here).
 * Null when the file is missing or the first line is not the enum.
 */
export async function readVerdictFile(path: string): Promise<{ value: string; note: string } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim().toLowerCase();
  if (!VERDICTS.has(first)) return null;
  return { value: first, note: nl === -1 ? "" : text.slice(nl + 1).trim() };
}
