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
// there means those hosts run unfenced, flagged. Network stays shared --
// `--unshare-net` is reserved for the future `no-net` class, not a v1 policy.
//
// The shape is deliberately backend-agnostic: a future seatbelt (macOS) or
// container backend implements the same plan/probe surface.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
}): string[] {
  const pre = [
    opts.binary ?? "bwrap",
    "--die-with-parent", // no orphans if the spawner dies
    "--new-session",     // detach from the controlling terminal (TIOCSTI guard)
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
  // fresh /dev and /proc whatever the allowlist drags in.
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

export interface PlanePlanResult {
  /** Full spawn argv (bwrap ... -- command args), or null when the fence is unavailable. */
  prefixArgv: string[] | null;
  /** Backend the probe allowed, mirrored into the status line; null = plain spawn. */
  probe: "bwrap" | null;
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
 * `cls` is carried for the backend contract: today `rw` and `net` plan
 * identically (bwrap shares network by default; `--unshare-net` arrives with
 * the future `no-net` class). `scratch` must exist host-side -- bwrap bind
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
}): PlanePlanResult {
  const binary = opts.binary === undefined ? bwrapBinary() : opts.binary;
  if (!binary) return { prefixArgv: null, probe: null };
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
  // The jail has no home; point HOME/TMPDIR at the per-entry scratch bind.
  const prefixArgv = bwrapArgv({
    binary,
    command: opts.command,
    args: opts.args,
    plan,
    setEnv: { HOME: "/tmp", TMPDIR: "/tmp" },
  });
  return { prefixArgv, probe: "bwrap" };
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

/** Resolved bwrap path if it exists and a trivial sandbox actually runs; null otherwise. Cached. */
export function bwrapBinary(force = false): string | null {
  if (cachedBinary !== undefined && !force) return cachedBinary;
  cachedBinary = probeBwrap();
  return cachedBinary;
}

export function bwrapAvailable(force = false): boolean {
  return bwrapBinary(force) !== null;
}

/** Status-line backend label for a probed fence: "bwrap" when the probe passes. */
export function execFenceBackend(force = false): "bwrap" | null {
  return bwrapBinary(force) ? "bwrap" : null;
}

function probeBwrap(): string | null {
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
      const argv = [
        bin,
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
