# sysbox: kernel-enforced bash (`src/utils/sysbox/`)

Status: implemented modes `static`, `fence`, wired as `bashTool.sandbox`. The
`gate` mode (USER_NOTIF supervisor, per-syscall policy, human approvals) is
**deleted** -- see "gate: removed" and `docs/agents/sandbox-direction.md`,
which holds the failure anatomy and the kernel facts that came out of it.
User-facing capability comparison: `docs/config-reference.md` ("Bash sandbox modes").

## Motivation

`workspace.deny` binds the file tools but never bound `bash`: the bash tool was `spawn(command, [], { shell: true })`
and any command could `cat ~/.ssh/id_rsa` regardless of config. sysbox provides the enforcement layer, and it has
exactly one shape: **every guarantee is installed before `execve` and enforced by the kernel afterwards**. Once the
helper execs, hotdog has no decision point left in the command's path -- nothing to race, no fd to leak, nothing that
can die and wedge the command.

Why kernel-level rather than parsing commands: userspace interposition (LD_PRELOAD, shims, ptrace-stop-and-ask)
is bypassable by any static binary making raw syscalls. If the sandboxed process can remove the boundary, the
boundary is furniture. seccomp filters cannot be dropped once installed, so they set a floor.

Why `cc()` from `bun:ffi`: TinyCC ships inside Bun, so no system toolchain, no package, no additional prebuilt binary enters the supply chain.
`launcher.c` is auditable in full; its sha256 is logged at first use and shown by `hotdog info`. `bun:ffi`/`cc()` are experimental,
so the sandbox is opt-in, Bun is pinned (`engines.bun`), and every `cc()` failure path is fail-closed (see Invariants).

## Process model

We tried (fork from the hotdog process, install the filter in the child between fork and exec) but this was unusable:
in-process `fork()` from bun 1.3.14's multithreaded JSC produced random child deaths plus parent shutdown segfaults.

The as-built model has no fork anywhere:

```
 bash-tool.execute()  (sandbox != off)
        │
        ▼ spawn(process.execPath, [sbx-exec.ts], stdio fd3 = config pipe)
 sbx-exec helper (separate bun process, empty env)
   reads JSON config on fd 3
   -> [cgroup: write own pid to cgroup.procs -- DoS limits from here on]
   -> chdir
   -> cc(launcher.c)
   -> [fence: Landlock ruleset, incl. every net right the ABI knows]
   -> seccomp deny filter on itself (NO_NEW_PRIVS + TSYNC)
   -> execve(target)
```

Consequences of the helper model:

- The main process never installs a filter and never runs `cc()`; bun:ffi failure domains never overlap with the agent session,
  and hotdog itself can run under `--no-ffi-cc`. `cc()` runs only in the helper, costing ~5 ms per spawn.
- `execve` preserves the pid, so the helper's detached process group is the command's process tree: pipes, exit codes,
  and `killProcessGroup` work unchanged across sandboxed and unsandboxed paths.
- The helper's own env is empty; the scrubbed command env travels inside the fd-3 config (least exposure via `/proc/<pid>/environ`).
- Setup failures are exit codes: 126 (config/chdir/cc/landlock/seccomp/cgroup-join), 127 (execve failure). The command did not run.
- The filter installs on the helper's calling thread; the helper's other bun threads are unfiltered but run none of the command (execve kills them,
  and post-exec threads inherit the filter by kernel design).

## Enforcement ladder (`sandbox.mode`)

One config enum (`bashTool.sandbox`), each level includes the previous. No
other new flags.

| mode            | Mechanism                          | What it stops                                                                                                                                                                                                                                              | Kernel             |
| --------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `off` (default) | current spawn                      | nothing new                                                                                                                                                                                                                                                | any                |
| `static`        | seccomp deny-filter, no fs policy  | escape surface: `io_uring_*`, `ptrace`, `process_vm_readv`/`writev`, `pidfd_getfd`, `mount`/`umount2`/`pivot_root`/`chroot`, `setns`/`unshare`, `bpf`, `perf_event_open`, `userfaultfd`, `kexec_*`, `add_key`/`keyctl`/`request_key`, `open_tree`/`move_mount`/`fsopen`/`fsconfig`/`fsmount`/`fspick`, `name_to_handle_at`/`open_by_handle_at` | any w/ seccomp     |
| `fence`         | + Landlock ruleset (fs + net)      | coarse fs allowlist: workspace roots + scratch read-write, system dirs + `$PATH` dirs read-only, home dirs unreachable. Network: every bind/connect the kernel's Landlock ABI knows, denied with zero allow rules. **Cannot express `workspace.deny`** (allowlist-only, no subtree subtraction)                            | ≥ 5.13 (net ≥ 6.7) |

`static` is the recommended floor for anyone who won't pay the Landlock kernel
requirement. All modes: Linux x86_64 only (`denied-syscalls.ts` pins x86_64
syscall numbers; `capabilities.ts` refuses other archs). arm64 definitions are a
follow-up, not v1.

## What the fence is: an allowlist, and nothing else

`fenceConfigFor(workspace)` builds the ruleset:

- **rw**: workspace roots, scratch (`/tmp`, `/var/tmp`, `$TMPDIR`), and the
  device sinks (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`,
  `/dev/full`) get every fs right the running ABI supports.
- **ro**: `FENCE_SYSTEM_RO_DIRS` (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`,
  `/etc`, `/proc`, `/sys`, `/dev`) plus the absolute `$PATH` dirs, EXECUTE|READ
  only. The `$PATH` half exists because a toolchain installed outside the
  system dirs (bun in `~/.bun/bin`) has to stay runnable.
- **net**: `handled_access_net` = every net right the ABI knows, with **zero
  allow rules**, so TCP bind/connect (ABI v4+) and UDP bind/connect_send (ABI
  v10+) are `EACCES` kernel-side. `LANDLOCK_NET_RIGHTS` in `capabilities.ts`
  mirrors the C table; `hotdog info` prints the posture
  (`net: tcp bind+connect denied +udp` on this host, `net: unhandled` below 4).
  Scope rights (abstract unix sockets, signals; ABI v6+) are deliberately NOT
  handled -- see the rights-masking note in "Known ceilings".

Landlock stacks (a later ruleset may only restrict), so fence composes with
whatever else the host layers on. And it is installed once: there is no
policy evaluator behind it.

**What it cannot say is "everything in the workspace except `.env`."**
Landlock has no negative rules and no subtree subtraction, so
`workspace.deny` has no kernel expression here, and nothing else in bash
enforces it either: under `fence`, `cat .env` and `cat .env > /tmp/copy` both
succeed. The file tools (`read`/`grep`/`explore`) do bind the deny list, in
every configuration. Closing the gap needs a mount view (deny-as-absence),
which is design-not-code -- see "Future work".

## gate: removed

`gate` was a third mode: a per-spawn USER_NOTIF supervisor (a Bun Worker) that
received every syscall capable of read/write/create/alias/truncate/egress,
reconstructed the path in TS (`procfs.ts`), ran it through a policy oracle
(`policy.ts`), and could hand the decision to a human through a
`SANDBOX_GATE` hook (`user-gate` extension). Six rounds of review each produced
a new bypass class (legacy syscall twins, the `sendmsg` fd-number carve-out,
`openat2`, alias-laundered `..`), and the mode's failure modes were the worst
kind: a dead supervisor froze tasks, and closing the notify fd released them all
with `ENOSYS`. Its availability matrix (six probes) was larger than its
enforcement matrix, which is how a mode ends up running zero hours and being
tested by nobody.

Deletion, not deprecation. Its *static* policy ambitions (deny list, egress,
path shape) moved to fence (egress: Landlock-net, shipped) and to the unbuilt
mount view (deny list). Its *dynamic* surface -- asking a human mid-command --
is gone, on the principle recorded in `docs/agents/sandbox-direction.md`:
approvals are a spawn-time product surface, above the process boundary, never
welded to a syscall seam. That principle is now implemented: the `user-gate`
extension approves TOOL CALLS on the hook pipeline
(`docs/config-reference.md` "userGate"), which is a different thing wearing the
same name -- it can decide whether `bash` runs, and it cannot see inside a
command once it is running. The USER_NOTIF kernel facts and the anatomy of the
flakiness live in that doc's appendix.

Consequences of the deletion, said plainly:

- No mode has path visibility at the syscall boundary any more. Deny-listed
  paths inside a granted root are reachable in every mode.
- `execve` audit logging is gone with it.
- The Yama-scope-0 ancestor-read hole is open in every mode again (the gate's
  open trap was the only closer).
- Approvals no longer exist anywhere in the sandbox. They came back ABOVE it:
  `user-gate` on `HOOKS.TOOL_CALL` (opt-in, `docs/config-reference.md`
  "userGate") decides before the call, in every mode including `off`, and
  nothing during it.

## Invariants (fail-closed list)

1. Requested mode unavailable (kernel, arch, `--no-ffi-cc`, cc() failure) →
   `ConfigError` at startup, never a silent downgrade to unsandboxed spawn.
   (`resolveSandboxMode` + the capability matrix from `capabilities.ts`,
   surfaced by `hotdog info`.)
2. Any helper setup failure -- config validation, chdir, cc(), landlock
   install, seccomp install, cgroup join -- dies at 126 before `execve`. A
   spawn announced as sandboxed never runs un-sandboxed, and never runs
   partially-sandboxed.
3. The hotdog process never installs a filter. Only the helper, pre-exec.
4. `fence` without a workspace on the tool context → refuse to run (a fence
   without roots is not a fence).
5. `launcher.c` sha256 logged at first use, included in `hotdog info`.

## Known ceilings (deliberate, documented)

- **`workspace.deny` binds nothing in bash.** Not reads, not writes, in any
  mode. Under `fence`, `cat .env > /tmp/copy` succeeds; content leaves through
  the tool output even with net denied. Only the file tools enforce the deny
  list. (Landlock is allowlist-only; `static` has no path visibility at all.)
- **Parent-process procfs when Yama is off (scope 0).** The deny table blocks
  `ptrace`, `process_vm_readv`/`process_vm_writev`, and `pidfd_getfd` -- the
  three syscalls a descendant would otherwise use to reach an ancestor. Yama
  scope 1 (the common distro default, and the host these were measured on) is
  what denies a descendant reaching an ANCESTOR at all:
  `open("/proc/<parent>/mem")` -> `EACCES`. At scope 0 the same access is a
  plain read-`openat`, and no mode here has path visibility, so it is allowed.
  World-readable process metadata (`stat`, `status`, `cmdline`) stays readable
  either way, so `ps` works. Worth running `cat /proc/sys/kernel/yama/ptrace_scope`
  on any host where sandboxed commands run beside harness-held secrets.
- **Confidential surfaces inside the ro mirror stay open.** Landlock has no
  negative rules: a ro rule on `/proc` still admits `/proc/kcore` and
  `/proc/kpage*`, and a ro rule on `/dev` still admits `/dev/mem`, `/dev/kmem`,
  `/dev/port` -- whether they are actually readable is the kernel's own
  root:kmem permission, and on a root-run harness that is not a sandbox layer.
- **The harness's own pty node (`/dev/pts/N`) is readable.** The spawn is
  detached (its own session leader, `tty_nr == 0`, measured on bun 1.3.14), so
  `/dev/tty` resolves to nothing and `/dev/console` is root-owned; but
  `/dev/pts/N` belongs to the harness's uid and the ro `/dev` mirror admits it,
  so a sandboxed command can contend with hotdog for keystrokes. Pulling `/dev`
  out of the mirror would take `/dev/shm` and `/dev/ptmx` down with it. Writes
  stay blocked (ro mirror), so forging output into the human's session is not
  part of this ceiling.
- **Scratch is the machine's real `/tmp`.** No per-spawn tmpfs (that needs
  mount namespaces), so sandbox writes there are visible to, and collidable
  with, everything else on the host. Tests use pid-suffixed names for that
  reason.
- **Metadata-only syscalls** (chmod/chown/utimensat/xattr family) on paths
  inside a granted root are allowed, as everything inside the root is.
  Out-of-root metadata ops stay fence-blocked (path traversal).
- `clone`/`clone3` are not denied (pthread creation needs them), so a
  sandboxed process may create a new `CLONE_NEWUSER`: a sandbox-within-the-
  sandbox with no extra reach into the host tree (Landlock cannot be
  escaped with capabilities gained after `restrict_self`, and seccomp
  follows the task).
- Landlock rights newer than the C rights table stay unhandled (= allowed)
  on future ABIs; unsupported rights are masked OUT from handled_access so a
  kernel predating a right can never EINVAL the ruleset. Net scope rights
  (abstract unix sockets, signals, ABI v6+) are unhandled on purpose: they are
  not an egress path, and handling them would need an allow-rule story for
  ordinary shell job control.
- **No `execve` audit.** The gate logged every exec; nothing does now.

## cgroups: per-spawn DoS containment (all sandbox modes, best-effort)

Every sandboxed spawn (static and fence) runs inside a per-spawn cgroup v2
with `pids.max` (fork bombs: forks EAGAIN at the cap instead of eating the
host's pid table) and `memory.max` + `memory.swap.max=0` (zip bombs / heap
hogs: an in-cgroup OOM kill, not host swap thrash or a panic). `index.ts`
creates `hotdog-sbx-<pid>-<seq>` under the hosting dir resolved once by
capability detection (`cgroupParentDir`, see below), writes the limits, and
passes the dir in the spawn config; `sbx-exec` writes its own pid into
`cgroup.procs` as its FIRST act (before chdir/cc), so nothing the command or
any descendant produces is ever outside the cage. Removal is on child exit
with bounded retries (rmdir EBUSYs while daemonized leftovers live -- which
keeps the limits ON, the right failure mode).

An in-cgroup OOM kill is a kernel SIGKILL: the tool would otherwise report a
bare dead exit code (null/137) with no why. The exit handler reads
`memory.events` BEFORE the rmdir (the counters die with the directory) and,
when `oom_kill` went up, records a note on the child; the bash tool appends
it to the tool output after truncation, so the human/model sees
`sandbox memory limit reached ... (cgroup memory.max = N bytes, oom_kill = K)`.
Kills land only when the memory controller is delegated; a pids-only host
records nothing to report.

Availability is probed by a real mkdir/rmdir under a HOSTING DIR found by
walking UP from our own cgroup to the deepest ancestor whose
`cgroup.subtree_control` exposes pids/memory and that we can mkdir into.
Walking up is not optional: on systemd hosts our own cgroup is a leaf scope
with member processes, and the kernel's "no internal processes" rule means
its `subtree_control` is permanently empty -- children created there get no
limit files, so probing only our own cgroup reported "unavailable" on every
systemd machine (measured, the reason the suite once skipped everywhere).
The common failure remains delegation, not kernel support: read-only
`/sys/fs/cgroup` in containers, non-root at the root cgroup, controller absent
from `subtree_control` at every level.
Delegation is PER CONTROLLER: the probe reports which of
pids/memory actually surfaced (`cgroupPidsAvailable`/`cgroupMemoryAvailable`,
shown by `hotdog info`), `cgroupAvailable` is their union, and each
behavior test gates on its own controller -- a pids-only host gets fork
containment and nothing more. This is deliberately NOT a sandbox mode and NOT
fail-closed: absence degrades with a warn; the requested mode's guarantees
(seccomp/Landlock) hold without it. A helper that fails to JOIN a cgroup
its parent already built dies at setup (126) -- an announced-as-limited spawn
never silently runs unlimited. The exit-time cleanup is a plain `rmdir(2)`
(`rmdirSync`): bun's `rmSync` without `recursive` does not rmdir (measured
failure on 1.3.14) and with `recursive` would try to unlink the cgroup's
virtual files -- so every other spelling silently leaves the dir behind.

Ceilings, stated plainly: `MemTotal/2` clamped to [512 MiB, 4 GiB] is a
heuristic, not a per-command tuning; a **disk**-filling decompression bomb
(streamed `gzip -dc bomb > out`) is NOT contained -- cgroups cap pids and
memory, not filesystem capacity (that wants the `overlay` mode's scratch
upper); CPU exhaustion stays covered only by the bash tool's own
timeout+process-group kill (no `cpu.max` by default: throttling legitimate
builds is a worse failure than a busy core until timeout); a hotdog that is
SIGKILLed mid-spawn leaves a stale cgroup dir behind (nothing runs the rmdir;
harmless kernel litter, swept by nothing today).

**The cage holds only where something enforces it.** Leaving a cgroup is an
ordinary write to `cgroup.procs` -- no privilege beyond the uid that owns the
delegated subtree, which is the sandbox's own uid. `static` has no path
visibility, so a `static` command can move itself (and with it its fork bomb)
into the parent cgroup and run uncapped; the limits there stop accidents, not
an adversary. `fence` holds the cage closed by making `/sys` read-only. Treat
`pids.max`/`memory.max` as DoS containment for `fence`; in `static` they are
advisory.

## Kernel facts learned the hard way

Recorded so the next reader does not re-learn them expensively. (Everything
specific to the deleted USER_NOTIF gate -- notify-fd lifetimes, the ENOSYS
sweep, the pidfd_getfd import dance, path reconstruction -- moved to
`docs/agents/sandbox-direction.md`, appendix.)

- Fork from multithreaded bun/JSC is unusable (measured); install-on-self + exec in a dedicated helper sidesteps the entire fork-safety class.
- `NO_NEW_PRIVS` does not drop inherited capabilities -- it only blocks gaining them through execve. On a root-run harness the sandboxed child still holds `CAP_DAC_READ_SEARCH`, so `open_by_handle_at` (pathless open by handle, invisible to every path-based policy) is reachable there and sits in the deny table; the earlier "a NO_NEW_PRIVS child cannot have it" ceiling was wrong for root.
- BPF placement: RET ERRNO must sit at the tail so default fallthrough lands on ALLOW, and an argument predicate (`JSET` on open flags) must never sit on a fallthrough path -- `poll(timeout=200)` and `write(count=13)` share bits with an open-flags mask, so a misplaced predicate traps them and wedges the task ("install hangs" bug, hit while the gate existed; the placement law stands for any future in-filter arg predicate).
- A seccomp RET-jump off-by-one converts every trap into an ALLOW and the kernel accepts the program anyway (jump targets are validated, semantic intent is not). Behavioral pinning -- install the real filter and prove the syscall is stopped -- is the only check that catches it.
- A container's outer seccomp profile can advertise a kernel feature in `/proc/sys/kernel/seccomp/actions_avail` yet EPERM the syscall flags that use it, so availability is decided by a real install probe, not by reading procfs. The probe must live in a throwaway process: a filtered process must never return to bun shutdown code, and a filter installed in a test-runner thread is inherited by that thread's spawned children (their own installs then EBUSY).
- Landlock: a rule giving directory-only rights to a non-directory EINVALs (mask by `fstat`); x86_64 `fstat` writes the full 144-byte `struct stat` regardless of the caller's struct (a short buffer is a stack smash, not a truncation); `ruleset_attr` is 8 bytes pre-ABI-4, 16 from there; landlock syscall numbers (444-446) are arch-generic.
- Landlock net bit NUMBERS must be pinned by behavior, not by doc trust: the plan guessed UDP at bits 8/9 and the ABI-10 kernel here put them at 2/3 (bits ≥4 EINVAL the ruleset create, so a wrong guess is a refused spawn -- visible, but only if a test runs it). `connect(2)` probes through bun's `node:net` are useless: bun maps a kernel `EACCES` on connect to `ECONNREFUSED` (measured 1.3.14), so the errno pin uses `bash -c 'echo > /dev/tcp/...'` with an explicit `Bun.which("bash")` skip guard (`/bin/sh` here is dash, which has no `/dev/tcp`).
- `sbx_fence_probe` (ABI query + ruleset create/close, never restricts) is side-effect-free, so a normal exit is safe there.
- bun `process.uid` is undefined at the pin (measured, 1.3.14); anything needing the uid goes straight to `getuid(2)`.
- bun `child.stdio[N]` is a Stream with **no numeric `.fd`** (measured), so a spawned child cannot announce anything to the parent over a stdio pipe synchronously -- hence the fd-3 config pipe is written by the parent, not read back by number.
- Bun `node:child_process` stdio mis-wires under full-suite fd pressure: a spawned child can get fd1/fd2 pointing at the same socketpair end (writes EPIPE/EIO). Repros ~1/3 only in single-process `bun test` of the whole suite; fresh spawns and `--parallel` (the repo's `bun run test`) are clean. Upstream (bun 1.3.14) -- do not run the full suite single-process on hotdog CI. Coverage instrumentation (`bun run coverage`) reproduces the same early-spawn deaths even with `--parallel` (measured: ~2 of 5 full-suite runs; victim varies across the sandbox suites, child dead within ~20-40 ms of spawn, exit before the command runs). A sandbox test failing that way under coverage is the upstream flake, not a policy regression -- re-run and check the timing before believing it.

## Future work (not built)

- **Mount view (`fence.view`): deny as absence.** A pre-exec `unshare(CLONE_NEWUSER|CLONE_NEWNS)`
  in the helper: self uid/gid maps, `MS_REC|MS_PRIVATE`, a fresh tmpfs on `/tmp`,
  `open_tree`+`move_mount` to re-attach a workspace that lives under `/tmp`,
  bind-mount masks over deny-listed paths (ENOENT to the sandbox: no stat oracle,
  no spelling variants, no TOCTOU window) and over the confidential `/proc` +
  `/dev` surfaces, then `capset` to zero so the sandbox cannot unmount the masks,
  then Landlock as the monotone inner bound. Design in
  `docs/agents/sandbox-direction.md`; blocker found while prototyping: this
  workspace **container** refuses `unshare(CLONE_NEWUSER)` (EPERM from the docker
  seccomp profile, and `clone3` → ENOSYS), so the view's tests can only RUN on a
  host with unprivileged userns -- on any host without it, fence stays the
  ruleset-only shape documented above and must say so out loud.
- `overlay` mode: writable scratch upper with reviewable diff-on-exit; all network via an egress proxy reusing
  fetch-tool's `assertPublicHost` (IP-level approval is the wrong gate).
- **Approvals above spawn, not at the syscall seam** -- built, in exactly that shape: `user-gate`
  registers a `HOOKS.TOOL_CALL` handler (continue / modify / block-with-result), so a failed approval
  degrades to a denied tool call instead of a frozen task. Its ceiling is stated where it is configured:
  best-effort bash triage, no claim to enforce anything.
- arm64 syscall tables.
- Per-child policy (e.g. subagents at `fence`, main agent at `static`) -- deferred until a real use exists; mode is global per the no-speculative-flags rule.
- Flipping the default from `off` -- `static` passes the full suite at zero measured overhead, but the default change wants real-session mileage, not one CI-shaped run.
