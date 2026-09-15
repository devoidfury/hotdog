# Post-mortem: sysbox, the kernel-enforced bash sandbox

Status: **removed**. What existed: `src/utils/sysbox/` (a seccomp launcher compiled at spawn time
via `bun:ffi`'s TinyCC, a Landlock "fence" ruleset, capability probes, per-spawn cgroup v2 DoS limits),
wired as `bashTool.sandbox: off | static | fence`, plus `hotdog info` diagnostics. An earlier third mode,
`gate` (a per-syscall USER_NOTIF supervisor with human approvals), was deleted before this; its kernel facts
are kept below because they cost real time and survive the code.

TL;DR: It never sandboxed as well as I wanted -- `cat .env` worked in every mode, the fence's ro mirrors admitted `/proc/kcore` and friends, and availability probes outnumbered what the modes actually enforced. Shipping it risked telling users something was "secure" when it was not.


## Why it was removed

1. **The headline promise did not hold.** `workspace.deny` never bound bash in any mode. Landlock is allowlist-only --
  no negative rules, no subtree subtraction -- so `cat .env` and `cat .env > /tmp/copy` succeeded under `fence`, and
  `static` had no path visibility at all. A config that says "deny" while `cat` works is a misleading config.
2. **The read-only mirrors were leaky by construction.** A ro rule on `/proc` still admits `/proc/kcore` and `/proc/kpage*`;
  ro on `/dev` still admits `/dev/mem|kmem|port` and `/dev/pts/N` (the terminal the harness is attached to).
  Landlock cannot subtract, so these ceilings were unfixable within the mechanism.
3. **The availability matrix rivaled the enforcement matrix.** Six capability probes at the peak. A mode that mostly cannot run
  is a mode that is mostly untested; `gate`'s suite skipped on containers and, until a probe fix, skipped its DoS half on every
  systemd host including bare metal.
  (probes: seccomp action install, NEW_LISTENER, pidfd_getfd import, Landlock ABI, C compiler presence, cgroup delegation)
4. **The `gate` predecessor showed the enforcement locus was wrong.** Six review rounds each turned up a new bypass class --
  legacy syscall twins (`creat`/`truncate`/`link`), the `sendmsg` fd-number carve-out (a real UDP datagram egressed through
  a spawn whose decider denied every notification), `openat2`, alias-laundered `..` -- and its failure modes were the worst
  kind: a dead supervisor froze tasks, and closing the notify fd released every frozen task with `ENOSYS`.
5. **Zero-dependency constraint priced in a C compiler.** The launcher was compiled per-spawn with TinyCC via experimental `bun:ffi` `cc()`.
  Failures were fail-closed, but the whole surface (C source, FFI, bun-version pinning) was more machinery than the protection it delivered warranted.
  While this was fun to play with, leveraging in built-in toolchains, it added layers of complexity.

Alternatives exist and are honest about their boundary: run hotdog itself in a container or VM (`examples/`), or wrap the spawn in bwrap/podman externally.
That is where isolation advice now points.

## Notes on what we learned -- parts worth keeping

These came out of the deleted `docs/agents/sandbox-direction.md` and the "kernel facts" sections of `docs/sysbox-sandbox.md`.

### Design principles learned the hard way

- **Enforcement installed pre-exec, or not at all.** Every live userspace decision point is a future race condition.
  If mediation must be live, put it where its failure is an I/O error, not a frozen task or a destructive kernel sweep.
  Failure modes are a design property, not an implementation detail.
- **Deny as absence beats deny as error.** Not exporting a secret, not binding a path, tmpfs over a file --
  strictly stronger than "openat returns EACCES": no race window, no stat oracle, no syscall spelling variants.
  Absence does change errnos (`ENOENT`, not `EACCES`), which breaks naive callers -- that is the point.
- **Syscall deny-lists are a bottomless pit; prefer allowlisted views and cap-shaped kernel features** (Landlock, namespaces, cgroups).
  The kernel's feature APIs encode one enforcement point each; deny tables encode one per syscall per arch, and the fuzzers (kernel CVE trackers)
  have more time than any project here.
- **Approvals are easier at a spawn-time.** Human policy ("may this command run, with what mounts, with net or without")
  belongs above the process boundary. Welding approval UX to a syscall seam couples product reliability to kernel ABI drift.
  This is implemented: `user-gate` approves tool calls on `HOOKS.TOOL_CALL` -- its failure mode is a denied tool call,
  never a frozen task. It is triage, not enforcement.
- **Count the capability probes as a health indicator.** availability matrix ≥ enforcement matrix; the least-running mode is the least-tested one.
- **The locus ladder**: view (namespaces + Landlock) for static policy; a protocol server (9p/virtiofs shape) if file-granular dynamic mediation
  is ever genuinely needed -- its failure mode is benign by construction (server death = EIO, no kernel state outliving the connection);
  a VM (qemu/firecracker) if the kernel itself leaves the TCB. The syscall seam is the one locus where the kernel conspires with the race.

### Hard ceilings of the Landlock "fence"

Useful to anyone tempted to rebuild it:

- Cannot deny a path inside a granted tree (directory granularity, additive rules only). "Everything in the workspace except `.env`" is inexpressible.
- No view control: sees the host `/proc`, symlinks, shared `/tmp` (no per-spawn tmpfs without mount namespaces).
- Net denial works only per ABI: TCP bind/connect from ABI v4 (~6.7+), UDP bind/connect_send from ABI v10.
  Abstract unix sockets and signals (ABI v6 scope rights) need an allow-rule story for ordinary shell job control, so
  they were left unhandled -- meaning "handled" there is a policy choice, not coverage.
- At Yama `ptrace_scope` 0, an ancestor's `/proc/<pid>/{mem,fd,...}` is readable by a spawned command.
  Worth `cat /proc/sys/kernel/yama/ptrace_scope` on any host where sandboxed commands run beside harness-held secrets.
- cgroup DoS limits are only as strong as what the host delegates, per controller, and leaving a cgroup is an ordinary write to `cgroup.procs`.
  Disk-fill was never contained (cgroups cap pids and memory, not filesystem capacity).

### Kernel facts, dragged in off the street

seccomp USER_NOTIF (from the deleted `gate`):

- Releasing the notify fd's **last reference sweeps every frozen task with `ENOSYS`** -- no clean teardown of a wedged supervisor.
- USER_NOTIF waits are interruptible: a signal restarts the syscall and produces a *fresh* notification.
  "one notification per invocation" is false under load; answering the first copy double-executes.
- `NOTIF_ID_VALID` errno drifts across kernel versions (`ENOENT` vs `EBADFD`) for one condition; switch on "any error -> drop", not on errno.
- `NOTIF_SEND` cannot inject an fd -- which is why "check the path, then let the child open it" is a TOCTOU race with no textbook fix.
- `NEW_LISTENER | TSYNC` is `EINVAL` on current kernels: listener filters are per-thread, so other threads run unsupervised.
- The notify fd arrives `O_CLOEXEC`; reopening it via `/proc/<pid>/fd/N` is `EACCES`.
  Handoff requires `pidfd_open` + `pidfd_getfd` into the supervisor, with verification the imported fd is actually a notify fd
  (`readlink /proc/self/fd/N`) -- `SO_PEERCRED` proves *who* called, not *which of their fds* they named.
- **An fd number is not a capability.** Any predicate "allow iff `args[0] ==` a number we know" is bypassable by `close` + reallocation.
- Probe exit codes are a contract with the capability layer: a probe reporting one code for every failure can lie about the host.
  (C compiler failure once got reported as "an outer seccomp policy blocks pidfd_getfd".)

Path reconstruction is a second kernel in userspace, and four alias rules had to be exactly right (each a measured bypass):
fd links expand to their target; magic links (`/proc/self/root/...`) expand to a fixed point; only *self-addressed* links expand
(`/proc/<other>/fd/5` answers with *your* fd); `..` collapses **after** expansion, never before.

seccomp-bpf filter construction:

- A `RET_ERRNO`/`NOTIFY` belongs at the tail so default fallthrough lands on ALLOW; an argument predicate (`JSET` on open flags)
  must never sit on a fallthrough path -- `poll(timeout=200)` and `write(count=13)` share bits with an open-flags mask, so a
  misplaced predicate traps them and wedges the task.
- A RET-jump off-by-one converts every trap into an ALLOW and the kernel accepts the program anyway.
  (jump targets are validated, semantic intent is not). Only a behavior test -- install the real filter, prove the syscall is stopped -- catches it.
- A container's outer seccomp profile can advertise a feature in `/proc/sys/kernel/seccomp/actions_avail` yet EPERM its use:
  availability needs a real install probe, in a throwaway process (a filter installed in a test-runner thread is inherited by that
  thread's children, whose own installs then `EBUSY`).

Landlock:

- A rule giving directory-only rights to a non-directory `EINVAL`s (mask by `fstat`);
  `ruleset_attr` is 8 bytes pre-ABI-4, 16 from there; syscall numbers 444-446 are arch-generic.
- Net right bit **numbers** must be pinned by behavior, not doc trust: the plan guessed UDP at bits 8/9, an ABI-10 kernel had them at 2/3,
  and a wrong bit `EINVAL`s the ruleset (a refused spawn is visible, but only if a test runs it).
- `connect(2)` probes through bun's `node:net` are useless: bun maps kernel `EACCES` on connect to `ECONNREFUSED` (measured, 1.3.14).
  Pin with `bash -c 'echo > /dev/tcp/...'` and an explicit bash-exists skip guard (`/bin/sh` may be dash, which has no `/dev/tcp`).

Bun at the pin (1.3.14), spawn-process work generally:

- `fork()` from multithreaded bun/JSC is unusable (random child deaths, parent shutdown segfaults).
  Any "install something between fork and exec" design needs a dedicated helper process that installs on *itself* then execs --
  that pattern (exec preserves the pid, so process-group kill semantics carry over) was the one good architectural result.
- `NO_NEW_PRIVS` does not drop inherited capabilities, only blocks gaining them via execve -- root-run harness's "sandboxed" child still held
  `CAP_DAC_READ_SEARCH`.
- `process.uid` is undefined; go to `getuid(2)`.
- `child.stdio[N]` is a Stream with no numeric `.fd` -- a child cannot announce anything to the parent over stdio synchronously;
  the config pipe was written by the parent onto fd 3 instead.
- `rmSync` without `recursive` does not `rmdir` (cgroup cleanup needed plain `rmdir(2)`).
- Bun `node:child_process` stdio mis-wires under full-suite fd pressur.
  (child fd1/fd2 on the same socketpair end; ~1/3 in single-process full-suite runs, clean with `--parallel`).
  Upstream flake -- don't run full suites single-process on this repo's CI.

cgroups v2:

- On systemd hosts our own cgroup is a member-occupied leaf; the "no internal processes" rule means its `subtree_control`
  is permanently empty, so children created there never get limit files. Finding a hosting dir means walking
  UP to the deepest ancestor that delegates, and probing only your own cgroup reports "unavailable".
- Delegation is per-controller; "cgroups available" alone must not claim pids/memory.
- `/dev/tty` is neither a sink nor quiet: `bash -c` opens it `O_RDWR|O_NONBLOCK` on every startup (bash 5.2; dash never does).
  Policy that *asks* there prompts once per command over a decision the kernel already made (a detached spawn is its own session leader: `ENXIO`).

Mount view (unbuilt successor design; the C never shipped):

- `uid_map`/`gid_map` name the uid in the **parent** namespace and are written after `unshare(CLONE_NEWUSER)` --
  by then `getuid(2)` answers 0; capture the uid before the unshare. `setgroups=deny` first for gid writes.
- `MS_REC|MS_PRIVATE` on `/` before any tmpfs, or tmpfs mounts **propagate onto the host's `/tmp`** through shared subtrees --
  a sandbox escaping into the machine's scratch.
- Workspace-under-`/tmp` is chicken-and-egg: `open_tree(OPEN_TREE_CLONE)` while still reachable, tmpfs over `/tmp`, then `move_mount` onto the fresh tmpfs.
- Post-maps the task is root-in-ns and can `umount` every mask; `capset` to all-zero (with `NO_NEW_PRIVS`) makes deny-as-absence stick.
  Mounts made by an ancestor userns stay locked in a descendant's namespace.
- Blocker found while prototyping: containers routinely refuse `unshare(CLONE_NEWUSER)`
  (docker's seccomp profile: `EPERM`, and `clone3` → `ENOSYS`) even with `unprivileged_userns_clone=1`.
  Any view-based design must make the degraded host visible, never silently different.

## Where the policy surfaces went instead

- **Static policy** (deny list, egress): nowhere enforced. `workspace.deny` binds the file tools (`read`/`grep`/`explore`/`edit`);
  it never bound bash and does not now. Secrets should be configured around that boundary, or hotdog itself run inside a container/VM.
- **Dynamic policy** (approvals): `user-gate` on `HOOKS.TOOL_CALL`, above the spawn boundary -- decides whether a call runs,
  sees nothing inside a running command, and does not claim to enforce (`docs/config-reference.md` "userGate").
- If isolation is ever revisited, start from the locus ladder above, not from a syscall deny table.
