// The tool execution plane's broker.
//
// Two roles live in this module:
//
// - Imported by the supervisor: `ToolExecBroker`, the client stub that owns
//   one broker child process. It is plumbing only: it frames invokes onto the
//   child's stdin and settles them from the replies. The child owns the
//   executor pool keyed (sessionId, class); the supervisor never talks to pool
//   entries directly.
// - Spawned as the main module (`bun <this file>`): the broker worker itself.
//   It holds no conversation state, no credentials, no user-data access --
//   tool code lives only in pool entries (`src/workers/tool-exec.ts`).
//
// Hardening contract: nothing here ever downgrades a call to inline.
// Spawn/dispatch failures and pool-entry deaths reject or fail the pending
// call (the executor turns that into an error tool result); broker death
// respawns a capped number of times and then reports the plane degraded.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { logger } from "@utils/logger.ts";
import { copyScrubbedEnv } from "@utils/env.ts";
import { execFenceBackend, planFor } from "@utils/exec-plan.ts";
import { formatError, ConfigError, ToolError } from "./error.ts";
import {
  encodeFrame,
  LineDecoder,
  reviveWireError,
  type OutboundFrame,
  type InboundFrame,
  type InvokeFrame,
  type ExecClass,
  type ExecutorDiedError,
  type WireError,
  type WireFence,
  type WireToolResult,
  type WireWorkspace,
  type ToolExecLink,
} from "./tool-exec-protocol.ts";

const BROKER_ENTRY = fileURLToPath(import.meta.url);
const RUNNER_ENTRY = fileURLToPath(new URL("../workers/tool-exec.ts", import.meta.url));
/**
 * Hotdog's repo root (where tsconfig.json lives). Child processes are spawned
 * with this cwd so Bun resolves the `@core`/`@extensions`/`@utils` path
 * aliases no matter where the user launched hotdog from.
 */
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ── Mode resolution (config surface) ────────────────────────────────

export interface ToolExecPlaneSettings {
  mode: "worker" | "inline";
  fence: "off" | "probe";
}

/**
 * Validate the plane config values. An unset key means the host never opted
 * into the plane (hand-built resolved bags in tests/embedded hosts); garbage
 * is a hard config error -- a security posture must never fail open silently.
 */
export function toolExecPlaneSettings(resolved: Record<string, unknown>): ToolExecPlaneSettings {
  const mode = resolved.toolExec ?? "inline";
  const fence = resolved.execFence ?? "probe";
  if (mode !== "worker" && mode !== "inline") {
    throw new ConfigError(`toolExec must be "worker" or "inline", got ${JSON.stringify(resolved.toolExec)}`);
  }
  if (fence !== "off" && fence !== "probe") {
    throw new ConfigError(`execFence must be "off" or "probe", got ${JSON.stringify(resolved.execFence)}`);
  }
  return { mode, fence };
}

/**
 * How long a pool entry may sit with no calls before the broker drops it.
 * Generous: re-spawn costs ~100ms and only a session that went
 * quiet pays it, so the cheap direction is to keep entries.
 */
const DEFAULT_IDLE_REAP_MS = 5 * 60_000;

/**
 * The fence display for a resolved bag: `off` never probes; `probe` runs the
 * cached bwrap probe (once per process). A worker plane must never claim a
 * fence it does not have, and never hide one it does.
 */
export function execFenceDisplay(resolved: Record<string, unknown>): string {
  const { mode, fence } = toolExecPlaneSettings(resolved);
  // Inline never shows a fence, and `off` never probes: on both paths there
  // is no reason to touch the platform.
  if (mode === "inline" || fence === "off") return "off";
  return execFenceBackend() ?? "none -- probe failed";
}

/** One-line status label: `hotdog info` and the webui strip read the posture here. */
export function toolExecModeLabel(
  resolved: Record<string, unknown>,
  degraded = false,
  fenceDisplay = "none",
): string {
  const { mode } = toolExecPlaneSettings(resolved);
  // "bwrap" when the probe passed; "off" when policy says plain spawn;
  // "none -- probe failed" when policy wants a jail the platform cannot give.
  const label =
    mode === "inline" ? "inline (unfenced)" : `worker (fence: ${fenceDisplay})`;
  return degraded && mode === "worker" ? `${label} [degraded: broker respawn cap]` : label;
}

/**
 * The shared broker's runtime degraded flag, without constructing one: a
 * status read must never spawn a process. False until this process has
 * actually exhausted its respawn budget.
 */
export function sharedToolExecDegraded(): boolean {
  return sharedBroker?.degraded ?? false;
}

// One supervisor, one broker child (user ruling). Agent factories share it.
let sharedBroker: ToolExecBroker | null = null;
export function sharedToolExecBroker(opts?: ToolExecBrokerOptions): ToolExecBroker {
  return (sharedBroker ??= new ToolExecBroker(opts));
}

// ── Supervisor-side client ───────────────────────────────────────────────────

/**
 * Computes the fence for one (session, class, roots) tuple: a full spawn argv
 * when the platform can jail, null when it cannot (plain spawn, flagged in
 * the posture line). Lives supervisor-side because the broker child is
 * plumbing only: it prepends argv, it never decides policy.
 */
export type FencePlanner = (
  session: string,
  cls: ExecClass,
  roots: string[],
) => WireFence | null;

/** Sessions ride the scratch dir name; uuids pass untouched, anything else is flattened. */
function sanitizeForPath(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "session";
}

/**
 * The built-in planner: `off` fences nothing (never probes); `probe` pays the
 * cached bwrap probe on first use, then memoizes per (session, class, roots)
 * -- the scratch dir is created once and lives under the OS tmp dir (entry
 * death does not delete it; the tmp policy does).
 */
export function createFencePlanner(fence: "off" | "probe"): FencePlanner | null {
  if (fence === "off") return null;
  const memo = new Map<string, WireFence | null>();
  return (session, cls, roots) => {
    const key = `${session}\u0000${cls}\u0000${roots.join("\u0000")}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    // Probe first (cached): on a host with no working jail there is nothing
    // to plan and no scratch dir to create.
    if (execFenceBackend() === null) {
      memo.set(key, null);
      return null;
    }
    const scratch = mkdtempSync(
      `${join(tmpdir(), `hotdog-exec-${sanitizeForPath(session)}-${cls}-`)}`,
    );
    let spec: WireFence | null = null;
    const { prefixArgv, probe } = planFor({
      roots,
      cls,
      scratch,
      command: process.execPath,
      args: [RUNNER_ENTRY],
      repoRoot: PROJECT_ROOT,
    });
    if (prefixArgv && probe) {
      const joined = prefixArgv.join("\u0000");
      spec = { id: Bun.hash(joined).toString(36), prefix: prefixArgv };
    }
    memo.set(key, spec);
    return spec;
  };
}

/**
 * Consecutive broker crash-respawns allowed before the plane reports
 * degraded and refuses to spawn. Past the cap the answer is a loud
 * error, never a silent downgrade to inline: a security posture must not fail
 * open. Counter resets whenever a call completes, so a broker that dies once
 * an hour is not a degraded broker.
 */
const DEFAULT_RESPAWN_CAP = 3;

/**
 * Sliding crash-death window (increment-3 review follow-up): a broker that
 * dies once per served call resets the consecutive counter forever, so a
 * plain-spawn broker with a startup bug would respawn indefinitely.
 * RESPAWN_WINDOW_DEATHS crash deaths within RESPAWN_WINDOW_MS degrade the
 * plane regardless of completed calls in between.
 */
const RESPAWN_WINDOW_MS = 60_000;
const RESPAWN_WINDOW_DEATHS = 3;

export interface ToolExecBrokerOptions {
  /** Interpreter for the broker entry. Defaults to the running bun. */
  execPath?: string;
  /** Broker entry module. Defaults to this file (the child takes the main branch below). */
  brokerEntry?: string;
  /**
   * Idle time before the broker drops a pool entry. Passed to the child as
   * argv (the fence is argv; so is every knob the child needs). Test seam --
   * production uses DEFAULT_IDLE_REAP_MS via sharedToolExecBroker().
   */
  idleReapMs?: number;
  /** See DEFAULT_RESPAWN_CAP. Test seam. */
  respawnCap?: number;
  /** Fence policy from the resolved config. Default `probe`. */
  fence?: "off" | "probe";
  /**
   * Test seam replacing the built-in planner: any prefix argv can stand in
   * for bwrap (e.g. `env VAR=...`) so the fence plumbing is tested on hosts
   * without it. `null` disables the fence, like `fence: "off"`.
   */
  fencePlan?: FencePlanner | null;
}

interface PendingCall {
  resolve: (r: WireToolResult) => void;
  reject: (e: Error) => void;
}

export class ToolExecBroker implements ToolExecLink {
  #opts: ToolExecBrokerOptions;
  #respawnCap: number;
  #proc: ChildProcess | null = null;
  #starting: Promise<void> | null = null;
  #onReady: (() => void) | null = null;
  #onFatal: ((e: Error) => void) | null = null;
  #pending = new Map<string, PendingCall>();
  #seq = 0;
  /** Set when the child dies on its own (not by close()); consumed at respawn. */
  #crashed = false;
  #closing = false;
  #respawns = 0;
  /** Crash-death timestamps for the sliding window (catches the die-after-each-call flapper). */
  #deaths: number[] = [];
  #degraded = false;
  #degradedReason = "";
  #fencePlan: FencePlanner | null;

  constructor(opts: ToolExecBrokerOptions = {}) {
    this.#opts = opts;
    this.#respawnCap = opts.respawnCap ?? DEFAULT_RESPAWN_CAP;
    this.#fencePlan =
      opts.fencePlan !== undefined
        ? opts.fencePlan
        : createFencePlanner(opts.fence ?? "probe");
  }

  /** True once consecutive crash-respawns exhausted the cap. */
  get degraded(): boolean {
    return this.#degraded;
  }

  /**
   * The broker child's pid, or null when no child is running. Diagnostics and
   * tests: pool entries are this process's children, so a pid is what you need
   * to reason about the plane from outside it.
   */
  get pid(): number | null {
    return this.#proc?.pid ?? null;
  }

  /**
   * Execute one tool call on the plane. Rejects (never downgrades) when the
   * broker cannot start, dies, or closes with the call in flight; the
   * executor turns that into an error tool result, so the session-log
   * started-with-no-result record still classifies as outcome-unknown.
   */
  async invoke(req: {
    id?: string;
    session: string;
    tool: string;
    args: string | Record<string, unknown>;
    ctx: InvokeFrame["ctx"];
  }): Promise<WireToolResult> {
    await this.#ensureStarted();
    const proc = this.#proc!;
    const id = req.id ?? `x${++this.#seq}`;
    const fence = this.#fencePlan?.(req.session, "rw", req.ctx.workspace.roots);
    const frame: InvokeFrame = {
      id,
      op: "invoke",
      session: req.session,
      class: "rw",
      ...(fence ? { fence } : {}),
      tool: req.tool,
      args: req.args,
      ctx: req.ctx,
    };
    const settled = new Promise<WireToolResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    proc.stdin!.write(encodeFrame(frame) + "\n", (err) => {
      const p = this.#pending.get(id);
      if (err && p) {
        this.#pending.delete(id);
        p.reject(new Error(`[tool-exec] broker write failed: ${err.message}`));
      }
    });
    return settled;
  }

  /**
   * Interrupt an in-flight call. Fire-and-forget: the caller settles
   * the call itself, and whatever the runner answers afterwards is dropped
   * because this id is no longer pending.
   */
  cancel(id: string): void {
    const p = this.#pending.get(id);
    if (p) {
      this.#pending.delete(id);
      p.reject(new ToolError(`[tool-exec cancelled] call ${id}`));
    }
    this.#writeFrame({ id, op: "cancel" });
  }

  /**
   * Fire-and-forget pool pre-spawn: never fails a run. The
   * workspace rides along so a warmed entry gets the same fence an invoke
   * would plan; a warm without it still pre-spawns (unfenced) and the first
   * invoke replaces the entry if a fence is expected.
   */
  warm(session: string, cls: ExecClass, workspace?: WireWorkspace): void {
    const fence = workspace ? this.#fencePlan?.(session, cls, workspace.roots) : undefined;
    void this.#post({
      op: "warm",
      session,
      class: cls,
      ...(fence ? { fence } : {}),
      ...(workspace ? { workspace } : {}),
    });
  }

  /** Drop pool entries: the supervisor's idle/session-delete hook. */
  reap(session?: string, cls?: ExecClass): void {
    void this.#post({ op: "reap", session, class: cls });
  }

  async #post(frame: OutboundFrame): Promise<void> {
    try {
      await this.#ensureStarted();
      this.#writeFrame(frame);
    } catch (e) {
      // A dropped warm/reap costs an entry, not a run.
      logger.warn(`[tool-exec] ${(frame as { op: string }).op} frame dropped: ${formatError(e)}`);
    }
  }

  #writeFrame(frame: OutboundFrame): void {
    const stdin = this.#proc?.stdin;
    if (!stdin || !stdin.writable) return;
    try {
      stdin.write(encodeFrame(frame) + "\n");
    } catch (e) {
      logger.warn(`[tool-exec] frame write failed: ${formatError(e)}`);
    }
  }

  /** Tear the child down (stdin EOF -> broker kills its pool -> exit). For shutdown and tests. */
  async close(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    // Deliberate teardown, not a crash: it must not consume respawn budget.
    this.#closing = true;
    this.#proc = null;
    this.#starting = null;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    try {
      proc.stdin?.end();
    } catch {
      // already gone
    }
    // Grace covers the runner-side drain (in-flight cancel + bash SIGKILL
    // escalation, ~2s) so an orderly close takes the whole tree with it; a
    // broker that outlives the grace is killed and the runners drain alone.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3500).unref())]);
    try {
      proc.kill();
    } catch {
      // already gone
    }
    const err = new Error("[tool-exec] broker closed");
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #ensureStarted(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#degraded) return Promise.reject(degradedError(this.#degradedReason));
    if (this.#crashed) {
      this.#crashed = false;
      let reason: string | null = null;
      if (this.#respawns >= this.#respawnCap) {
        reason = `died ${this.#respawns} times in a row (respawn cap ${this.#respawnCap})`;
      } else {
        // Sliding death window: consecutive respawns reset when a call
        // completes (a flapping host is not a crash loop), but that reset is
        // unreachable protection for a broker that dies once per served call.
        // Deaths inside the window count regardless of completions.
        const now = Date.now();
        this.#deaths = this.#deaths.filter((t) => now - t <= RESPAWN_WINDOW_MS);
        if (this.#deaths.length >= RESPAWN_WINDOW_DEATHS) {
          reason =
            `died ${this.#deaths.length} times within ${RESPAWN_WINDOW_MS / 1000}s ` +
            `(sliding-window cap ${RESPAWN_WINDOW_DEATHS}; completions do not reset this one)`;
        }
      }
      if (reason) {
        this.#degraded = true;
        this.#degradedReason = reason;
        return Promise.reject(degradedError(reason));
      }
      this.#respawns++;
      logger.warn(`[tool-exec] respawning broker worker (${this.#respawns}/${this.#respawnCap})`);
    }
    this.#closing = false;
    let proc: ChildProcess;
    try {
      proc = spawn(
        this.#opts.execPath ?? process.execPath,
        [
          this.#opts.brokerEntry ?? BROKER_ENTRY,
          `--idle-reap-ms=${this.#opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS}`,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: PROJECT_ROOT,
          // The tool plane never sees provider credentials or hotdog's own
          // env; pool entries inherit from the broker.
          env: copyScrubbedEnv(process.env) as Record<string, string>,
        },
      );
    } catch (e) {
      return Promise.reject(new Error(`[tool-exec] broker spawn failed: ${formatError(e)}`));
    }
    this.#proc = proc;
    // Pipe errors (EPIPE racing a dying child) arrive on the stdio sockets,
    // not just the write callbacks; an unhandled 'error' event would throw in
    // the supervisor. Death itself is handled via the exit/error events.
    proc.stdin?.on("error", () => {});
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
    // The plane must never be the reason a host process stays alive: a one-shot
    // `hotdog -p` that warmed an entry would otherwise sit holding the broker's
    // stdio open forever. unref drops the claim, and the broker still goes away
    // with us -- its stdin hits EOF and it takes its pool down.
    try {
      proc.unref();
      // Node types only promise unref on Sockets; Bun's child pipes have it.
      for (const pipe of proc.stdio) (pipe as { unref?: () => void } | null)?.unref?.();
    } catch {
      // No unref available: the plane keeps the host alive, which is the
      // pre-unref behavior rather than a failure.
    }
    this.#starting = new Promise<void>((resolve, reject) => {
      this.#onReady = resolve;
      this.#onFatal = reject;

      const decoder = new LineDecoder();
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) this.#handleLine(line);
      });
      const errDecoder = new LineDecoder();
      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk: string) => {
        for (const line of errDecoder.push(chunk)) logger.warn(`[tool-exec:broker] ${line}`);
      });
      proc.on("error", (e: Error) => {
        this.#handleDeath(proc, new Error(`[tool-exec] broker process error: ${e.message}`));
      });
      proc.on("exit", (code) => {
        this.#handleDeath(
          proc,
          new Error(`[tool-exec] broker worker exited (code ${code ?? "signal"})`),
        );
      });
    });
    return this.#starting;
  }

  /**
   * The death of a child we already replaced (close(), or one respawn after
   * another) must not clobber the current child's bookkeeping, so the events
   * are identity-checked. A death that was not our own teardown consumes
   * respawn budget.
   */
  #handleDeath(proc: ChildProcess, err: Error): void {
    if (this.#proc !== proc) return;
    if (!this.#closing) {
      this.#crashed = true;
      this.#deaths.push(Date.now());
    }
    this.#failAll(err);
  }

  #handleLine(line: string): void {
    let frame: InboundFrame;
    try {
      frame = JSON.parse(line) as InboundFrame;
    } catch {
      logger.warn(`[tool-exec:broker] malformed frame dropped: ${line.slice(0, 200)}`);
      return;
    }
    if ("ok" in frame) {
      const p = this.#pending.get(frame.id);
      // Not pending = the caller already settled it (cancel) and stopped
      // listening: the late reply is dropped, exactly as a cancelled
      // uninterruptible tool's reply must be.
      if (!p) return;
      this.#pending.delete(frame.id);
      if (frame.ok) {
        // A call completed: the plane works, so crash-respawn history is stale.
        this.#respawns = 0;
        p.resolve(frame.result);
      } else {
        p.reject(wireFailToError(frame.error));
      }
      return;
    }
    if (frame.op === "ready") {
      const ready = this.#onReady;
      this.#onReady = null;
      this.#onFatal = null;
      ready?.();
      return;
    }
    if (frame.op === "log") {
      logger[frame.level](`[tool-exec:broker] ${frame.msg}`);
    }
  }

  #failAll(err: Error): void {
    this.#proc = null;
    this.#starting = null;
    const fatal = this.#onFatal;
    this.#onFatal = null;
    this.#onReady = null;
    fatal?.(err);
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }
}

/** Past a respawn cap or the death window: loud, capped, never an inline downgrade. */
function degradedError(reason: string): ToolError {
  return new ToolError(
    `[tool-exec degraded] broker worker ${reason}; ` +
      "it is not being respawned and calls are NOT falling back to in-process execution. " +
      "Check the [tool-exec:broker] log lines, or set toolExec: \"inline\" deliberately.",
  );
}

/**
 * FailFrame payloads: the plain wire error, or the executor-died shape --
 * a pool entry that vanished with the call in flight. Surfaced as a
 * "[tool-exec crashed]" error tool result; the entry itself is
 * already gone from the broker's pool map, so the next call re-fills it.
 */
function wireFailToError(error: WireError | ExecutorDiedError): Error {
  if ("message" in error) return reviveWireError(error);
  if (error.kind === "executor-died") {
    return new ToolError(
      `[tool-exec crashed] pool entry ${error.poolKey ?? "?"} died with the call in flight`,
    );
  }
  return new Error(`[tool-exec] unknown fail frame (kind ${String((error as { kind?: string }).kind)})`);
}

// ── Broker worker main ───────────────────────────────────────────────────────
//
// Runs as the child process. Pool entries are keyed (sessionId, class); an
// entry is either the supervisor's fence argv (`bwrap <plan> -- bun <runner>`,
// prepended verbatim at spawnEntry()) or a plain `bun <runner>`, because
// isolation is argv.

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
    // reaping it. (A runner wedged past its own drain outlives us -- the same
    // documented trade-off as an unclean supervisor death, and fenced entries
    // go down with their jail either way via --die-with-parent.)
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
    dropEntry(existing, key, state);
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

/** Forward a runner reply verbatim: call ids are supervisor-scoped. */
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
 * executor-died shape -- for a crash and for a reap that raced a
 * live call alike, since the supervisor's answer is the same either way: the
 * entry you were talking to is gone. Re-filling is lazy: the next call on this
 * key spawns a fresh entry.
 *
 * EOF first, hard kill only as fallback (increment-3 review): the runner
 * cancels its in-flight calls on stdin EOF and kills bash's whole process
 * group, and that SIGKILL escalation needs ~2s of the runner staying alive
 * to land. Killing the runner outright as the first strike would orphan a
 * detached shell -- which is precisely the leak this entry exists to prevent.
 */
function dropEntry(entry: PoolEntry, key: string, state: BrokerState): void {
  clearIdle(entry);
  if (entry.dead) return;
  entry.dead = true;
  if (state.pool.get(key) === entry) state.pool.delete(key);
  for (const id of entry.pending) {
    writeSupervisor({ id, ok: false, error: { kind: "executor-died", poolKey: key } });
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

if (import.meta.main) {
  runBroker();
}
