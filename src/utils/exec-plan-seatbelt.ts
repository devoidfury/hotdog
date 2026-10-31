// macOS seatbelt (sandbox-exec) jail plan for the tool exec plane.
//
// Same probe-and-degrade contract as the bwrap path (see exec-plan.ts): the
// profile is handed out only when a two-leg probe proves sandbox-exec
// actually mediates on this host; otherwise the plane spawns plain and the
// posture line reports the fence absent. A security posture must never fail
// open silently.
//
// Ground truth from the owner's macOS host (verified 2026-10-31):
// - mediation is LIVE: `(deny default)` alone blocked execvp with "Operation
//   not permitted", so process-exec* must be granted up front or every
//   spawn dies before the rest of the profile matters.
// - .local (mDNS/Bonjour) name resolution HANGS without the
//   com.apple.dnssd.service mach-lookup allow.
//
// The honest weaker sibling of bwrap: no PID/IPC/UTS namespaces (host pids
// and sysctl process info stay visible; we deny process-signal so jailed
// code cannot KILL host processes, but process-info secrecy is not
// isolation), and sandbox-exec itself is a deprecated Apple shim whose
// disappearance means loud unfenced, never silent. SECURITY.md carries the
// full guarantee diff.

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlanePlanResult } from "./exec-plan.ts";

/** Apple fixes the shim's location; it is not a PATH tool, so no PATH search. */
const SEATBELT_BIN = "/usr/bin/sandbox-exec";

/**
 * Mach services the runner and its libc need under deny-default: logging
 * (logd, system.logger), the notification center plus its shared memory,
 * .local resolution (dnssd -- without it Bonjour lookups hang, the one
 * finding that no amount of reading the profile predicts), LaunchServices
 * and preferences (lsd, cfprefsd), and TCC decisions (tccd).
 */
const MACH_ALLOW = [
  "com.apple.logd",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.dnssd.service",
  "com.apple.lsd.mapdb",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.tccd",
  "com.apple.tccd.system",
];
const SHM_ALLOW = ["apple.shm.notification_center"];

/**
 * Read-only system allowlist. /private/etc (not /etc): seatbelt matches
 * RESOLVED paths and /etc is a symlink. /Library/Frameworks and
 * /System cover the OS dylibs a bun process maps.
 */
const RO_DIRS = [
  "/usr",
  "/bin",
  "/sbin",
  "/usr/lib",
  "/usr/share",
  "/System",
  "/Library/Frameworks",
  "/private/etc",
  "/dev",
];

/** The token the probe's positive leg must read back; see probeSeatbelt. */
const PROBE_TOKEN = "hotdog-seatbelt-probe-ok";

/**
 * Resolved sandbox-exec path if the system shim is there; null otherwise.
 * Absolute-only on purpose: a PATH-resolved "sandbox-exec" is by definition
 * not Apple's shim and cannot be trusted to mediate anything.
 */
export function seatbeltBinary(): string | null {
  try {
    return existsSync(SEATBELT_BIN) && statSync(SEATBELT_BIN).isFile() ? SEATBELT_BIN : null;
  } catch {
    // vanished between check and stat, or not readable: same answer.
    return null;
  }
}

let cachedSeatbelt: string | null | undefined;

/**
 * Resolved sandbox-exec path iff BOTH probe legs behave; null otherwise.
 * Cached exactly like bwrapBinary (force re-runs and re-seeds).
 */
export function probeSeatbelt(force = false): string | null {
  // Platform guard FIRST: a linux host must not spawn sandbox-exec even to
  // ask. On darwin the cached probe is the only gate planFor() consults.
  if (process.platform !== "darwin") return null;
  if (cachedSeatbelt !== undefined && !force) return cachedSeatbelt;
  cachedSeatbelt = runSeatbeltProbe();
  return cachedSeatbelt;
}

/**
 * Two legs against a probe file this function creates and removes:
 * - positive: cat the file under a minimal allow profile -- must exit 0
 *   AND echo the token back.
 * - negative: the same profile plus an explicit (deny file-read-data) of
 *   that exact file -- must exit non-zero.
 * One leg alone cannot distinguish mediation-off from command-failed: a
 * positive-only pass is exactly what an inert (unmediated) sandbox-exec
 * also produces, and a negative-only failure is exactly what a broken
 * spawn produces. Only the pair proves the profile's denies actually bite.
 * Any mismatch is probe-fail: the plane runs pooled-but-unfenced and
 * REPORTS it (same semantics as probeBwrap).
 */
function runSeatbeltProbe(): string | null {
  const bin = seatbeltBinary();
  if (!bin) return null;
  const base = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec* process-fork file-map-executable sysctl-read)",
    `(allow file-read-metadata (literal ${seatbeltPath("/")}))`,
    `(allow file-read-data file-read-metadata${
      ["/usr", "/bin", "/System", "/private/etc"].map((p) => ` (subpath ${seatbeltPath(p)})`).join("")})`,
  ].join("\n");
  let dir: string;
  let probeFile: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "hotdog-seatbelt-probe-"));
    probeFile = join(dir, "probe.txt");
    writeFileSync(probeFile, PROBE_TOKEN);
  } catch {
    // No temp dir means the probe cannot test anything: degrade like a
    // failed leg. The posture line is the reporting surface.
    return null;
  }
  try {
    const allow = `${base}\n(allow file-read-data (literal ${seatbeltPath(probeFile)}))`;
    const pos = Bun.spawnSync([bin, "-p", allow, "/bin/cat", probeFile]);
    if (pos.exitCode !== 0 || !pos.stdout.toString().includes(PROBE_TOKEN)) return null;
    const deny = `${allow}\n(deny file-read-data (literal ${seatbeltPath(probeFile)}))`;
    const neg = Bun.spawnSync([bin, "-p", deny, "/bin/cat", probeFile]);
    if (neg.exitCode === 0) return null;
    return bin;
  } catch {
    // spawn threw (shim vanished mid-probe): probe-fail, loud unfenced.
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort; tmp policy owns the rest.
    }
  }
}

/**
 * Interpolate a host path into the profile. THE ESCAPING IS A SECURITY
 * BOUNDARY: roots are config-authored and the profile is source code fed to
 * seatbelt's parser, so every path goes through here -- backslash and
 * double-quote escaped inside a quoted string, or a root name like
 * `x")(allow file-write* (subpath "/` would close the string and add rules.
 * Newline/CR/NUL cannot be quoted safely (a newline is token whitespace to
 * the parser regardless), so those paths throw; the memoized planner
 * surfaces it like any plan failure.
 */
function seatbeltPath(p: string): string {
  if (/[\n\r\0]/.test(p)) {
    throw new Error(`seatbelt plan: path contains a control character (newline/CR/NUL), refusing: ${JSON.stringify(p)}`);
  }
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * realpathSync + skip-nonexistent + exact dedup, order preserved. macOS
 * symlinks /tmp to /private/tmp and seatbelt matches RESOLVED paths, so an
 * unresolvable (or missing) path is skipped exactly where bwrap would skip
 * a missing bind source -- and a symlinked one is allowed under its true
 * name, which is what the kernel checks.
 */
function realPaths(paths: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    let real: string;
    try {
      real = realpathSync(p); // throws on missing: skipping IS the rule
    } catch {
      continue;
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * The full SBPL profile for one plan. Sorted rw emission keeps the string
 * deterministic for a fixed input set (the fence id hashes it).
 */
export function seatbeltProfile(opts: {
  roots: string[];
  scratch: string;
  execPath: string;
  repoRoot: string;
}): string {
  const ro = realPaths([...RO_DIRS, dirname(opts.execPath), opts.repoRoot]);
  const rw = realPaths([...opts.roots, opts.scratch]).sort();
  const lines = [
    "(version 1)",
    "(deny default)",
    // Owner rulings distilled from the reference session: exec/fork up
    // front (mediation blocks execvp under deny default), metadata on
    // literal "/" for path traversal...
    "(allow process-exec* process-fork file-map-executable sysctl-read)",
    `(allow file-read-metadata (literal ${seatbeltPath("/")}))`,
    // ...and NO blanket signal: the reference profile allowed it, we emit
    // the deny explicitly instead, stated after the baseline so the
    // operation class it protects is visible in the profile itself.
    "(deny process-signal)",
    `(allow mach-lookup${MACH_ALLOW.map((n) => ` (global-name ${seatbeltPath(n)})`).join("")})`,
    `(allow ipc-posix-shm-read-data${SHM_ALLOW.map((n) => ` (ipc-posix-name ${seatbeltPath(n)})`).join("")})`,
    // ro like the bwrap plan: system dirs, the interpreter's dir, and the
    // repo (the pooled runner imports it).
    `(allow file-read-data file-read-metadata${ro.map((p) => ` (subpath ${seatbeltPath(p)})`).join("")})`,
  ];
  // rw ONLY the session roots + scratch (last-match-wins lets an rw root
  // nested under a ro subpath keep its writes). Guarded: a filterless
  // (allow file-read* file-write*) would be the whole filesystem.
  if (rw.length > 0) {
    lines.push(`(allow file-read* file-write*${rw.map((p) => ` (subpath ${seatbeltPath(p)})`).join("")})`);
  }
  // Parity with bwrap sharing network (classes rw and net plan identically,
  // same as today; a future no-net class drops this line).
  lines.push("(allow network-outbound network-inbound)");
  return lines.join("\n");
}

/**
 * Pure plan generation (same opts shape as planFor): probe gating lives in
 * planFor's darwin branch so this stays unit-testable on any host. `cls` is
 * carried for contract parity -- rw and net produce the same profile.
 *
 * The env sandwich lives in the argv because sandbox-exec has no --setenv:
 * /usr/bin/env sets HOME/TMPDIR and execs the command under the SAME
 * profile. Unlike the bwrap plan -- whose HOME/TMPDIR point at the jail's
 * /tmp bind -- seatbelt has no mount table, so they point at the REAL host
 * scratch dir. sandbox-exec takes its command directly: no "--" separator.
 */
export function seatbeltPlan(opts: {
  roots: string[];
  cls: string;
  scratch: string;
  command: string;
  args: string[];
  execPath?: string;
  repoRoot?: string;
}): PlanePlanResult {
  const scratchReal = (() => {
    try {
      return realpathSync(opts.scratch);
    } catch {
      // The planner contract says scratch exists; if it somehow does not,
      // HOME/TMPDIR still point at the requested dir (unresolvable paths
      // never enter the profile's allowlist).
      return opts.scratch;
    }
  })();
  const profile = seatbeltProfile({
    roots: opts.roots,
    scratch: opts.scratch,
    execPath: opts.execPath ?? process.execPath,
    repoRoot: opts.repoRoot ?? process.cwd(),
  });
  return {
    prefixArgv: [
      SEATBELT_BIN,
      "-p",
      profile,
      "/usr/bin/env",
      `HOME=${scratchReal}`,
      `TMPDIR=${scratchReal}`,
      opts.command,
      ...opts.args,
    ],
    probe: "seatbelt",
  };
}
