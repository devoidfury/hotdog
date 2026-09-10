// Runtime capability detection for the sysbox sandbox modes.
//
// Fail-closed philosophy (docs/sysbox-sandbox.md invariant 1): a requested
// sandbox mode that cannot be verified here must produce a startup error in
// the caller, never a silent downgrade to an unsandboxed spawn.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.ts";

export interface SysboxCapabilities {
  /** `static` mode: seccomp deny-filter via the sbx-exec helper. */
  staticAvailable: boolean;
  /** `fence` mode: Landlock ruleset create works here (static implied). */
  landlockAvailable: boolean;
  /** Highest Landlock ABI the kernel reports; 0 when unavailable. */
  landlockAbi: number;
  /** `gate` mode: USER_NOTIF listener install actually works here.
   * Determined by a real probe (actions_avail lies: a container's outer
   * seccomp profile can allow the "user_notif" action yet EPERM the
   * NEW_LISTENER flag). */
  gateAvailable: boolean;
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

  let gateOk = false;
  if (ok) {
    // Cheap pre-check only; the authoritative test is the probe below.
    let hasUserNotif = false;
    try {
      hasUserNotif = readFileSync("/proc/sys/kernel/seccomp/actions_avail", "utf8").includes("user_notif");
    } catch {
      hasUserNotif = false;
    }
    if (!hasUserNotif) {
      reasons.push("kernel seccomp lacks the SECCOMP_RET_USER_NOTIF action");
    } else {
      gateOk = probeGateSupport();
      if (!gateOk) {
        reasons.push('SECCOMP_FILTER_FLAG_NEW_LISTENER blocked here (common under container seccomp profiles)');
      } else {
        // The supervisor imports the notify fd with pidfd_getfd; an outer
        // policy ERRNOing it (nested hotdog's static deny set) makes the
        // gate unbuildable even though the listener installs. The reason
        // comes from the probe's exit code so "policy blocked it" and "the
        // probe broke" stay distinguishable to the user.
        const why = probePidfdImport();
        gateOk = why === null;
        if (why) reasons.push(why);
      }
    }
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

  cached = {
    staticAvailable: ok,
    landlockAvailable: landlockOk,
    landlockAbi,
    gateAvailable: gateOk,
    reasons,
  };
  return cached;
}

// One real attempt, no side effects on this process: the helper installs a
// listener filter trapping nothing and exits 0 (works) / 3 (blocked).
function probeGateSupport(): boolean {
  try {
    const r = spawnSync(process.execPath, [sbHelperPath(), "--probe"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {},
      timeout: 15000,
    });
    if (r.status !== 0) {
      logger.debug(`[sysbox] gate probe: status=${r.status} ${r.stderr?.toString().trim() ?? ""}`);
    }
    return r.status === 0;
  } catch (e) {
    logger.debug(`[sysbox] gate probe failed: ${e}`);
    return false;
  }
}

// pidfd_getfd availability for the notify-fd import: one real parent->child
// round trip inside the helper (--probe-import spawns its own child; the
// relationship must be real -- a self-import proves nothing about ptrace
// access, and an inherited outer deny on 438 only shows up on the real call).
function probePidfdImport(): string | null {
  try {
    const r = spawnSync(process.execPath, [sbHelperPath(), "--probe-import"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {},
      timeout: 15000,
    });
    const detail = r.stderr?.toString().trim() ?? "";
    const reason = importProbeReason(r.status, detail);
    if (reason) logger.debug(`[sysbox] pidfd import probe: status=${r.status} ${detail}`);
    return reason;
  } catch (e) {
    logger.debug(`[sysbox] pidfd import probe failed: ${e}`);
    return importProbeReason(null, String(e));
  }
}

// Pure exit-code -> reason mapping for --probe-import (see that function's
// header for the contract). Both non-zero codes mean "gate is unavailable
// here" -- the difference is only in what the user is TOLD, and a single
// shared code let a missing C compiler or a wedged probe child report itself
// as "your kernel blocks pidfd_getfd", which is a misdiagnosis the user has
// no way to check. status null = killed by the spawnSync timeout.
export function importProbeReason(status: number | null, detail: string): string | null {
  const note = detail ? ` (${detail})` : "";
  if (status === 0) return null;
  if (status === 3) {
    return `pidfd_getfd blocked here (outer seccomp policy, e.g. hotdog-in-hotdog); gate cannot import its notify fd${note}`;
  }
  if (status === 4) {
    return `gate import probe could not run (no compiler, no /proc, or the probe child died); gate availability unverifiable -- NOT a kernel verdict${note}`;
  }
  return `gate import probe exited abnormally (status ${status ?? "timeout"})${note}`;
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
