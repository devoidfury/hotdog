// sysbox -- kernel-gated sandbox spawning for hotdog tools.
//
// Mechanism layer (docs/sysbox-sandbox.md). Main-process surface is TS-only:
// the C launcher is compiled and run exclusively by the sbx-exec helper and
// the sup.ts supervisor worker, so bun:ffi/cc failure domains never overlap
// with the agent session, and hotdog itself can run under --no-ffi-cc
// without disabling the sandbox.
//
// static: helper installs a seccomp deny filter on itself and execve's the
//   target. Callers keep using the returned ChildProcess exactly like the
//   unsandboxed spawn: pipes, exit codes, killProcessGroup all work
//   unchanged (execve preserves pid, so the detached process group is the
//   command tree).
// fence: static + a Landlock ruleset built in the helper before exec
//   (workspace roots + scratch rw, system dirs ro, TCP bind denied where
//   the ABI supports it). Allowlist-only: workspace.deny is NOT expressible
//   here -- that stays gate's job (docs/sysbox-sandbox.md "Enforcement ladder").
// gate: fence (where Landlock is available) + USER_NOTIF. A per-spawn
//   supervisor worker (sup.ts) holds
//   the notify fd; notifications are decoded here (paths via /proc, no FFI
//   in main), run through the caller's decider (policy.ts -> hooks), and
//   answered. Every notification gets an answer: decider throw -> deny
//   (invariant 2); the worker self-answers -EINTR at its deadline
//   (invariant 3).

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ConfigError, formatError } from "@core/error.ts";
import { logger } from "../logger.ts";
import { OWN_PROCESS_GROUP } from "../process-group.ts";
import type { Workspace } from "../workspace.ts";
import { detectCapabilities, launcherCPath, sbHelperPath } from "./capabilities.ts";
import {
  STATIC_DENIED_SYSCALLS,
  OPEN_WRITE_MASK,
} from "./denied-syscalls.ts";
import {
  evaluateGate,
  scratchDirs,
  ALLOWED_DEVICE_PATHS,
  EACCES,
  type GateDecision,
  type GateRequest,
} from "./policy.ts";
import {
  readChildBytes,
  readChildCString,
  readChildArgv,
  readChildSaFamily,
  resolveSyscallPath,
  expandFdLink,
} from "./procfs.ts";

export { detectCapabilities } from "./capabilities.ts";
export type { SysboxCapabilities } from "./capabilities.ts";
export { STATIC_DENIED_SYSCALLS, GATE_TRAPPED_SYSCALLS, MAX_DENY_SYSCALLS, OPEN_WRITE_MASK } from "./denied-syscalls.ts";
export type { DeniedSyscall, TrappedSyscall } from "./denied-syscalls.ts";
export { evaluateGate, EPERM, EACCES } from "./policy.ts";
export type { GateDecision, GateRequest, GateRequestKind } from "./policy.ts";

/** Helper exit codes: setup/exec failures where the command never ran. */
export const SBX_EXIT_SETUP_FAILED = 126;
export const SBX_EXIT_EXEC_FAILED = 127;

export interface SandboxSpawnOptions {
  /** Shell command line, run as exe ["sh","-c",command]. */
  command: string;
  /** Working directory applied by the helper before exec; null inherits. */
  cwd: string | null;
  /** Env for the sandboxed command (NOT for the helper, which gets {}). */
  env: Record<string, string>;
  exe?: string;
  /** Override the deny set (tests); defaults to STATIC_DENIED_SYSCALLS. */
  deny?: readonly number[];
  /** Landlock fence (fence mode, and stacked under gate when available). */
  fence?: FenceConfig | null;
}

/**
 * fence mode ruleset inputs. `rw` gets every fs right the kernel's Landlock
 * ABI supports (workspace roots + scratch), `ro` EXECUTE|READ only. Device
 * sinks (/dev/null &co) get per-file rw rules -- exactly the gate policy's
 * ALLOWED_DEVICE_PATHS, not all of /dev.
 *
 * Honest scope notes (docs/sysbox-sandbox.md):
 * - allowlist-only: workspace.deny cannot be expressed; precise policy is
 *   the gate trap set.
 * - ro system dirs include /etc, /usr/... wholesale; home dirs are NOT
 *   readable -- `cat ~/.ssh/id_rsa` -> EACCES is the point (Motivation).
 */
export interface FenceConfig {
  rw: string[];
  ro: string[];
}

/** System dirs a working shell needs read+execute on. Missing entries are
 * skipped kernel-side (ENOENT), so distro layout variation is fine. */
export const FENCE_SYSTEM_RO_DIRS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
];

export function fenceConfigFor(workspace: Workspace): FenceConfig {
  return {
    rw: [...workspace.roots, ...scratchDirs(), ...ALLOWED_DEVICE_PATHS],
    ro: [...FENCE_SYSTEM_RO_DIRS],
  };
}

function validateSpawnOpts(opts: SandboxSpawnOptions): void {
  if (opts.command.indexOf("\0") !== -1) {
    throw new ConfigError("sandbox command must not contain an embedded NUL");
  }
  const envEntries = Object.keys(opts.env);
  if (envEntries.length > 256) {
    throw new ConfigError(`sandbox env exceeds 256 entries (${envEntries.length})`);
  }
}

let launcherHashLogged = false;

function logLauncherHashOnce(): void {
  if (launcherHashLogged) return;
  launcherHashLogged = true;
  try {
    const hash = createHash("sha256").update(readFileSync(launcherCPath())).digest("hex");
    logger.info(`[sysbox] launcher.c sha256=${hash}`);
  } catch (e) {
    logger.warn(`[sysbox] could not hash launcher.c: ${e}`);
  }
}

function buildHelperChild(opts: SandboxSpawnOptions, gateName: string | null): ChildProcess {
  const cfg = JSON.stringify({
    exe: opts.exe ?? "/bin/sh",
    argv: ["sh", "-c", opts.command],
    env: opts.env,
    cwd: opts.cwd,
    deny: Array.from(opts.deny ?? STATIC_DENIED_SYSCALLS.map((d) => d.nr)),
    gateName,
    fence: opts.fence ?? null,
  });

  // stdio[3] is the config pipe (helper reads it to EOF). The helper process
  // itself gets an empty env: scrubbed vars belong to the SANDBOXED command
  // and travel inside the config, so nothing sensitive is exposed via /proc's
  // environ even before exec.
  const child = spawn(process.execPath, [sbHelperPath()], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: {},
    ...OWN_PROCESS_GROUP,
  });

  const cfgStream = child.stdio[3] as import("node:stream").Writable | null;
  if (!cfgStream) {
    child.kill("SIGKILL");
    throw new ConfigError("sysbox: config pipe (stdio[3]) unavailable");
  }
  cfgStream.on("error", (e: Error) => {
    // EPIPE when the helper died before reading (setup error surfacing via
    // its own exit code/stderr is the authoritative signal).
    logger.debug(`[sysbox] config pipe closed early: ${e.message}`);
  });
  cfgStream.end(cfg);

  return child;
}

export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
  const caps = detectCapabilities();
  if (!caps.staticAvailable) {
    // Caller validation normally happens at startup (fail-closed invariant);
    // this is the second gate for direct/programmatic callers.
    throw new ConfigError(`sysbox is unavailable here: ${caps.reasons.join("; ")}`);
  }
  if (opts.fence && !caps.landlockAvailable) {
    throw new ConfigError(`sysbox fence mode is unavailable here: ${caps.reasons.join("; ")}`);
  }
  validateSpawnOpts(opts);
  logLauncherHashOnce();
  return buildHelperChild(opts, null);
}

// ── gate mode ─────────────────────────────────────────────────────────────

export type GateDecider = (req: GateRequest) => GateDecision | Promise<GateDecision>;

/** Default decider: pure workspace policy, no hooks (ask -> deny). */
export function defaultDeciderFor(workspace: Workspace | null): GateDecider {
  return (req) => {
    const d = evaluateGate(workspace, req);
    if (d.action === "ask") {
      return { action: "deny", errno: EACCES, why: `unattended ask denied: ${d.why}` };
    }
    return d;
  };
}

export interface SandboxGateHandle {
  child: ChildProcess;
  /** Stop supervision; pending notifications resolve -EINTR. Idempotent. */
  close(): void;
}

let gateSeq = 0;

interface SupNotify {
  type: "notify";
  id: string;
  pid: number;
  nr: number;
  args: string[];
}

export async function spawnSandboxedWithGate(
  opts: SandboxSpawnOptions & { decide: GateDecider },
): Promise<SandboxGateHandle> {
  const caps = detectCapabilities();
  if (!caps.gateAvailable) {
    throw new ConfigError(`sysbox gate mode is unavailable here: ${caps.reasons.join("; ")}`);
  }
  validateSpawnOpts(opts);
  logLauncherHashOnce();

  const gateName = `hotdog-sbx-${process.pid}-${++gateSeq}`;
  const worker = new Worker(new URL("./sup.ts", import.meta.url));

  let closed = false;
  let termTimer: ReturnType<typeof setTimeout> | null = null;
  const finishWorker = () => {
    if (termTimer) { clearTimeout(termTimer); termTimer = null; }
    if (!workerTerminated) {
      workerTerminated = true;
      worker.terminate();
    }
  };
  let workerTerminated = false;

  const startup = new Promise<{ ok: true } | { ok: false; why: string }>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "need-start") { worker.postMessage({ type: "start", gateName }); return; }
      if (m?.type === "ready") { resolve({ ok: true }); return; }
      if (m?.type === "fatal") { resolve({ ok: false, why: String(m.why) }); return; }
      if (m?.type === "closed") { logger.debug(`[sysbox] supervisor closed: ${m.why}`); resolve({ ok: false, why: `supervisor exited early: ${m.why}` }); }
      if (m?.type === "log") { logger.info(`[sysbox] ${m.msg}`); }
    };
    worker.onerror = (ev) => resolve({ ok: false, why: `supervisor worker error: ${ev.message ?? ev}` });
    setTimeout(() => resolve({ ok: false, why: "supervisor startup timeout" }), 15000);
  });

  const start = await startup;
  if (!start.ok) {
    if (!workerTerminated) { workerTerminated = true; worker.terminate(); }
    throw new ConfigError(`sysbox gate startup failed: ${start.why}`);
  }

  // Replace the startup handler with the notify handler.
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m?.type === "notify") {
      void handleNotify(worker, m as SupNotify, opts.decide);
      return;
    }
    if (m?.type === "closed") {
      logger.debug(`[sysbox] supervisor ended: ${m.why}`);
      finishWorker();
      return;
    }
    if (m?.type === "log") { logger.info(`[sysbox] ${m.msg}`); return; }
  };
  worker.onerror = (ev) => {
    logger.error(`[sysbox] supervisor worker error: ${ev.message ?? ev}`);
    finishWorker();
  };

  let child: ChildProcess;
  try {
    child = buildHelperChild(opts, gateName);
  } catch (e) {
    finishWorker();
    throw e;
  }
  child.on("close", () => {
    // Give the supervisor a beat to drain the exit-time notifications
    // (poll slices are 500ms), then stop it. The kernel also releases the
    // notify fd side once the last sandboxed task is gone.
    setTimeout(closeHandle, 600);
  });

  const closeHandle = () => {
    if (closed) return;
    closed = true;
    try { worker.postMessage({ type: "stop" }); } catch { /* already gone */ }
    termTimer = setTimeout(finishWorker, 1500);
    termTimer.unref?.();
  };

  return { child, close: closeHandle };
}

async function handleNotify(
  worker: Worker,
  m: SupNotify,
  decide: GateDecider,
): Promise<void> {
  const pid = m.pid;
  const nr = m.nr;
  let error = 0;
  let why = "";
  try {
    const a = m.args.map((s: string) => BigInt(s));
    const arg = (i: number): bigint => a[i] ?? 0n;
    let req: GateRequest | null = null;
    switch (nr) {
      case 59: { // execve: audit log, always allow (audit-only by design, not a v1 approval gate)
        const argv = readChildArgv(pid, arg(1));
        logger.info(`[sysbox] exec pid=${pid}: ${argv.join(" ") || `<pid ${pid}>`}`);
        break;
      }
      case 257: { // openat (write flags only, per BPF mask)
        req = { kind: "open.write", pid, syscall: nr, paths: [resolvedPath(pid, arg(0), arg(1))] };
        break;
      }
      case 85: { // creat: legacy write-open, path relative to the child's cwd
        req = { kind: "open.write", pid, syscall: nr, paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0))] };
        break;
      }
      case 76: { // truncate: path truncation, never opens the file
        req = { kind: "truncate", pid, syscall: nr, paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0))] };
        break;
      }
      case 83: // mkdir
      case 133: { // mknod
        req = { kind: "create", pid, syscall: nr, paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0))] };
        break;
      }
      case 258: // mkdirat
      case 259: { // mknodat
        req = { kind: "create", pid, syscall: nr, paths: [resolvedPath(pid, arg(0), arg(1))] };
        break;
      }
      case 88: { // symlink(target, linkpath): the ENTRY is the operation; the
        // target string is inert until an open follows it, and every later
        // open is itself trapped.
        req = { kind: "create", pid, syscall: nr, paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(1))] };
        break;
      }
      case 266: { // symlinkat(target, newdirfd, linkpath)
        req = { kind: "create", pid, syscall: nr, paths: [resolvedPath(pid, arg(1), arg(2))] };
        break;
      }
      case 86: { // link(old, new): inode aliasing; both endpoints classified
        req = {
          kind: "link",
          pid,
          syscall: nr,
          paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0)), resolvedPath(pid, AT_FDCWD_BIGINT, arg(1))],
        };
        break;
      }
      case 265: { // linkat(olddirfd, oldpath, newdirfd, newpath, flags)
        req = {
          kind: "link",
          pid,
          syscall: nr,
          paths: [resolvedPath(pid, arg(0), arg(1)), resolvedPath(pid, arg(2), arg(3))],
        };
        break;
      }
      case 437: { // openat2: trapped unconditionally (flags are in child memory)
        const how = openat2Flags(pid, arg(2));
        if (how === null) {
          error = -EACCES;
          why = "openat2 struct open_how unreadable (fail closed)";
          logger.info(`[sysbox] deny openat2 pid=${pid}: ${why}`);
        } else if ((how & BigInt(OPEN_WRITE_MASK)) === 0n) {
          // read-only open: allow without consulting policy (parity with
          // the read-only openat ALLOW baked into the filter)
        } else {
          req = { kind: "open.write", pid, syscall: nr, paths: [resolvedPath(pid, arg(0), arg(1))] };
        }
        break;
      }
      case 87: // unlink (legacy: single path, relative to the child's cwd)
      case 84: { // rmdir
        req = { kind: "unlink", pid, syscall: nr, paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0))] };
        break;
      }
      case 263: { // unlinkat
        req = { kind: "unlink", pid, syscall: nr, paths: [resolvedPath(pid, arg(0), arg(1))] };
        break;
      }
      case 82: { // rename (legacy: both paths relative to the child's cwd)
        req = {
          kind: "rename",
          pid,
          syscall: nr,
          paths: [resolvedPath(pid, AT_FDCWD_BIGINT, arg(0)), resolvedPath(pid, AT_FDCWD_BIGINT, arg(1))],
        };
        break;
      }
      case 264: // renameat (same arg layout as renameat2)
      case 316: { // renameat2: from (dirfd0,path1) -> (dirfd2,path3)
        req = {
          kind: "rename",
          pid,
          syscall: nr,
          paths: [resolvedPath(pid, arg(0), arg(1)), resolvedPath(pid, arg(2), arg(3))],
        };
        break;
      }
      case 42: // connect
      case 44: // sendto
      case 46: // sendmsg
      case 345: { // sendmmsg -- connectionless sends are egress too
        req = { kind: "connect", pid, syscall: nr, paths: [], domain: nr === 42 ? readChildSaFamily(pid, arg(1)) ?? undefined : undefined };
        break;
      }
      default:
        // A trap we don't implement: fail closed. (Filter and trap table are
        // pinned together by tests; this is the runtime backstop.)
        req = { kind: "connect", pid, syscall: nr, paths: [], domain: undefined };
        logger.warn(`[sysbox] unexpected trap syscall ${nr} from pid ${pid}: denying`);
    }
    if (req) {
      let decision: GateDecision;
      try {
        decision = await decide(req);
      } catch (e) {
        // Invariant 2: a handler that throws means deny.
        decision = { action: "deny", errno: EACCES, why: `decider threw: ${formatError(e)}` };
      }
      if (decision.action === "deny") {
        error = -decision.errno;
        why = decision.why;
        logger.info(`[sysbox] deny ${req.kind} pid=${pid}: ${decision.why}`);
      } else if (decision.action === "ask") {
        // Unreachable via well-behaved deciders; treat as deny.
        error = -EACCES;
        why = "ask not resolved";
        logger.warn(`[sysbox] unresolved ask denied pid=${pid}: ${decision.why}`);
      }
    }
  } catch (e) {
    error = -EACCES;
    why = `notify handling threw: ${formatError(e)}`;
    logger.error(`[sysbox] ${why}`);
  }
  try {
    worker.postMessage({ type: "resp", id: m.id, error, val: 0 });
  } catch {
    logger.debug(`[sysbox] resp lost for ${m.id} (${why || "allow"}) -- worker gone`);
  }
}

function resolvedPath(pid: number, dirfdRaw: bigint, pathAddr: bigint): string | null {
  const raw = readChildCString(pid, pathAddr);
  if (raw === null) return null;
  const joined = resolveSyscallPath(pid, dirfdRaw, raw);
  if (joined === null) return null;
  return expandFdLink(pid, joined);
}

const AT_FDCWD_BIGINT = -100n;

/** Read struct open_how.flags (u64 at offset 0) from the child. The kernel
 * only requires size >= 8 (older ABIs); trailing fields are ignored.
 * null = unreadable -> caller denies (fail closed). */
function openat2Flags(pid: number, howAddr: bigint): bigint | null {
  const buf = readChildBytes(pid, howAddr, 8);
  if (buf === null) return null;
  return new DataView(buf.buffer).getBigUint64(0, true);
}
