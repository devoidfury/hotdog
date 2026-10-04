// Optional bubblewrap sandboxing for harness runs.
//
// Contract: if bwrap exists AND a real minimal-sandbox probe succeeds, harness
// commands run inside an allowlisted filesystem:
//   - root is a fresh tmpfs: /home, /root, /var, sibling checkouts, etc. DO NOT EXIST
//   - ro: system dirs (/usr /bin /lib ...), a curated /etc file set (TLS, DNS,
//     locale, profile), the hotdog config chain dirs, the interpreter's own
//     directory, and the repo root
//   - tmpfs over the grading material inside the repo (.git history, series
//     tasks, results)
//   - rw: only the per-run workspace and its session-log dir
// Network stays shared (harnesses must reach model endpoints).
// Caveats: the config chain dirs may contain credentials -- the harness process
// reads them by design, so they cannot be hidden from the sandbox it runs.
// Nix-style layouts (everything under /nix/store) are not supported by the
// allowlist; the probe failing there means runs go unsandboxed, flagged.

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
}

export function bwrapArgv(opts: {
  binary?: string;
  command: string;
  args: string[];
  plan: BwrapPlan;
}): string[] {
  const pre = [
    opts.binary ?? "bwrap",
    "--die-with-parent", // no orphans if the runner dies
    "--new-session",     // detach from the controlling terminal (TIOCSTI guard)
    "--tmpfs", "/",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  const binds = (flag: string, paths: string[]): void => {
    for (const p of paths) pre.push(flag, p, p);
  };
  binds("--ro-bind", opts.plan.roBinds);
  for (const p of opts.plan.hidden) pre.push("--tmpfs", p);
  binds("--ro-bind", opts.plan.roBindsAfterHidden);
  binds("--bind", opts.plan.rwBinds);
  pre.push("--", opts.command, ...opts.args);
  return pre;
}

/** Base read-only allowlist: system dirs, curated /etc, config chain, interpreter, repo. */
export function baseRoBinds(opts: { execPath: string; repoRoot: string; home?: string }): string[] {
  const candidates = [
    ...SYS_DIRS,
    ...ETC_FILES,
    dirname(opts.execPath),
    opts.repoRoot,
  ];
  if (opts.home) candidates.push(join(opts.home, ".config", "hotdog"));
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

function probeBwrap(): string | null {
  const bin = findBwrap();
  if (!bin) return null;
  try {
    // Probe the real recipe's core: tmpfs root must mount.
    const probe = Bun.spawnSync([bin, "--tmpfs", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"]);
    return probe.exitCode === 0 ? bin : null;
  } catch {
    return null;
  }
}
