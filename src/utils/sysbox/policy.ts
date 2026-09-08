// gate-mode policy oracle: resolved notifications -> allow | deny | ask.
//
// Pure TS (no kernel, no /proc): index.ts resolves syscall args to absolute
// paths (procfs.ts) before calling in, so this module is unit-testable and
// mirrors Workspace semantics exactly (docs/sysbox-sandbox.md "Policy defaults").
//
// - inside workspace roots, not deny-listed  -> allow (fast path)
// - deny-listed (workspace.deny oracle)      -> ask   (hook decides; default deny)
// - outside every root / unresolvable        -> ask   (hook decides; default deny)
// - /dev/null-style sinks and scratch dirs   -> allow (documented ceiling:
//   hotdog's model is "the sandbox's own scratch may change", see docs/sysbox-sandbox.md TOCTOU §3)
// - connect                                  -> deny  (v1, no gate theater)
// - execve                                   -> allow (audit log only)

import { Workspace, PathEscapeError } from "../workspace.ts";

export const EPERM = 1;
export const EACCES = 13;

export type GateRequestKind =
  | "open.write"
  | "unlink"
  | "rename"
  | "truncate"
  | "create"
  | "link"
  | "connect"
  | "execve";

export interface GateRequest {
  kind: GateRequestKind;
  pid: number;
  syscall: number;
  /** Resolved absolute paths (rename/link: [from, to]); null = unresolvable. */
  paths: (string | null)[];
  /** execve only: best-effort argv. */
  argv?: string[];
  /** connect only: address family from sockaddr.sa_family. */
  domain?: number;
}

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; errno: number; why: string }
  | { action: "ask"; why: string };

/** Device sinks commands write constantly; gating them is noise, not safety. */
export const ALLOWED_DEVICE_PATHS: readonly string[] = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
];

/** Scratch dirs: the sandbox's own write surface (docs/sysbox-sandbox.md TOCTOU §3 ceiling). */
export function scratchDirs(env?: Record<string, string | undefined>): string[] {
  const dirs = ["/tmp", "/var/tmp"];
  const t = (env ?? process.env).TMPDIR;
  if (t && t.startsWith("/")) dirs.push(t.endsWith("/") ? t.slice(0, -1) : t);
  return dirs;
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

export function isScratchOrDevice(path: string, scratch: readonly string[]): boolean {
  return ALLOWED_DEVICE_PATHS.includes(path) || isScratch(path, scratch);
}

export function isScratch(path: string, scratch: readonly string[]): boolean {
  return scratch.some((d) => under(path, d));
}

function classifyPath(
  workspace: Workspace,
  path: string | null,
  scratch: readonly string[],
): GateDecision {
  if (path === null) {
    return { action: "deny", errno: EACCES, why: "path unresolvable (fail closed)" };
  }
  if (ALLOWED_DEVICE_PATHS.includes(path)) return { action: "allow" };
  try {
    // Workspace first, scratch second: a root that happens to live under
    // /tmp must still enforce its deny list -- the more specific boundary
    // wins over the generic scratch allowance.
    workspace.resolveSafe(path);
    return { action: "allow" };
  } catch (e) {
    if (e instanceof PathEscapeError) {
      // Discriminated by PathEscapeError.kind -- the rejection classes are
      // structural facts, not message text (a reword in workspace.ts must
      // not silently reclassify a deny-list ask as an out-of-root ask).
      if (e.kind === "denied") {
        return { action: "ask", why: `deny-listed: ${path}` };
      }
      if (e.kind === "direct" && isScratch(path, scratch)) {
        // Outside every root but inside the sandbox's own scratch surface
        // (docs/sysbox-sandbox.md TOCTOU §3 ceiling).
        return { action: "allow" };
      }
      return { action: "ask", why: `outside workspace: ${path}` };
    }
    return { action: "deny", errno: EACCES, why: `path check threw: ${e}` };
  }
}

export function evaluateGate(
  workspace: Workspace | null,
  req: GateRequest,
  scratch: readonly string[] = scratchDirs(),
): GateDecision {
  switch (req.kind) {
    case "execve":
      return { action: "allow" };
    case "connect":
      return {
        action: "deny",
        errno: EACCES,
        why: `connect blocked in gate v1 (domain ${req.domain ?? "?"})`,
      };
    case "open.write":
    case "unlink":
    case "truncate":
    case "create": {
      if (!workspace) return { action: "deny", errno: EACCES, why: "no workspace policy loaded" };
      return classifyPath(workspace, req.paths[0] ?? null, scratch);
    }
    case "rename":
    case "link": {
      if (!workspace) return { action: "deny", errno: EACCES, why: "no workspace policy loaded" };
      // Both endpoints must pass; ask wins over allow, deny wins over all.
      // For "link" this closes the hardlink-alias exfil: the deny-listed
      // source endpoint denies even though the alias sits in allowed scratch.
      const a = classifyPath(workspace, req.paths[0] ?? null, scratch);
      if (a.action === "deny") return a;
      const b = classifyPath(workspace, req.paths[1] ?? null, scratch);
      if (b.action === "deny") return b;
      if (a.action === "ask") return a;
      return b;
    }
  }
}
