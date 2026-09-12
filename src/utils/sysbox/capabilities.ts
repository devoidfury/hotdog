// Runtime capability detection for the sysbox sandbox modes.
//
// Fail-closed philosophy (docs/sysbox-sandbox.md invariant 1): a requested
// sandbox mode that cannot be verified here must produce a startup error in
// the caller, never a silent downgrade to an unsandboxed spawn.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatError } from "@core/error.ts";
import { logger } from "../logger.ts";

export interface SysboxCapabilities {
  /** `static` mode: seccomp deny-filter via the sbx-exec helper. */
  staticAvailable: boolean;
  /** `fence` mode: Landlock ruleset create works here (static implied). */
  landlockAvailable: boolean;
  /** Highest Landlock ABI the kernel reports; 0 when unavailable. */
  landlockAbi: number;
  /** cgroup v2 DoS limits (pids.max/memory.max) can be applied to spawns:
   * unified hierarchy AND our own cgroup subtree is writable AND at least
   * one of the pids/memory controllers surfaces there. NOT a mode --
   * absence degrades (warn at spawn), it never refuses a sandbox. Probed
   * by a real mkdir/rmdir under our subtree, not by mounting theory, since
   * delegation (not kernel support) is what usually fails. */
  cgroupAvailable: boolean;
  /** Directory per-spawn cgroups are created under: the deepest ancestor of
   * our own cgroup (self included) whose cgroup.subtree_control exposes
   * pids/memory and that we can mkdir into. Non-null iff cgroupAvailable --
   * on systemd hosts this is NOT our own cgroup (see findCgroupParentDir). */
  cgroupParentDir: string | null;
  /** Which DoS controllers the probe actually found in our subtree.
   * Delegation is per-controller: a pids-only host gets fork containment
   * and nothing else, and each behavior assertion gates on its own
   * controller (cgroup-limits.test.ts). */
  cgroupPidsAvailable: boolean;
  cgroupMemoryAvailable: boolean;
  /** Human-readable reasons for anything unavailable. */
  reasons: string[];
}

let cached: SysboxCapabilities | null = null;

export function detectCapabilities(): SysboxCapabilities {
  if (cached) return cached;
  const reasons: string[] = [];
  let ok = true;

  if (process.platform !== "linux") {
    ok = false;
    reasons.push(`platform is "${process.platform}", sysbox requires linux`);
  }
  if (process.arch !== "x64") {
    ok = false;
    reasons.push(`arch is "${process.arch}", the deny table pins x86_64 syscall numbers`);
  }

  // /proc/sys/kernel/seccomp/actions_avail lists the filter actions the
  // kernel was built with. A kernel without CONFIG_SECCOMP_FILTER has no
  // "errno" action; a missing procfs entry cannot be verified, so treat it
  // as unavailable (fail closed).
  if (ok) {
    const ACTIONS = "/proc/sys/kernel/seccomp/actions_avail";
    if (!existsSync(ACTIONS)) {
      ok = false;
      reasons.push(`${ACTIONS} not readable; seccomp filter support unverifiable`);
    } else {
      let actions = "";
      try {
        actions = readFileSync(ACTIONS, "utf8");
      } catch {
        actions = "";
      }
      if (!actions.includes("errno")) {
        ok = false;
        reasons.push("kernel seccomp lacks the SECCOMP_RET_ERRNO action");
      }
    }
  }

  // The helper is shipped source; a broken install should fail here rather
  // than per-spawn.
  if (ok && !existsSync(sbHelperPath())) {
    ok = false;
    reasons.push(`sbx-exec helper not found at ${sbHelperPath()}`);
  }

  // Landlock: probed in the helper child (keeps this process cc()-free).
  // The probe itself is side-effect-free (ABI query + ruleset create), but
  // probing costs a bun spawn either way; reasons only carry the generic
  // explanation (the ABI number and -errno land in the debug log).
  let landlockOk = false;
  let landlockAbi = 0;
  if (ok) {
    const abi = probeLandlockAbi();
    if (abi > 0) {
      landlockOk = true;
      landlockAbi = abi;
    } else {
      reasons.push("landlock unavailable (kernel without landlock, disabled at boot, or blocked by container policy)");
    }
  }

  // cgroup v2 DoS limits: resolve a hosting dir, then probe it with a real
  // mkdir/rmdir (no cc(), no helper spawn -- nothing here needs the kernel-
  // install tricks the other probes use). Deliberately NOT added to
  // `reasons`: no sandbox mode depends on it; absence means spawns run
  // without DoS limits (warn at spawn time).
  const cgParent = ok ? resolveCgroupParentDir() : null;
  const cg = cgParent !== null ? probeCgroupLimits(cgParent) : { pids: false, memory: false };

  cached = {
    staticAvailable: ok,
    landlockAvailable: landlockOk,
    landlockAbi,
    cgroupAvailable: cg.pids || cg.memory,
    cgroupParentDir: cg.pids || cg.memory ? cgParent : null,
    cgroupPidsAvailable: cg.pids,
    cgroupMemoryAvailable: cg.memory,
    reasons,
  };
  return cached;
}

const CGROUP_MOUNT = "/sys/fs/cgroup";

/** Does a cgroup created under `dir` surface DoS limit files? Its
 * cgroup.subtree_control must list pids or memory (token-exact: the
 * controller files mirror what the parent enabled). ENOENT/unreadable
 * counts as "no" (non-v2 dir, no delegation). */
function subtreeHasDosController(dir: string): boolean {
  let text = "";
  try {
    text = readFileSync(join(dir, "cgroup.subtree_control"), "utf8");
  } catch {
    return false;
  }
  const tokens = text.split(/\s+/);
  return tokens.includes("pids") || tokens.includes("memory");
}

// mkdir(2) needs write+search on the parent; both via one access(2).
function canMkdirHere(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pick where hotdog-sbx children live: the deepest ancestor of our own
 * cgroup (`rel`, the "0::" path from /proc/self/cgroup) that both exposes
 * pids/memory to children and is writable by us. Pure over `usable` so the
 * walk is pinned without cgroupfs.
 *
 * Why walk up at all: on systemd hosts our own cgroup is a leaf SCOPE with
 * member processes, and the kernel's "no internal processes" rule forbids
 * enabling controllers on a cgroup that has members -- its subtree_control
 * is permanently empty, so children created there get only *.pressure files
 * and no pids.max/memory.max. Probing only our own cgroup therefore reports
 * "unavailable" on every systemd host (measured); the nearest usable
 * ancestor (e.g. user@1000.service) is where limited children can live. */
export function findCgroupParentDir(
  rel: string,
  usable: (abs: string) => boolean,
): string | null {
  // rel "/" must land ON the mount: join would emit a trailing slash, and
  // dirname("/sys/fs/cgroup/") eats the mount component itself (POSIX).
  let dir = rel === "/" ? CGROUP_MOUNT : join(CGROUP_MOUNT, rel);
  while (dir === CGROUP_MOUNT || dir.startsWith(`${CGROUP_MOUNT}/`)) {
    if (usable(dir)) return dir;
    dir = dirname(dir);
  }
  return null;
}

// Our own cgroup from /proc/self/cgroup, then walk up for a host. Null when
// the walk finds nothing usable or we cannot even locate our own cgroup.
function resolveCgroupParentDir(): string | null {
  try {
    const rel = parseUnifiedCgroup(readFileSync("/proc/self/cgroup", "utf8"));
    if (rel === null) {
      logger.debug("[sysbox] cgroup probe: no unified (0::) entry in /proc/self/cgroup");
      return null;
    }
    const dir = findCgroupParentDir(rel, (abs) => subtreeHasDosController(abs) && canMkdirHere(abs));
    if (dir === null) {
      logger.debug("[sysbox] cgroup probe: no writable ancestor subtree exposes pids/memory controllers");
    }
    return dir;
  } catch (e) {
    logger.debug(`[sysbox] cgroup probe failed: ${formatError(e)}`);
    return null;
  }
}

/** Parse /proc/self/cgroup; returns the path of the unified (v2) hierarchy
 * entry ("0::/foo"), or null (v1 hybrid without a 0:: line, unreadable
 * garbage). Exported for tests; the fs read lives in the callers. */
export function parseUnifiedCgroup(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const p = line.slice(3).trim();
    if (p.startsWith("/")) return p;
  }
  return null;
}

/** MemTotal in kB from /proc/meminfo text; null when absent. */
export function parseMemTotalKb(text: string): number | null {
  const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
  if (!m) return null;
  const kb = Number.parseInt(m[1]!, 10);
  return Number.isFinite(kb) && kb > 0 ? kb : null;
}

/** memory.max for a sandbox cgroup: half the host's RAM, clamped. Unknown
 * MemTotal falls to the floor (a bounded small sandbox beats an unbounded
 * one on a machine we cannot size). */
export function cgroupMemoryCapBytes(memTotalKb: number | null): number {
  const MIN = 512 * 1024 * 1024;
  const MAX = 4 * 1024 * 1024 * 1024;
  if (memTotalKb === null) return MIN;
  return Math.min(MAX, Math.max(MIN, Math.floor(memTotalKb * 1024 / 2)));
}

/** The oom_kill counter from memory.events text ("oom_kill 2"); 0 when the
 * line is absent or unparseable (no memory controller, garbage read ->
 * nothing to report, never a false OOM accusation). */
export function parseMemoryEventsOomKill(text: string): number {
  const m = /^oom_kill\s+(\d+)\s*$/m.exec(text);
  if (!m) return 0;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Real probe: create + remove a test cgroup under the hosting dir resolved
// by resolveCgroupParentDir and check which DoS controllers surface in it.
// Every failure class (quota/depth EAGAIN at that ancestor, a race with
// systemd reclaiming the dir) lands in the catch or the flag check. The
// controller files only appear when the controller is actually enabled in
// the parent's subtree, so existsSync is the delegation answer, per
// controller.
function probeCgroupLimits(parent: string): { pids: boolean; memory: boolean } {
  const none = { pids: false, memory: false };
  const dir = join(parent, `hotdog-sbx-probe-${process.pid}`);
  try {
    mkdirSync(dir);
    try {
      const pids = existsSync(join(dir, "pids.max"));
      const memory = existsSync(join(dir, "memory.max"));
      if (!pids && !memory) {
        logger.debug(`[sysbox] cgroup probe: ${dir} has no pids/memory controller (not delegated)`);
      }
      return { pids, memory };
    } finally {
      // rmdirSync, not rmSync (see index.ts removeSbxCgroupDir).
      try { rmdirSync(dir); } catch { /* best effort */ }
    }
  } catch (e) {
    logger.debug(`[sysbox] cgroup probe failed: ${formatError(e)}`);
    return none;
  }
}

// Helper prints the Landlock ABI on stdout and exits 0; exit 3 = no
// landlock. Returns the ABI (>0) or 0.
function probeLandlockAbi(): number {
  try {
    const r = spawnSync(process.execPath, [sbHelperPath(), "--probe-fence"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
      timeout: 15000,
    });
    if (r.status !== 0) {
      logger.debug(`[sysbox] landlock probe: status=${r.status} ${r.stderr?.toString().trim() ?? ""}`);
      return 0;
    }
    const abi = Number.parseInt(r.stdout?.toString().trim() ?? "", 10);
    return Number.isInteger(abi) && abi > 0 ? abi : 0;
  } catch (e) {
    logger.debug(`[sysbox] landlock probe failed: ${e}`);
    return 0;
  }
}

/** Net rights the fence handles, mirroring launcher.c `ll_net_rights` (the
 * `#define LL_NET_<name>` lines are pinned against this table by
 * capabilities.test.ts, same drift-pin style as the seccomp deny table).
 * Handled with ZERO allow rules, so every one of these actions is EACCES
 * inside a fence spawn on a kernel whose ABI reaches the threshold.
 *
 * Bit NUMBERS, by contrast, are pinned by behavior (fence-integration.test.ts
 * probes bind/connect/sendto on a real fenced spawn): the dev host's ABI-10
 * kernel turned out to put the UDP pair at bits 2/3 where the plan guessed
 * 8/9, and a wrong bit EINVALs the ruleset -- which is a refused spawn, not a
 * silent hole. Scope rights (ABI v6: abstract unix sockets, signals) are
 * deliberately NOT handled; see launcher.c for why. */
export const LANDLOCK_NET_RIGHTS: readonly { name: string; bit: number; abi: number }[] = [
  { name: "BIND_TCP", bit: 0, abi: 4 },
  { name: "CONNECT_TCP", bit: 1, abi: 4 },
  { name: "BIND_UDP", bit: 2, abi: 10 },
  { name: "CONNECT_SEND_UDP", bit: 3, abi: 10 },
];

/** What the fence promises about network on a kernel of this Landlock ABI,
 * for `hotdog info`. "net: unhandled" below ABI 4 is said out loud rather
 * than left implied -- fence's egress claim is kernel-version dependent. */
export function landlockNetPosture(abi: number): string {
  const has = (name: string): boolean =>
    LANDLOCK_NET_RIGHTS.some((r) => r.name === name && abi >= r.abi);
  if (!has("BIND_TCP")) return "net: unhandled";
  return has("BIND_UDP")
    ? "net: tcp bind+connect denied +udp"
    : "net: tcp bind+connect denied";
}

/** Reset for tests only. */
export function resetCapabilitiesForTesting(): void {
  cached = null;
}

export function sbHelperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "sbx-exec.ts");
}

export function launcherCPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "launcher.c");
}
