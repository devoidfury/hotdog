// Main-side extraction of strings from a sandboxed child's memory, used to
// turn seccomp notification args into policy-visible paths/argv.
//
// /proc/<pid>/mem reads (same-uid, Yama scope <=1: the child is our own
// descendant) -- deliberately NO ptrace/process_vm_readv FFI in the main
// process: sysbox's main-process surface stays pure TS (index.ts header).
// A child parked in a USER_NOTIF stop is in TASK_BLOCKED; its address space
// is fully readable.
//
// Every read is bounded (PATH_MAX / argv caps) and failure-tolerant: the
// CALLER decides what an unresolvable path means (for fs ops: deny, fail
// closed; for execve audit: log what we can).

import { openSync, readSync, closeSync, readlinkSync } from "node:fs";
import { resolve as resolvePosix } from "node:path";

const PATH_MAX = 4096;
const ARGV_MAX = 16;
const CSTR_CHUNK = 4096;

/** Read up to `len` raw bytes at `addr`; returns null on any failure. */
export function readChildBytes(pid: number, addr: bigint, len: number): Uint8Array | null {
  if (addr <= 0n || len <= 0) return null;
  let fd: number;
  try {
    fd = openSync(`/proc/${pid}/mem`, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(len);
    const n = readSync(fd, buf, 0, len, Number(addr));
    return n === len ? buf : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Read sockaddr.sa_family (u16, little-endian) at `addr`; null on failure. */
export function readChildSaFamily(pid: number, addr: bigint): number | null {
  const b = readChildBytes(pid, addr, 2);
  return b ? new DataView(b.buffer).getUint16(0, true) : null;
}

/** Read a NUL-terminated string at `addr` in the child. null on any failure
 * or if no NUL within PATH_MAX. */
export function readChildCString(pid: number, addr: bigint): string | null {
  if (addr <= 0n) return null;
  let fd: number;
  try {
    fd = openSync(`/proc/${pid}/mem`, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(CSTR_CHUNK);
    let collected: number[] = [];
    let pos = addr;
    while (collected.length < PATH_MAX) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, Number(pos));
      } catch {
        return null;
      }
      if (n <= 0) return null;
      const nul = buf.subarray(0, n).indexOf(0);
      if (nul !== -1) {
        collected.push(...buf.subarray(0, nul));
        return new TextDecoder("utf8", { fatal: false }).decode(new Uint8Array(collected));
      }
      collected.push(...buf.subarray(0, n));
      pos += BigInt(n);
    }
    return null; // no NUL within PATH_MAX
  } finally {
    closeSync(fd);
  }
}

/** Read argv (pointer array of C strings) at `argvAddr`. Best effort:
 * stops at NULL pointer, cap, or first unreadable entry. */
export function readChildArgv(pid: number, argvAddr: bigint): string[] {
  if (argvAddr <= 0n) return [];
  let fd: number;
  try {
    fd = openSync(`/proc/${pid}/mem`, "r");
  } catch {
    return [];
  }
  try {
    const out: string[] = [];
    const ptrBuf = new Uint8Array(8);
    for (let i = 0; i < ARGV_MAX; i++) {
      let n: number;
      try {
        n = readSync(fd, ptrBuf, 0, 8, Number(argvAddr + BigInt(8 * i)));
      } catch {
        break;
      }
      if (n !== 8) break;
      const p = new DataView(ptrBuf.buffer).getBigUint64(0, true);
      if (p === 0n) break;
      const s = readChildCString(pid, p);
      if (s === null) break;
      out.push(s);
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export const AT_FDCWD = -100;

/**
 * Resolve a syscall path argument (dirfd, pathname) to an absolute path in
 * OUR namespace view. null when unresolvable (caller denies).
 *
 * dirfd handling: AT_FDCWD -> child's /proc cwd; else the fd's /proc link.
 * Lexical join only -- symlink/containment judgment belongs to
 * Workspace.resolveSafe (policy.ts), which re-checks real paths.
 */
export function resolveSyscallPath(
  pid: number,
  dirfdRaw: bigint,
  pathname: string | null,
): string | null {
  if (!pathname || pathname.length === 0) return null;
  if (pathname.startsWith("/")) return resolvePosix(pathname);
  let dir: string;
  if (Number(dirfdRaw) === AT_FDCWD || dirfdRaw === 0xffffffffffffff9cn) {
    try {
      dir = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  } else {
    try {
      dir = readlinkSync(`/proc/${pid}/fd/${Number(dirfdRaw)}`);
    } catch {
      return null;
    }
  }
  return resolvePosix(dir, pathname);
}

/** Expand /dev/fd/N and /proc/<pid|self>/fd/N indirection to the link
 * target ("" if not an fd link). Policy re-evaluates the target. */
export function expandFdLink(pid: number, path: string): string {
  const m = /^(?:\/dev\/fd|\/proc\/(?:self|\d+)\/fd)\/(\d+)$/.exec(path);
  if (!m) return path;
  try {
    return readlinkSync(`/proc/${pid}/fd/${m[1]}`);
  } catch {
    // unreadable fd link: keep the original -- it is NOT inside a workspace
    // root, so default policy denies it rather than trusting an alias.
    return path;
  }
}

/** True when `fd` (in THIS process) is a seccomp USER_NOTIF listener fd.
 *
 * The check exists because the notify fd's NUMBER arrives over an abstract
 * socket from whoever we just accepted, and `SO_PEERCRED` proves only the
 * uid -- not which of the peer's fds it named. At ptrace_scope 0 any same-uid
 * process can win the accept and hand us one of its own notify fds from a
 * *different* sandbox, which would put our decider in front of another
 * supervisor's frozen tasks. Import it, then verify what it actually is.
 *
 * Measured on this kernel the link target is "anon_inode:seccomp notify"
 * (no brackets); substring-match so the bracketless/bracketed variants both
 * hold. Unreadable -> false (fail closed).
 */
export function isSeccompNotifyFd(fd: number): boolean {
  if (fd < 0) return false;
  let link: string;
  try {
    link = readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return false;
  }
  return link.includes("seccomp");
}
