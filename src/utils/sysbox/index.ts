// sysbox -- kernel-gated sandbox spawning for hotdog tools.
//
// Mechanism layer (docs/sysbox-sandbox.md). Main-process surface is TS-only:
// the C launcher is compiled and run exclusively by the sbx-exec helper, so
// bun:ffi/cc failure domains never overlap with the agent session, and hotdog
// itself can run under --no-ffi-cc without disabling the sandbox.
//
// Every guarantee here is installed BEFORE execve and enforced by the kernel
// afterwards: once the helper execs, hotdog has no decision point left in the
// command's path. Nothing to race, nothing to leak an fd, nothing that can die
// and wedge the command -- the reason the USER_NOTIF "gate" mode that used to
// sit on this path is gone (docs/agents/sandbox-direction.md).
//
// static: helper installs a seccomp deny filter on itself and execve's the
//   target. Callers keep using the returned ChildProcess exactly like the
//   unsandboxed spawn: pipes, exit codes, killProcessGroup all work
//   unchanged (execve preserves pid, so the detached process group is the
//   command tree).
// fence: static + a Landlock ruleset built in the helper before exec
//   (workspace roots + scratch rw, system + $PATH dirs ro, every network right
//   the kernel's ABI knows handled with no allow rules). Landlock is
//   allowlist-only, so workspace.deny has no kernel expression here: a
//   deny-listed file inside a granted root stays reachable. Closing that needs
//   a mount view (deny-as-absence), which is design-not-code -- see
//   docs/agents/sandbox-direction.md and docs/sysbox-sandbox.md "Future work".
// cgroups: when the host exposes a writable cgroup v2 subtree, every
//   sandboxed spawn (any mode) runs inside a per-spawn cgroup with pids.max
//   + memory.max set (fork/zip-bomb DoS containment); the helper moves
//   itself in pre-exec, this module owns creation and removal.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, formatError } from "@core/error.ts";
import { logger } from "../logger.ts";
import { OWN_PROCESS_GROUP } from "../process-group.ts";
import type { Workspace } from "../workspace.ts";
import {
  detectCapabilities,
  launcherCPath,
  sbHelperPath,
  cgroupMemoryCapBytes,
  parseMemoryEventsOomKill,
  parseMemTotalKb,
} from "./capabilities.ts";
import { STATIC_DENIED_SYSCALLS } from "./denied-syscalls.ts";

export { detectCapabilities } from "./capabilities.ts";
export type { SysboxCapabilities } from "./capabilities.ts";
export { STATIC_DENIED_SYSCALLS, MAX_DENY_SYSCALLS } from "./denied-syscalls.ts";
export type { DeniedSyscall } from "./denied-syscalls.ts";

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
  /** Landlock fence (fence mode); null for static mode. */
  fence?: FenceConfig | null;
}

/**
 * fence mode ruleset inputs. `rw` gets every fs right the kernel's Landlock
 * ABI supports (workspace roots + scratch), `ro` EXECUTE|READ only. Device
 * sinks (/dev/null &co) get per-file rw rules -- exactly ALLOWED_DEVICE_PATHS,
 * not all of /dev.
 *
 * Honest scope notes (docs/sysbox-sandbox.md):
 * - Landlock is allowlist-only: workspace.deny has no expression in the
 *   RULESET, so a deny-listed file inside a granted root stays reachable and
 *   writable from a fenced command. Nothing else in bash enforces it either;
 *   the file tools (`read`/`grep`/`explore`) do.
 * - ro system dirs include /etc, /usr/... wholesale, plus the $PATH dirs
 *   (a toolchain installed outside the system dirs, e.g. bun in ~/.bun/bin,
 *   must stay runnable); home dirs are NOT readable otherwise --
 *   `cat ~/.ssh/id_rsa` -> EACCES is the point (Motivation).
 */
export interface FenceConfig {
  rw: string[];
  ro: string[];
}

/** The ruleset for one spawn: everything the command may write (roots,
 * scratch, device sinks) and everything it may only read+execute. */
export function fenceConfigFor(workspace: Workspace): FenceConfig {
  return {
    rw: [...workspace.roots, ...scratchDirs(), ...ALLOWED_DEVICE_PATHS],
    ro: fenceReadDirs(),
  };
}

/** Device sinks commands write constantly; gating them is noise, not safety.
 * They carry no data in either direction -- which is why the controlling
 * terminal (/dev/tty, /dev/console) and the harness's own pty node
 * (/dev/pts/N) are NOT among them. Nothing closes /dev/pts now that the gate
 * is gone: the ro /dev mirror admits it, so a fenced command can read the
 * terminal hotdog is attached to (Known ceilings). */
export const ALLOWED_DEVICE_PATHS: readonly string[] = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
];

/** System dirs a working shell needs read+execute on: the dynamic loader, /etc
 * lookups, /proc + /sys, the device sinks. Wholesale ro is deliberate -- the
 * alternative (a per-library allowlist) breaks on every distro upgrade.
 * Missing entries are skipped kernel-side (ENOENT).
 * The confidential surfaces INSIDE these trees (/proc/kcore, /dev/mem, the
 * per-pid memory files, /dev/tty) are exactly what Landlock cannot express: it
 * has no negative rules, and a ro rule on /dev still admits /dev/mem. Nothing
 * closes them -- their openness is a documented ceiling (docs/sysbox-sandbox.md
 * "Known ceilings"); closing them is what the unbuilt mount view was for. */
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

/** Absolute dirs of $PATH, normalized (trailing slashes dropped). Entries that
 * are empty or relative are skipped -- the shell resolves those against its
 * cwd, which no fence rule can express -- and so is "/", whose under() would
 * match everything and turn the whole filesystem into a read surface. */
export function pathExecDirs(env?: Record<string, string | undefined>): string[] {
  const raw = (env ?? process.env).PATH;
  if (!raw) return [];
  const dirs: string[] = [];
  for (const entry of raw.split(":")) {
    const dir = entry.replace(/\/+$/, "");
    if (dir === "" || !dir.startsWith("/")) continue;
    dirs.push(dir);
  }
  return dirs;
}

/** The read/exec allowlist the fence installs -- fenceConfigFor feeds exactly
 * this to Landlock. Missing entries are skipped kernel-side (ENOENT), so
 * distro layout and per-user toolchain variation is fine. Without the $PATH
 * half, a toolchain living outside the system dirs (bun installed to
 * ~/.bun/bin) is unreadable inside the fence and every sandboxed command that
 * invokes it EACCESes.
 * Ceiling: whatever an absolute PATH entry points at becomes readable, so an
 * entry onto a broad dir (e.g. $HOME itself) widens the read surface -- PATH is
 * the "what may I run" surface, and running it means reading it. */
export function fenceReadDirs(env?: Record<string, string | undefined>): string[] {
  return [...FENCE_SYSTEM_RO_DIRS, ...pathExecDirs(env)];
}

/** Scratch dirs: the sandbox's write surface outside the workspace roots.
 * This is the real, machine-shared /tmp -- there is no per-spawn tmpfs (that
 * needs the unbuilt mount view), so cross-run collision names are the cost,
 * which is why the tests below use pid-suffixed names. */
export function scratchDirs(env?: Record<string, string | undefined>): string[] {
  const dirs = ["/tmp", "/var/tmp"];
  const t = (env ?? process.env).TMPDIR;
  if (t && t.startsWith("/")) dirs.push(t.endsWith("/") ? t.slice(0, -1) : t);
  return dirs;
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

// ── cgroup DoS containment (all sandbox modes, best-effort) ─────────────
// Per-spawn cgroup v2 with pids.max (fork bombs: further forks EAGAIN) and
// memory.max (zip bombs / memory hogs: in-cgroup OOM kill, not a host
// panic). The helper writes its own pid into cgroup.procs before it does
// anything else; every descendant inherits via fork/exec. This is NOT a
// sandbox mode -- it is belt-and-suspenders hardening applied when the host
// delegates a writable subtree (capabilities.cgroupAvailable); creation
// failure degrades with a warn instead of refusing, because the requested
// mode's own guarantees (seccomp/landlock) still hold without it.
// Known ceiling: hotdog SIGKILLed mid-command leaves a stale empty-ish
// dir behind (nothing runs cleanup); harmless kernel litter.

/** Process/thread cap per sandbox spawn. Generous: bun helpers + toolchains
 * are thread-hungry; the point is to make a fork bomb fail at N, not to
 * tune a build box. */
export const SBX_CGROUP_PIDS_MAX = 512;

let cgroupSeq = 0;

/** Create `<cgroupParentDir>/hotdog-sbx-<pid>-<seq>` with DoS limits. The
 * hosting dir is the nearest delegated ancestor of our own cgroup resolved
 * once by capability detection (findCgroupParentDir) -- our own cgroup is
 * usually a systemd leaf scope where no child can ever get limit files.
 * Returns the dir path (passed to the helper, which joins it) or null when
 * unavailable / failed (caller degrades). */
function createSbxCgroupDir(seq: number): string | null {
  try {
    const parent = detectCapabilities().cgroupParentDir;
    if (parent === null) return null;
    const dir = join(parent, `hotdog-sbx-${process.pid}-${seq}`);
    mkdirSync(dir);
    let limited = false;
    // Each limit is optional (controller may not be delegated in our
    // subtree); at least one must land or the cgroup buys nothing.
    try {
      writeFileSync(join(dir, "pids.max"), String(SBX_CGROUP_PIDS_MAX));
      limited = true;
    } catch { /* controller absent */ }
    try {
      const memKb = (() => {
        try {
          return parseMemTotalKb(readFileSync("/proc/meminfo", "utf8"));
        } catch {
          return null;
        }
      })();
      writeFileSync(join(dir, "memory.max"), String(cgroupMemoryCapBytes(memKb)));
      limited = true;
      // Swap would just move the bomb off the radar; zero it when present.
      try { writeFileSync(join(dir, "memory.swap.max"), "0"); } catch { /* absent */ }
    } catch { /* controller absent */ }
    if (!limited) {
      try { rmdirSync(dir); } catch { /* gone */ }
      return null;
    }
    return dir;
  } catch (e) {
    logger.warn(`[sysbox] cgroup create failed (running without DoS limits): ${formatError(e)}`);
    return null;
  }
}

/** rmdir once the spawn is done: the kernel rejects rmdir while members
 * live (EBUSY), so retry a bounded while (a daemonized leftover keeps the
 * limits ON, which is the right failure mode) then give up quietly.
 *
 * rmdirSync, not rmSync: rmSync without `recursive` does not issue a plain
 * rmdir (on bun 1.3.14 it fails outright, measured), and with `recursive`
 * it would try to unlink the cgroup's virtual files (EPERM). rmdir(2) on a
 * process-empty cgroup is the only call the kernel accepts here. */
function removeSbxCgroupDir(dir: string): void {
  let attempts = 0;
  const attempt = (): void => {
    try {
      rmdirSync(dir);
      return;
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return;
      if (++attempts >= 20) {
        logger.debug(`[sysbox] cgroup ${dir} still busy after ${attempts} rmdir attempts; left in place`);
        return;
      }
      const t = setTimeout(attempt, 500);
      t.unref?.();
    }
  };
  attempt();
}

/** Recorded when a spawn's cgroup reported an in-cgroup OOM kill (the
 * memory.events oom_kill counter went up; an in-cgroup OOM SIGKILLs the
 * task, and the caller otherwise sees only a dead exit code with no why).
 * Keyed by the spawn's ChildProcess; the bash tool appends the note to the
 * tool output. WeakMap: entries die with the child object. */
const memoryKillNotes = new WeakMap<ChildProcess, string>();

/** The OOM note for a finished sandboxed spawn, or null when the cgroup
 * recorded no oom_kill (or the spawn ran without a cgroup). */
export function sysboxMemoryKillNote(child: ChildProcess): string | null {
  return memoryKillNotes.get(child) ?? null;
}

/** Build the OOM note from a cgroup dir's counters, or null when no
 * in-cgroup OOM kill was recorded. MUST run before removeSbxCgroupDir:
 * rmdir destroys memory.events with the directory, and the counters are the
 * only trace of an in-cgroup OOM kill. Reads are plain readFileSync, so a
 * fake dir with ordinary files drives it (cgroup-limits.test.ts). */
export function buildMemoryKillNote(cgroupDir: string): string | null {
  let events: string;
  try {
    events = readFileSync(join(cgroupDir, "memory.events"), "utf8");
  } catch {
    return null; // memory controller absent (or dir gone): nothing to accuse
  }
  const oomKill = parseMemoryEventsOomKill(events);
  if (oomKill === 0) return null;
  let max = "unknown";
  try {
    max = readFileSync(join(cgroupDir, "memory.max"), "utf8").trim(); // byte count or "max"
  } catch { /* not delegated */ }
  const maxText = /^\d+$/.test(max) ? `${max} bytes` : max; // "max"/"unknown" print bare
  return `[sysbox] sandbox memory limit reached: the kernel OOM-killed a task inside the sandbox ` +
    `(cgroup memory.max = ${maxText}, oom_kill = ${oomKill}). ` +
    `The command exceeded the per-spawn memory cap (half host RAM, clamped to [512 MiB, 4 GiB]); ` +
    `see docs/sysbox-sandbox.md "cgroups".`;
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

function buildHelperChild(opts: SandboxSpawnOptions): ChildProcess {
  // cgroup seq is process-wide: every sandboxed spawn, any mode, gets its own limited cgroup when the host allows one.
  const cgroup = detectCapabilities().cgroupAvailable ? createSbxCgroupDir(++cgroupSeq) : null;
  const cfg = JSON.stringify({
    exe: opts.exe ?? "/bin/sh",
    argv: ["sh", "-c", opts.command],
    env: opts.env,
    cwd: opts.cwd,
    deny: Array.from(opts.deny ?? STATIC_DENIED_SYSCALLS.map((d) => d.nr)),
    fence: opts.fence ?? null,
    cgroup,
  });

  // stdio[3] is the config pipe (helper reads it to EOF). The helper process
  // itself gets an empty env: scrubbed vars belong to the SANDBOXED command
  // and travel inside the config, so nothing sensitive is exposed via /proc's
  // environ even before exec.
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [sbHelperPath()], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: {},
      ...OWN_PROCESS_GROUP,
    });
  } catch (e) {
    if (cgroup) removeSbxCgroupDir(cgroup);
    throw e;
  }
  if (cgroup) {
    // The helper joins on its first act, so from exit onward the cgroup is
    // empty unless the command daemonized; removeSbxCgroupDir retries
    // through that and gives up leaving the (still-limiting) cgroup behind.
    // The OOM note must be read BEFORE the rmdir: memory.events dies with
    // the directory (exit fires before any caller-registered handler, so
    // the flag is set by the time a consumer sees "close").
    child.on("exit", () => {
      const note = buildMemoryKillNote(cgroup);
      if (note) memoryKillNotes.set(child, note);
      removeSbxCgroupDir(cgroup);
    });
  }

  const cfgStream = child.stdio[3] as import("node:stream").Writable | null;
  if (!cfgStream) {
    child.kill("SIGKILL");
    if (cgroup) removeSbxCgroupDir(cgroup);
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
  return buildHelperChild(opts);
}
