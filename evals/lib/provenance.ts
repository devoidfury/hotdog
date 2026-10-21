// Version stamp for the checkout under test. A multi-day sweep spans commits,
// and cells produced by different builds are not comparable -- so every run
// record carries the SHA (and dirtiness) of the code that produced it.
export interface Provenance {
  /** `git rev-parse HEAD`; null outside a repo, without git, or before the first commit. */
  rev: string | null;
  /** True when `git status --porcelain` reports changes (tracked or untracked). */
  dirty: boolean | null;
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    const res = Bun.spawnSync(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "ignore" });
    if (res.exitCode !== 0) return null;
    return res.stdout.toString();
  } catch {
    return null; // git not installed
  }
}

export function collectProvenance(repoRoot: string): Provenance {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (head === null) return { rev: null, dirty: null };
  const status = git(repoRoot, ["status", "--porcelain"]);
  return { rev: head.trim() || null, dirty: status === null ? null : status.trim().length > 0 };
}
