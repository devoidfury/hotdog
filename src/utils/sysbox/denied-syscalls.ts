// The deny table: one TS-side list, the BPF filter is built from it at
// install time (launcher.c carries no syscalls of its own, so the filter and
// the tests cannot drift). Pinned exact sets in static-sandbox.test.ts.
//
// Numbers are Linux x86_64 syscall ABI (stable). capabilities.ts keeps the
// whole path unreachable on any other arch.
//
// Rationale per entry -- these are the escape surfaces for a path/network
// policy enforced one layer below them, not a general "dangerous syscalls"
// list:
//
// - io_uring_*: funnels file and network operations past every path-based
//   filter; no legitimate agent command needs it.
// - ptrace: attach to the parent (hotdog itself) and steal its memory/fds.
//   NOTE: ptrace is not the only parent-access path. Under Yama scope <= 1
//   (the common distro default) a *descendant* may access an ancestor, so
//   process_vm_readv/writev and pidfd_getfd are denied for the same reason
//   -- they reach hotdog's memory/fds without ever calling ptrace. Residual
//   ceiling (docs/sysbox-sandbox.md "Known ceilings"): opening
//   /proc/<ancestor>/mem goes through read-openat, which no mode traps.
// - mount / umount2 / pivot_root / chroot / open_tree / move_mount / fsopen /
//   fsconfig / fsmount / fspick: filesystem topology changes; also the classic
//   bind-mount-over-policy tricks.
// - setns / unshare: leave (or re-enter) namespaces to dodge mounts policy.
//   NOTE: clone/clone3 are deliberately NOT denied -- pthread creation needs
//   them. A sandboxed process may therefore create a *new* CLONE_NEWUSER; that
//   is a sandbox-within-the-sandbox, not an escape (no extra reach into the
//   host tree). Known ceiling.
// - bpf: prog arrays bypass seccomp policy decisions.
// - perf_event_open: kernel memory disclosure surface, no agent use.
// - userfaultfd: historical privilege surface, no agent use.
// - kexec_*: replace the kernel underneath the policy.
// - add_key / request_key / keyctl: the kernel keyring holds credentials
//   (afs, logins) outside the file deny list.

export interface DeniedSyscall {
  name: string;
  nr: number;
}

export const STATIC_DENIED_SYSCALLS: readonly DeniedSyscall[] = [
  { name: "io_uring_setup", nr: 425 },
  { name: "io_uring_enter", nr: 426 },
  { name: "io_uring_register", nr: 427 },
  { name: "ptrace", nr: 101 },
  // Parent-memory/fd theft without the ptrace syscall (Yama <= 1 lets a
  // descendant access an ancestor): the same rationale as ptrace above.
  { name: "process_vm_readv", nr: 440 },
  { name: "process_vm_writev", nr: 441 },
  { name: "pidfd_getfd", nr: 438 },
  { name: "mount", nr: 165 },
  { name: "umount2", nr: 166 },
  { name: "pivot_root", nr: 155 },
  { name: "chroot", nr: 161 },
  { name: "setns", nr: 308 },
  { name: "unshare", nr: 272 },
  { name: "bpf", nr: 321 },
  { name: "perf_event_open", nr: 298 },
  { name: "userfaultfd", nr: 323 },
  { name: "kexec_load", nr: 246 },
  { name: "kexec_file_load", nr: 518 },
  { name: "add_key", nr: 248 },
  { name: "request_key", nr: 249 },
  { name: "keyctl", nr: 250 },
  { name: "open_tree", nr: 428 },
  { name: "move_mount", nr: 429 },
  { name: "fsopen", nr: 430 },
  { name: "fsconfig", nr: 431 },
  { name: "fsmount", nr: 432 },
  { name: "fspick", nr: 433 },
];

/** Launcher-side static array bound (launcher.c MAX_DENY). */
export const MAX_DENY_SYSCALLS = 96;

/**
 * gate-mode trap set: syscalls whose WRITE/ESCAPE surface the USER_NOTIF
 * supervisor adjudicates (allow | deny | ask). Distinct from the static deny
 * list: these never reach the kernel's own handling until the supervisor
 * answers. Numbers are x86_64 ABI; pinned in tests, filter built from here
 * (launcher.c must define `NR_<name> <nr>` for every entry -- the golden
 * test greps exactly that, so C and TS cannot drift).
 *
 * The set covers EVERY syscall that can perform its operation, not just the
 * modern *at variants: x86_64 also has legacy unlink/rmdir/rename (glibc
 * uses those for unlink()/rename()), openat2 does everything openat does
 * (and its flags hide in a child-memory struct the BPF cannot see, so it
 * traps unconditionally and the supervisor reads open_how over /proc), and
 * connectionless sendto/sendmsg/sendmmsg egress without ever calling
 * connect (sendmsg is trapped EXCEPT on the helper's control socket fd --
 * the SCM_RIGHTS fd-pass needs it and happens pre-exec; see launcher.c).
 *
 * Second review round extended the same principle to the create/link/
 * truncate family, all measured bypasses of the deny list (Landlock grants
 * each root rw wholesale, so deny-list policy lives ONLY in this trap set):
 * - creat(85): legacy open(O_WRONLY|O_CREAT|O_TRUNC).
 * - truncate(76): truncates by path, never opens it. ftruncate(77) needs no
 *   trap: a writable fd can only come from a trapped write-open.
 * - link(86)/linkat(265): inode aliasing. Without a trap, hardlink the
 *   deny-listed file into scratch, then open the scratch alias (policy
 *   sees only the allowed alias path). Both endpoints are classified, like
 *   rename. linkat(AT_EMPTY_PATH) resolves the empty oldpath through the
 *   dirfd (/proc fd link) -- unresolvable ends deny fail-closed.
 * - mkdir(83)/mkdirat(258)/mknod(133)/mknodat(259)/symlink(88)/
 *   symlinkat(266): directory-entry creation inside a deny-listed area.
 *   For symlink the ENTRY (linkpath) is the operation; the target string
 *   is inert until an open follows it, and every later open is itself
 *   trapped.
 * Accepted ceiling (documented, not fixed): metadata-only syscalls --
 * chmod/chown/utimensat/xattr family -- still reach deny-listed paths
 * unchanged (no content read, no entry creation, no aliasing); and
 * name_to_handle_at/open_by_handle_at need CAP_DAC_READ_SEARCH, which a
 * NO_NEW_PRIVS unprivileged child cannot have.
 */
export interface TrappedSyscall {
  name: string;
  nr: number;
  /** Which GateRequest kind a notification for this syscall becomes. */
  kind:
    | "open.write"
    | "unlink"
    | "rename"
    | "truncate"
    | "create"
    | "link"
    | "connect"
    | "execve";
}

export const GATE_TRAPPED_SYSCALLS: readonly TrappedSyscall[] = [
  { name: "openat", nr: 257, kind: "open.write" },    // + write-flag mask in BPF
  { name: "openat2", nr: 437, kind: "open.write" },   // trapped always; supervisor filters by open_how.flags
  { name: "creat", nr: 85, kind: "open.write" },      // legacy write-open
  { name: "truncate", nr: 76, kind: "truncate" },     // path truncate, no open
  { name: "unlink", nr: 87, kind: "unlink" },
  { name: "unlinkat", nr: 263, kind: "unlink" },
  { name: "rmdir", nr: 84, kind: "unlink" },
  { name: "mkdir", nr: 83, kind: "create" },
  { name: "mkdirat", nr: 258, kind: "create" },
  { name: "mknod", nr: 133, kind: "create" },
  { name: "mknodat", nr: 259, kind: "create" },
  { name: "symlink", nr: 88, kind: "create" },        // entry (linkpath) is the op
  { name: "symlinkat", nr: 266, kind: "create" },
  { name: "link", nr: 86, kind: "link" },             // inode aliasing; both endpoints classified
  { name: "linkat", nr: 265, kind: "link" },
  { name: "rename", nr: 82, kind: "rename" },
  { name: "renameat", nr: 264, kind: "rename" },
  { name: "renameat2", nr: 316, kind: "rename" },
  { name: "connect", nr: 42, kind: "connect" },
  { name: "sendto", nr: 44, kind: "connect" },
  { name: "sendmsg", nr: 46, kind: "connect" },
  { name: "sendmmsg", nr: 345, kind: "connect" },
  { name: "execve", nr: 59, kind: "execve" },
];

/**
 * open flags that mean "this open writes" (O_WRONLY|O_RDWR|O_CREAT|
 * O_TRUNC|O_APPEND). The BPF applies it to openat's register arg; the
 * supervisor applies it to openat2's struct open_how.flags (1603 pinned to
 * launcher.c's OPEN_WRITE_MASK by the golden test).
 */
export const OPEN_WRITE_MASK = 1603;
