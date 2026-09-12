// The deny table: one TS-side list, the BPF filter is built from it at
// install time (launcher.c carries no syscalls of its own, so the filter and
// the tests cannot drift). Pinned exact sets in capabilities.test.ts.
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
//   NOTE: ptrace is not the only parent-access path. At ptrace_scope 0 -- the
//   default on several distros -- same-uid access is unrestricted, so a
//   descendant reaches hotdog's memory/fds without ever calling ptrace;
//   process_vm_readv/writev and pidfd_getfd are denied for that reason. Scope
//   1 is what denies a descendant reaching an ANCESTOR (measured:
//   open("/proc/<parent>/mem") -> EACCES on a scope-1 host). Residual ceiling
//   (docs/sysbox-sandbox.md "Known ceilings"): at scope 0 the same access is a
//   plain read-openat, and no mode here has path visibility at the syscall
//   boundary -- the USER_NOTIF trap set that used to close it is deleted.
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
// - name_to_handle_at / open_by_handle_at: path-less opens by file handle --
//   there is no path in the syscall for a trap to adjudicate, so they bypass
//   every path-based policy in every mode. They need CAP_DAC_READ_SEARCH:
//   unattainable for an unprivileged child, but NOT dropped for the child of
//   a root-run harness (NO_NEW_PRIVS only prevents GAINING caps; inherited
//   ones survive). No legitimate agent command uses them; denied outright.

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
  // Path-less handle opens bypass every path trap (no path string to judge);
  // CAP_DAC_READ_SEARCH survives into the child on a root-run harness.
  { name: "name_to_handle_at", nr: 303 },
  { name: "open_by_handle_at", nr: 304 },
];

/** Launcher-side static array bound (launcher.c MAX_DENY). */
export const MAX_DENY_SYSCALLS = 96;
