// Jail plans for spawned processes ("the fence is argv").
//
// Two consumers share one probe-and-degrade contract:
//
// - The tool exec plane (supervisor side): `planFor()` builds the bwrap prefix
//   that wraps a pooled executor -- tmpfs root, ro system dirs, rw ONLY the
//   session's workspace roots plus a scratch dir, no $HOME, no config chain,
//   no sibling session roots. The broker prepends it verbatim at spawn.
// - The evals harness (`evals/run.ts`): `bwrapArgv()` + `baseRoBinds()` +
//   `hiddenRepoPaths()` for grading runs, where the harness may read the
//   config chain by design (so those dirs cannot be hidden from its jail).
//
// Contract everywhere: if bwrap exists AND a real minimal-sandbox probe
// succeeds, spawns get the allowlisted filesystem; otherwise the caller
// spawns plain and REPORTS the fence as absent. A security posture must
// never fail open silently.
//
// Caveats (unchanged from the eval original): Nix-style layouts (everything
// under /nix/store) are not supported by the allowlist; the probe failing
// there means those hosts run unfenced, flagged. The `rw`/`net` classes share
// the network by design; the hard net-block tier is `NO_EGRESS_CLASS` below,
// which adds `--unshare-net` and REFUSES to spawn when no jail is available
// (that class never takes the degrade path -- no jail means no child).
//
// The shape is deliberately backend-agnostic: a future seatbelt (macOS) or
// container backend implements the same plan/probe surface.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { JAIL_EGRESS_SOCKET } from "./spawn-env.ts";

const SYS_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
// Curated /etc: DNS + TLS + name resolution + locale + shell startup, so
// bash/bun/HTTPS work. Deliberately NOT all of /etc.
const ETC_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/ld.so.cache",
  "/etc/localtime",
  "/etc/os-release",
  "/etc/services",
  "/etc/profile",
  "/etc/bash.bashrc",
  "/etc/ssl",
  "/etc/ca-certificates.conf",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/hotdog",
];

export interface BwrapPlan {
  roBinds: string[];
  /** Fresh tmpfs mounted over these paths (hides what a ro-bind exposed). */
  hidden: string[];
  /** Re-bound after `hidden` (e.g. one file under a hidden results dir). */
  roBindsAfterHidden: string[];
  rwBinds: string[];
  /** Raw host->jail rw binds where source and destination differ (scratch -> /tmp). */
  binds?: Array<[string, string]>;
}

export function bwrapArgv(opts: {
  binary?: string;
  command: string;
  args: string[];
  plan: BwrapPlan;
  /** Env set INSIDE the jail via --setenv (jails have no inherited $HOME by design). */
  setEnv?: Record<string, string>;
  /** Hard net-block tier: kernel-enforced no egress (see NO_EGRESS_CLASS). */
  noEgress?: boolean;
}): string[] {
  const pre = [
    opts.binary ?? "bwrap",
    "--die-with-parent", // no orphans if the spawner dies
    "--new-session",     // detach from the controlling terminal (TIOCSTI guard)
    // Process isolation is opt-in in bwrap, so say it explicitly: sharing
    // the host PID namespace would let jailed code read /proc/<pid>/* and
    // SIGKILL the supervisor, the broker, and sibling sessions (same uid).
    // With a private pidns, the jail's /proc (mounted last) shows only the
    // jail's own processes, host-uid signaling dies with the namespace, and
    // even setsid'd grandchildren are reaped when the pidns init exits.
    "--unshare-pid",
    // IPC and UTS likewise: no System V shm/message queues and no host
    // hostname leaking through the default namespaces.
    "--unshare-ipc",
    "--unshare-uts",
    // The hard tier's whole point: a fresh empty netns has no routes at all
    // (not even loopback), so the child cannot dial out or reach local
    // services -- the kernel-enforced layer the cooperative proxy is not.
    ...(opts.noEgress ? ["--unshare-net"] : []),
    "--tmpfs", "/",
  ];
  if (opts.setEnv) {
    for (const [k, v] of Object.entries(opts.setEnv)) pre.push("--setenv", k, v);
  }
  const binds = (flag: string, paths: string[]): void => {
    for (const p of paths) pre.push(flag, p, p);
  };
  binds("--ro-bind", opts.plan.roBinds);
  // First hidden pass BEFORE the rw binds: a hidden dir is also the mount
  // point for post-hidden rw binds (the eval session dir lives under the
  // hidden results dir, and the repo is ro -- bwrap cannot mkdir under it).
  for (const p of opts.plan.hidden) pre.push("--tmpfs", p);
  binds("--ro-bind", opts.plan.roBindsAfterHidden);
  binds("--bind", opts.plan.rwBinds);
  if (opts.plan.binds) {
    for (const [src, dst] of opts.plan.binds) pre.push("--bind", src, dst);
  }
  // Mount order is precedence: an rw bind mounted after a hidden tmpfs
  // re-exposes it when the bind source is an ANCESTOR of the hidden path
  // (workspace "." == the repo itself resurrects `.git`). Re-assert the
  // tmpfs over those -- but only where no rw bind lives UNDER the hidden
  // path (that bind must keep winning, which is the eval session-dir case).
  for (const p of opts.plan.hidden) {
    if (opts.plan.rwBinds.some((r) => r === p || r.startsWith(`${p}/`))) continue;
    pre.push("--tmpfs", p);
  }
  // /dev and /proc are jail-owned virtual fs, mounted LAST. An rw bind of
  // "/" (legal workspace config: paths: [".", "/"]) is a recursive bind that
  // shadows everything mounted under it earlier -- including the jail's /proc
  // -- and Bun aborts at startup inside the mangled view (bun.report
  // la1744846fgGgkggC041rBAa). Re-mounting after every bind guarantees a
  // fresh /dev and /proc whatever the allowlist drags in -- and because the
  // mount stays after every bind, the --unshare-pid above holds: the /proc
  // the jail sees is the NEW namespace's, not a host copy dragged in rw.
  pre.push("--dev", "/dev", "--proc", "/proc");
  pre.push("--", opts.command, ...opts.args);
  return pre;
}

/** Base read-only allowlist: system dirs, curated /etc, config chain, interpreter, repo. */
export function baseRoBinds(opts: {
  execPath: string;
  repoRoot: string;
  home?: string;
  /**
   * Include the hotdog config chain (/etc/hotdog, ~/.config/hotdog). True for
   * the eval harness (the sandboxed harness reads its own config by design);
   * the tool plane passes false -- tool-executed code must not mount the
   * files that may carry provider credentials.
   */
  configChain?: boolean;
}): string[] {
  const configChain = opts.configChain !== false;
  const candidates = [
    ...SYS_DIRS,
    ...(configChain ? ETC_FILES : ETC_FILES.filter((p) => p !== "/etc/hotdog")),
    dirname(opts.execPath),
    opts.repoRoot,
  ];
  if (opts.home && configChain) candidates.push(join(opts.home, ".config", "hotdog"));
  const seen = new Set<string>();
  for (const p of candidates) {
    if (p && existsSync(p)) seen.add(p);
  }
  return [...seen];
}

/** Repo paths that must be invisible to a sandboxed agent (git history, task definitions, sibling run data). */
export function hiddenRepoPaths(repoRoot: string): string[] {
  // bwrap cannot mkdir a mount point under a ro-bound repo, so only hide what exists.
  // .git: the agent runs in its own workspace and never needs the harness repo's history.
  return [join(repoRoot, ".git"), join(repoRoot, "evals", "series"), join(repoRoot, "evals", "results")].filter((p) => existsSync(p));
}

// ── Plane plan ────────────────────────────────

/**
 * The hard net-block class name for `planFor({ cls })`: planned with
 * `--unshare-net`, and when no jail exists the plan REFUSES (see
 * `PlanePlanResult.refusal`) instead of degrading to a plain spawn. The
 * plane's wire ExecClass adopts this value when a producer wires the tier;
 * until then exec-plan is the only place the class means anything.
 */
export const NO_EGRESS_CLASS = "no-egress";

/** The refusal every no-egress spawner must surface when the jail is gone. */
export function noEgressRefusal(): string {
  return (
    "Spawn refused: the hard net-block tier needs a working bwrap jail with --unshare-net, " +
    "and this host has none (no binary, or the sandbox probe failed). " +
    "Children are not spawned outside it; execFence \"off\" or the proxy policy are the opt-outs."
  );
}

/** The refusal the hard-egress tier (fetchPolicy.hardEgress) surfaces when the shim cannot run. */
export function hardEgressRefusal(): string {
  return (
    "Spawn refused: fetchPolicy.hardEgress requires the netns shim (unprivileged user + network " +
    "namespaces) and the bwrap jail, and this host cannot provide them (userns disabled/restricted, " +
    "or the sandbox probe failed). Children are not started outside the jail; " +
    "set fetchPolicy.hardEgress to false to opt out."
  );
}

let cachedHardEgress: string | null | undefined;

/**
 * Does the netns shim actually work here (userns + maps + netns + lo)?
 * One probe per process; the shim runs its full setup chain, so probe and
 * spawn agree on what the platform offers.
 */
export function hardEgressProbe(shimPath: string, force = false): string | null {
  if (cachedHardEgress !== undefined && !force) return cachedHardEgress;
  try {
    const r = Bun.spawnSync([process.execPath, shimPath, "--probe"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    cachedHardEgress = r.exitCode === 0 ? shimPath : null;
  } catch {
    cachedHardEgress = null;
  }
  return cachedHardEgress;
}

export interface PlanePlanResult {
  /** Full spawn argv (bwrap ... -- command args), or null when the fence is unavailable. */
  prefixArgv: string[] | null;
  /** Backend the probe allowed, mirrored into the status line; null = plain spawn. */
  probe: "bwrap" | null;
  /**
   * Non-null when a class that MUST be fenced got no jail: the caller must
   * NOT spawn (and must not retry unfenced). Null on every degrade path a
   * soft class may take.
   */
  refusal: string | null;
}

/**
 * The per-(session, class) plan for a pooled executor: rw ONLY the session's
 * roots plus `scratch` (mounted as /tmp, so temp files survive across calls
 * inside one entry but nowhere else); no $HOME, no config chain, no sibling
 * session roots; the repo is ro (the runner imports it).
 *
 * `.git` is deliberately NOT hidden here: tool-executed git commands (and
 * `project_info` shelling out to git) need status/history/commits. A session
 * whose roots include the repo gets `.git` writable via the rw bind (it wins
 * over the ro bind by mount order); everywhere else the repo's `.git` stays
 * ro. The evals harness keeps hiding git history via `hiddenRepoPaths()`.
 *
 * `cls` is the capability class: `rw`/`net` plan identically (bwrap shares
 * network by default) while `NO_EGRESS_CLASS` plans with `--unshare-net` and
 * returns a refusal instead of a plain-spawn null when no jail exists --
 * the hard tier never degrades. `scratch` must exist host-side -- bwrap bind
 * sources must be real directories (the caller creates it).
 */
export function planFor(opts: {
  roots: string[];
  cls: string;
  scratch: string;
  command: string;
  args: string[];
  execPath?: string;
  repoRoot?: string;
  /** Override the bwrap binary (undefined = probe, null = force plain spawn). */
  binary?: string | null;
  /**
   * Hard egress tier (fetchPolicy.hardEgress): the prefix is wrapped in the
   * netns shim (private user+net namespace, loopback raised), the policy
   * proxy's unix socket is bind-mounted at JAIL_EGRESS_SOCKET, and the jail
   * gets NO --unshare-net -- the netns is the shim's, and raising a second
   * one would throw away the loopback the bridge listens on. The shim probe
   * gates availability; a missing shim refuses (never plain spawn).
   */
  egress?: { socketPath: string; shim: string };
}): PlanePlanResult {
  const noEgress = opts.cls === NO_EGRESS_CLASS;
  if (opts.egress && opts.binary === null) {
    // Forced plain spawn is never a hard-egress spawn.
    return { prefixArgv: null, probe: null, refusal: hardEgressRefusal() };
  }
  const binary =
    opts.binary === undefined ? (noEgress ? noEgressBinary() : bwrapBinary()) : opts.binary;
  if (!binary) {
    // Soft classes degrade to a plain spawn (flagged posture); the hard tier
    // refuses: a net-block child spawned unfenced is the exact hole the
    // tier exists to close.
    return {
      prefixArgv: null,
      probe: null,
      refusal: noEgress || opts.egress ? (opts.egress ? hardEgressRefusal() : noEgressRefusal()) : null,
    };
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const plan: BwrapPlan = {
    roBinds: baseRoBinds({
      execPath: opts.execPath ?? process.execPath,
      repoRoot,
      configChain: false,
    }),
    // No hidden paths: see the doc comment -- `.git` must stay reachable for git tooling.
    hidden: [],
    roBindsAfterHidden: [],
    rwBinds: opts.roots.filter((p) => existsSync(p)),
    binds: [[opts.scratch, "/tmp"]],
  };
  if (opts.egress) {
    // The policy proxy socket rides into the jail as a plain file bind; the
    // runner's egress bridge is the only thing allowed to connect to it, and
    // the only thing the child can reach at all.
    plan.binds!.push([opts.egress.socketPath, JAIL_EGRESS_SOCKET]);
  }
  // The jail has no home; point HOME/TMPDIR at the per-entry scratch bind.
  const inner = bwrapArgv({
    binary,
    command: opts.command,
    args: opts.args,
    plan,
    setEnv: { HOME: "/tmp", TMPDIR: "/tmp" },
    // noEgress only for the pure deny class: under the shim the netns is
    // already private (with loopback), and --unshare-net would replace it.
    noEgress: noEgress && !opts.egress,
  });
  const prefixArgv = opts.egress
    ? [process.execPath, opts.egress.shim, "--", ...inner]
    : inner;
  return { prefixArgv, probe: "bwrap", refusal: null };
}

// ── Probe (shared by both consumers) ─────────────────────────────────────────

// Bun snapshots $PATH at startup, so resolve the binary ourselves rather than
// relying on spawn lookup.
export function findBwrap(): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "bwrap");
    try {
      const st = statSync(candidate);
      // Directories pass a bare mode-bit check (755 & 0o111); a stray "bwrap"
      // dir on PATH would shadow the real binary and fail the probe.
      if (st.isFile() && st.mode & 0o111) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

let cachedBinary: string | null | undefined;
let cachedNoEgress: string | null | undefined;

/** Resolved bwrap path if it exists and a trivial sandbox actually runs; null otherwise. Cached. */
export function bwrapBinary(force = false): string | null {
  if (cachedBinary !== undefined && !force) return cachedBinary;
  cachedBinary = probeBwrap();
  return cachedBinary;
}

/**
 * Like `bwrapBinary` but for the hard net-block tier: the probe additionally
 * requires `--unshare-net` to work, so a host whose policy allows pidns but
 * forbids new network namespaces reports unavailable here (and the tier
 * refuses to spawn) rather than shipping a "net-block" jail that shares the
 * network. Implies the base probe (same flags, a superset). Cached.
 */
export function noEgressBinary(force = false): string | null {
  if (cachedNoEgress !== undefined && !force) return cachedNoEgress;
  cachedNoEgress = probeBwrap(["--unshare-net"]);
  return cachedNoEgress;
}

export function bwrapAvailable(force = false): boolean {
  return bwrapBinary(force) !== null;
}

/** Status-line backend label for a probed fence: "bwrap" when the probe passes. */
export function execFenceBackend(force = false): "bwrap" | null {
  return bwrapBinary(force) ? "bwrap" : null;
}

/** Status-line backend label for the hard net-block tier. */
export function netBlockBackend(force = false): "bwrap" | null {
  return noEgressBinary(force) ? "bwrap" : null;
}

function probeBwrap(extraFlags: readonly string[] = []): string | null {
  const bin = findBwrap();
  if (!bin) return null;
  // Probe the real recipe's core: a fresh tmpfs root must mount and a
  // trivially small allowlist must let a known binary exec. The command
  // must be an absolute path (PATH dirs don't exist under the new root),
  // and its dynamic loader dirs must be bound (execve of a dynamic ELF
  // returns ENOENT when the loader is missing -- a bare `-- true` probe
  // can never pass and always reported sandbox OFF).
  const roBinds = ["/usr", "/bin", "/lib", "/lib64"].filter((p) => existsSync(p));
  for (const cmd of ["/usr/bin/true", "/bin/true"]) {
    if (!existsSync(cmd)) continue;
    try {
      // The probe tests AVAILABILITY, and pidns specifically: a host whose
      // kernel/userns policy cannot create a PID namespace must probe-fail
      // and run unfenced (loudly), rather than ship a pid-sharing "jail"
      // that Security.md does not describe. Same flags as the real plan
      // (plus the class's own, e.g. --unshare-net), so probe and plan can
      // never disagree on what the platform offers.
      const argv = [
        bin,
        "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        ...extraFlags,
        "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc",
        ...roBinds.flatMap((p) => ["--ro-bind", p, p]),
        "--", cmd,
      ];
      const probe = Bun.spawnSync(argv);
      if (probe.exitCode === 0) return bin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
