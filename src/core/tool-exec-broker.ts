// The tool execution plane's supervisor-side client.
//
// `ToolExecBroker`, the client stub that owns one broker child process, is
// plumbing only: it frames invokes onto the child's stdin and settles them
// from the replies. The child owns the executor pool keyed (sessionId,
// class); the supervisor never talks to pool entries directly. The child
// program itself lives in `tool-exec-broker-main.ts`; process-layout
// constants shared by both live in `tool-exec-layout.ts`.
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
import { idleReapMsOrDefault, PROJECT_ROOT, RUNNER_ENTRY } from "./tool-exec-layout.ts";
import {
  encodeFrame,
  LineDecoder,
  reviveWireError,
  type OutboundFrame,
  type InboundFrame,
  type InvokeFrame,
  type ExecClass,
  type ExecutorDiedError,
  type ExecutorReplacedError,
  type WireError,
  type WireFence,
  type WireToolResult,
  type WireWorkspace,
  type ToolExecLink,
} from "./tool-exec-protocol.ts";

// The broker child program is its own module, spawned as
// `bun <file> --idle-reap-ms=<n>`; nothing here runs in the child.
const BROKER_ENTRY = fileURLToPath(new URL("./tool-exec-broker-main.ts", import.meta.url));

// ── Mode resolution (config surface) ────────────────────────────────

export interface ToolExecPlaneSettings {
  mode: "worker" | "inline";
  fence: "off" | "probe";
}

/**
 * Validate the plane config values. Both keys are schema-owned
 * (core.config.json); production resolution (resolveAll) always populates
 * them, so an unset key means the host never ran resolution -- a hard config
 * error, like garbage: a security posture must never pick a mode silently.
 * (Deliberately no getLayerDefault fallback either: the schema default is
 * "worker", which would boot broker machinery in hosts that never opted in;
 * the old unset-means-inline reading was a code-resident backup default.)
 */
export function toolExecPlaneSettings(resolved: Record<string, unknown>): ToolExecPlaneSettings {
  const mode = resolved.toolExec;
  const fence = resolved.execFence;
  if (mode !== "worker" && mode !== "inline") {
    throw new ConfigError(`toolExec must be "worker" or "inline", got ${JSON.stringify(resolved.toolExec)}`);
  }
  if (fence !== "off" && fence !== "probe") {
    throw new ConfigError(`execFence must be "off" or "probe", got ${JSON.stringify(resolved.execFence)}`);
  }
  return { mode, fence };
}

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
// The first creation pins the posture; later callers with different knobs get
// the same broker, so name the drift once instead of letting an ignored
// config mislead its owner (hand-built multi-agent hosts are where this bites).
let sharedBroker: ToolExecBroker | null = null;
let sharedPosture: SharedPosture | null = null;
let postureWarned = false;

export interface SharedPosture {
  fence: string;
  envScrubbing: string;
}

/** Posture keys a later caller asks for that differ from the pinned ones ("", ""). */
export function postureDrift(pinned: SharedPosture, opts: ToolExecBrokerOptions): string[] {
  const drift: string[] = [];
  if (opts.fence !== undefined && opts.fence !== pinned.fence) {
    drift.push(`fence: kept "${pinned.fence}", ignored "${opts.fence}"`);
  }
  if (opts.envScrubbing !== undefined && String(opts.envScrubbing) !== pinned.envScrubbing) {
    drift.push(`envScrubbing: kept ${pinned.envScrubbing}, ignored ${opts.envScrubbing}`);
  }
  return drift;
}

export function sharedToolExecBroker(opts?: ToolExecBrokerOptions): ToolExecBroker {
  if (!sharedBroker) {
    sharedPosture = {
      fence: opts?.fence ?? "probe",
      envScrubbing: String(opts?.envScrubbing ?? true),
    };
    sharedBroker = new ToolExecBroker(opts);
    return sharedBroker;
  }
  if (!postureWarned && sharedPosture && opts) {
    const drift = postureDrift(sharedPosture, opts);
    if (drift.length > 0) {
      postureWarned = true;
      logger.warn(`[tool-exec] one broker per process keeps its first posture; ${drift.join("; ")}`);
    }
  }
  return sharedBroker;
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
  /** Broker entry module. Defaults to `tool-exec-broker-main.ts` (the child program). */
  brokerEntry?: string;
  /**
   * Idle time before the broker drops a pool entry. Passed to the child as
   * argv (the fence is argv; so is every knob the child needs). Test seam --
   * unset takes tool-exec-layout's default via idleReapMsOrDefault().
   */
  idleReapMs?: number;
  /** See DEFAULT_RESPAWN_CAP. Test seam. */
  respawnCap?: number;
  /** Fence policy from the resolved config. Default `probe`. */
  fence?: "off" | "probe";
  /**
   * Scrub secret-shaped env keys at the broker spawn. Default true. `false`
   * is the `envScrubbing: false` / `--disable-env-scrubbing` opt-out, and it
   * must reach this spawn too: pool entries inherit the broker's env, so a
   * broker that scrubbed unconditionally would silently defeat the opt-out
   * for every plane-routed tool (the runner's BashTool cannot restore keys
   * that never arrived).
   */
  envScrubbing?: boolean;
  /** Exact extra secret names (`envScrub.extra`) beyond the substring heuristics. */
  envScrubExtra?: readonly string[];
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
    /** The model-facing tool call id; `id` correlates cancel, this attributes output. */
    toolCallId?: string;
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
      ...(req.toolCallId !== undefined ? { toolCallId: req.toolCallId } : {}),
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
          `--idle-reap-ms=${idleReapMsOrDefault(this.#opts.idleReapMs)}`,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: PROJECT_ROOT,
          // The tool plane never sees provider credentials or hotdog's own
          // env; pool entries inherit from the broker. `envScrubbing: false`
          // copies the full environment on purpose (see ToolExecBrokerOptions).
          env: copyScrubbedEnv(
            process.env,
            this.#opts.envScrubExtra,
            this.#opts.envScrubbing !== false,
          ) as Record<string, string>,
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
 * FailFrame payloads: the plain wire error, the executor-died shape (a pool
 * entry that vanished with the call in flight), or the executor-replaced
 * shape (a deliberate swap: the fence plan changed under a live entry).
 * Surfaced as "[tool-exec crashed]" respectively "[tool-exec replaced]" error
 * tool results; the entry itself is already gone from the broker's pool map,
 * so the next call re-fills it.
 */
function wireFailToError(error: WireError | ExecutorDiedError | ExecutorReplacedError): Error {
  if ("message" in error) return reviveWireError(error);
  if (error.kind === "executor-died") {
    return new ToolError(
      `[tool-exec crashed] pool entry ${error.poolKey ?? "?"} died with the call in flight`,
    );
  }
  if (error.kind === "executor-replaced") {
    return new ToolError(
      `[tool-exec replaced] pool entry ${error.poolKey ?? "?"} was replaced by a changed fence plan with the call in flight`,
    );
  }
  return new Error(`[tool-exec] unknown fail frame (kind ${String((error as { kind?: string }).kind)})`);
}
