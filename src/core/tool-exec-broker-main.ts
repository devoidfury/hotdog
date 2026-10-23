// The tool exec plane's broker CHILD program: spawned by the supervisor as
// `bun <this file> --idle-reap-ms=<n>`. It holds no conversation state, no
// credentials, no user-data access -- tool code lives only in pool entries
// (`src/workers/tool-exec.ts`). Pool entries are keyed (sessionId, class);
// an entry is either the supervisor's fence argv (`bwrap <plan> -- bun
// <runner>`, prepended verbatim at spawnEntry()) or a plain `bun <runner>`,
// because isolation is argv: the child adds no policy here, and the runner
// can never tell fenced from unfenced -- same code, degraded path included.
//
// The client half (the `ToolExecBroker` stub the host imports, fence
// planning, respawn accounting) lives in `tool-exec-broker.ts`; this module
// never imports it, and nothing in the supervisor process calls into it --
// the only callers here are the child-half unit tests, through the seams
// exported at the bottom.

import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "@utils/logger.ts";
import { formatError } from "./error.ts";
import { DEFAULT_IDLE_REAP_MS, PROJECT_ROOT, RUNNER_ENTRY } from "./tool-exec-layout.ts";
import {
  encodeFrame,
  LineDecoder,
  type OutboundFrame,
  type InboundFrame,
  type InvokeFrame,
  type ExecClass,
  type WireFence,
} from "./tool-exec-protocol.ts";

interface PoolEntry {
  proc: ChildProcess;
  pending: Set<string>;
  dead: boolean;
  /** Idle-reap timer; null while the entry is serving a call. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Identity of the fence plan this entry was spawned under ("" = plain spawn). */
  fenceId: string;
  /** Deferred hard-kill timer armed by dropEntry (the runner should drain on its own). */
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** Broker-child state: the pool plus the knobs handed down as argv. */
interface BrokerState {
  pool: Map<string, PoolEntry>;
  idleReapMs: number;
}

function poolKey(session: string, cls: string): string {
  return `${session} ${cls}`;
}

function writeSupervisor(frame: unknown): void {
  process.stdout.write(encodeFrame(frame) + "\n");
}

/**
 * The supervisor hands the child its knobs on argv -- the same reason the
 * fence is argv: the configured path and the default path stay one code path.
 * Unknown flags are ignored, so a newer supervisor cannot break an older
 * broker child.
 */
function parseBrokerArgs(argv: string[]): { idleReapMs: number } {
  let idleReapMs = DEFAULT_IDLE_REAP_MS;
  for (const arg of argv) {
    const m = /^--idle-reap-ms=(\d+)$/.exec(arg);
    if (m) idleReapMs = Number(m[1]);
  }
  return { idleReapMs };
}

function runBroker(): void {
  const state: BrokerState = { pool: new Map(), ...parseBrokerArgs(process.argv.slice(2)) };
  writeSupervisor({ op: "ready" });

  const decoder = new LineDecoder();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) handleFrame(line, state);
  });
  process.stdin.on("end", () => {
    // Supervisor gone: EOF every runner and exit. The runners cancel their
    // in-flight work and kill their process groups on that EOF, then leave;
    // hard-killing them here would orphan a detached bash group instead of
    // reaping it. (A runner wedged past its own drain outlives us only on the
    // unfenced path: fenced entries go down with their jail either way --
    // --die-with-parent takes the runner, and --unshare-pid takes setsid'd
    // grandchildren down with the namespace.)
    for (const entry of state.pool.values()) {
      try {
        entry.proc.stdin?.end();
      } catch {
        // already gone
      }
    }
    process.exit(0);
  });
}

function handleFrame(line: string, state: BrokerState): void {
  let frame: OutboundFrame;
  try {
    frame = JSON.parse(line) as OutboundFrame;
  } catch {
    writeSupervisor({
      op: "log",
      level: "error",
      msg: `malformed frame from supervisor dropped: ${line.slice(0, 200)}`,
    });
    return;
  }
  switch (frame.op) {
    case "invoke":
      routeInvoke(frame, state);
      return;
    case "cancel":
      routeCancel(frame.id, state);
      return;
    case "warm":
      ensureEntry(poolKey(frame.session, frame.class), state, undefined, frame.fence);
      return;
    case "reap":
      reapEntries(frame.session, frame.class, state);
      return;
  }
}

function routeInvoke(frame: InvokeFrame, state: BrokerState): void {
  const key = poolKey(frame.session, frame.class ?? "rw");
  const entry = ensureEntry(key, state, frame.id, frame.fence);
  if (!entry) return; // ensureEntry already answered the caller
  entry.pending.add(frame.id);
  clearIdle(entry);
  // The fence is broker-side plumbing: the runner never sees its own jail plan.
  const { fence: _fence, ...runnerFrame } = frame;
  entry.proc.stdin!.write(encodeFrame(runnerFrame) + "\n", (err) => {
    if (!err) return;
    entry!.pending.delete(frame.id);
    writeSupervisor({
      id: frame.id,
      ok: false,
      error: { message: `[tool-exec] runner write failed: ${err.message}`, expected: false },
    });
  });
}

/**
 * The pool's single spawn path: invoke and warm share it, which is what makes
 * warm a real pre-spawn instead of a second copy of the logic. On spawn
 * failure, `failId` answers the waiting caller (a warm frame has no id, so it
 * only logs). A live entry whose fence id differs from the frame's is
 * replaced: isolation is argv, so changing the plan means a new process (a
 * fence-less warm followed by a fenced invoke lands here).
 */
function ensureEntry(
  key: string,
  state: BrokerState,
  failId?: string,
  fence?: WireFence,
): PoolEntry | null {
  const wantFenceId = fence?.id ?? "";
  const existing = state.pool.get(key);
  if (existing && !existing.dead) {
    if (existing.fenceId === wantFenceId) {
      armIdle(existing, key, state);
      return existing;
    }
    // Deliberate policy swap, not a crash: pending calls get the
    // executor-replaced shape so the model-facing error says what happened.
    dropEntry(existing, key, state, "executor-replaced");
  }
  let entry: PoolEntry;
  try {
    entry = spawnEntry(key, state, fence);
  } catch (e) {
    const message = `[tool-exec] executor spawn failed: ${formatError(e)}`;
    if (failId !== undefined) {
      writeSupervisor({ id: failId, ok: false, error: { message, expected: false } });
    } else {
      writeSupervisor({ op: "log", level: "error", msg: message });
    }
    return null;
  }
  state.pool.set(key, entry);
  armIdle(entry, key, state);
  return entry;
}

/** Route a cancel to the entry holding the id. */
function routeCancel(id: string, state: BrokerState): void {
  for (const entry of state.pool.values()) {
    if (entry.dead || !entry.pending.has(id)) continue;
    try {
      entry.proc.stdin?.write(encodeFrame({ id, op: "cancel" }) + "\n");
    } catch (e) {
      writeSupervisor({
        op: "log",
        level: "warn",
        msg: `cancel frame write failed for ${id}: ${formatError(e)}`,
      });
    }
    return;
  }
  // Nothing holds it: the call already answered (its reply is in flight) or
  // was cancelled twice. There is nothing to interrupt, and the supervisor
  // never waits for either outcome.
}

/** Drop the entries matching (session?, class?): idle teardown, session delete. */
function reapEntries(
  session: string | undefined,
  cls: ExecClass | undefined,
  state: BrokerState,
): void {
  for (const [key, entry] of [...state.pool]) {
    const entryClass = key.slice(key.lastIndexOf(" ") + 1);
    const entrySession = key.slice(0, key.lastIndexOf(" "));
    if (session !== undefined && entrySession !== session) continue;
    if (cls !== undefined && entryClass !== cls) continue;
    writeSupervisor({ op: "log", level: "debug", msg: `reaping ${key}` });
    dropEntry(entry, key, state);
  }
}

function clearIdle(entry: PoolEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function armIdle(entry: PoolEntry, key: string, state: BrokerState): void {
  clearIdle(entry);
  if (state.idleReapMs <= 0) return; // 0 disables the reaper
  if (entry.pending.size > 0) return; // a busy entry is not idle, whatever the clock says
  // unref so the reaper is never the reason a broker outlives its stdin.
  entry.idleTimer = setTimeout(() => dropEntry(entry, key, state), state.idleReapMs);
  entry.idleTimer.unref?.();
}

function spawnEntry(key: string, state: BrokerState, fence?: WireFence): PoolEntry {
  // Isolation is argv: a fence is a complete spawn command computed
  // supervisor-side (`bwrap <plan> -- bun <runner>`). Without one it is the
  // plain `bun <runner>`. The child adds no policy here, and the runner can
  // never tell fenced from unfenced -- same code, degraded path included.
  const [fenceCmd, ...fenceArgs] = fence?.prefix ?? [];
  const useFence = fence !== undefined && fenceCmd !== undefined;
  const proc = useFence
    ? spawn(fenceCmd, fenceArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: PROJECT_ROOT,
      })
    : spawn(process.execPath, [RUNNER_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: PROJECT_ROOT,
      });
  const entry: PoolEntry = {
    proc,
    pending: new Set<string>(),
    dead: false,
    idleTimer: null,
    fenceId: useFence ? fence.id : "",
    killTimer: null,
  };
  // Same reasoning as the broker child: pipe errors must not become unhandled
  // 'error' events in the broker.
  proc.stdin?.on("error", () => {});
  proc.stdout?.on("error", () => {});
  proc.stderr?.on("error", () => {});

  const out = new LineDecoder();
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    for (const line of out.push(chunk)) relayRunnerLine(key, entry, line, state);
  });
  const err = new LineDecoder();
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (chunk: string) => {
    for (const line of err.push(chunk)) {
      writeSupervisor({ op: "log", level: "warn", msg: `runner[${key}]: ${line}` });
    }
  });
  proc.on("error", (e: Error) => {
    failEntry(entry, key, state, `executor spawn failed: ${formatError(e)}`);
  });
  proc.on("exit", (code) => {
    failEntry(entry, key, state, `executor exited (code ${code ?? "signal"})`);
  });
  return entry;
}

/**
 * Forward a runner reply verbatim -- after checking the id belongs to this
 * entry. Call ids are supervisor-scoped (one uuid space across all
 * sessions), so entry-level ownership is the only thing standing between a
 * hostile runner and another session's pending call.
 */
function relayRunnerLine(
  key: string,
  entry: PoolEntry,
  line: string,
  state: BrokerState,
): void {
  let frame: InboundFrame;
  try {
    frame = JSON.parse(line) as InboundFrame;
  } catch {
    writeSupervisor({
      op: "log",
      level: "error",
      msg: `runner[${key}] malformed frame dropped: ${line.slice(0, 200)}`,
    });
    return;
  }
  if ("ok" in frame) {
    // Ownership gate: relay only replies for calls THIS entry holds pending.
    // The supervisor's pending map is global across sessions, so a buggy or
    // compromised runner (the defined adversary: model-authored code) that
    // guesses another entry's call id must not forge that session's tool
    // result through this channel. Late post-cancel replies still relay:
    // routeCancel deliberately leaves the id pending until the reply lands.
    if (!entry.pending.has(frame.id)) {
      logger.warn(`[tool-exec] runner[${key}] reply for unowned id ${frame.id} dropped`);
      return;
    }
    entry.pending.delete(frame.id);
    // The idle clock restarts here (armIdle ignores a still-busy entry).
    armIdle(entry, key, state);
    process.stdout.write(line + "\n");
    return;
  }
  if (frame.op === "log") {
    writeSupervisor({ op: "log", level: frame.level, msg: `runner[${key}]: ${frame.msg}` });
  }
}

/** A runner died with its own explanation: log it and drop the entry. */
function failEntry(
  entry: PoolEntry,
  key: string,
  state: BrokerState,
  message: string,
): void {
  writeSupervisor({ op: "log", level: "warn", msg: `runner[${key}]: ${message}` });
  dropEntry(entry, key, state);
}

/**
 * Remove an entry and end its process. Anything pending gets the
 * executor-died shape (crash) or the executor-replaced shape (a deliberate
 * fence-plan swap) -- for a reap that raced a live call, death and replacement
 * answer alike, since the supervisor's answer is the same either way: the
 * entry you were talking to is gone. Re-filling is lazy: the next call on this
 * key spawns a fresh entry.
 *
 * EOF first, hard kill only as fallback (increment-3 review): the runner
 * cancels its in-flight calls on stdin EOF and kills bash's whole process
 * group, and that SIGKILL escalation needs ~2s of the runner staying alive
 * to land. Killing the runner outright as the first strike would orphan a
 * detached shell -- which is precisely the leak this entry exists to prevent.
 */
function dropEntry(
  entry: PoolEntry,
  key: string,
  state: BrokerState,
  failKind: "executor-died" | "executor-replaced" = "executor-died",
): void {
  clearIdle(entry);
  if (entry.dead) return;
  entry.dead = true;
  if (state.pool.get(key) === entry) state.pool.delete(key);
  for (const id of entry.pending) {
    writeSupervisor({ id, ok: false, error: { kind: failKind, poolKey: key } });
  }
  entry.pending.clear();
  try {
    entry.proc.stdin?.end();
  } catch {
    // already gone
  }
  entry.killTimer = setTimeout(
    () => {
      try {
        entry.proc.kill();
      } catch {
        // already gone
      }
    },
    // Covers the runner's full cancel escalation plus slack; a healthy runner
    // exits long before this fires.
    3000,
  );
  entry.killTimer.unref?.();
}

// Test seams for the child half: a spawned broker child never reports coverage
// back to the test process, so tests/core/tool-exec-broker-worker.test.ts
// drives these in-process. The supervisor never calls any of them.
export {
  type PoolEntry,
  type BrokerState,
  poolKey,
  parseBrokerArgs,
  handleFrame,
  spawnEntry,
  relayRunnerLine,
};

if (import.meta.main) {
  runBroker();
}
