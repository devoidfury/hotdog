# sysbox: kernel-gated bash (`src/utils/sysbox/`)

Status: implemented modes `static`, `fence`, `gate`, wired as `bashTool.sandbox`.
User-facing capability comparison: `docs/config-reference.md` ("Bash sandbox modes").

## Motivation

`workspace.deny` binds the file tools but never bound `bash`: the bash tool was `spawn(command, [], { shell: true })`
and any command could `cat ~/.ssh/id_rsa` regardless of config. sysbox provides the enforcement layer,
with a human gate (hook-approvable asks) for the operations policy cannot decide silently.

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
   reads JSON config on fd 3 → chdir → [fence: landlock ruleset]
   → seccomp install on itself → execve(target)
        │
        │ gate mode only:
        │   connects to supervisor's abstract unix socket BEFORE installing
        │   (the filter traps connect), installs NEW_LISTENER filter,
        │   passes the notify fd over SCM_RIGHTS, then execve's -- the
        │   execve itself traps and blocks until the supervisor answers, so
        │   the command never runs unsupervised.
        ▼
 sup.ts supervisor (one Bun Worker per gate spawn)
   NOTIF_RECV → main thread decodes args via /proc (pure TS, no FFI)
   → policy.ts → SANDBOX_GATE hook pipeline → NOTIF_SEND (CONTINUE | errno)
```

Consequences of the helper model:

- The main process never installs a filter and never runs `cc()`; bun:ffi failure domains never overlap with the agent session,
  and hotdog itself can run under `--no-ffi-cc`. `cc()` runs only in the helper and in the supervisor Worker, each costing ~5 ms per spawn.
- `execve` preserves the pid, so the helper's detached process group is the command's process tree: pipes, exit codes,
  and `killProcessGroup` work unchanged across sandboxed and unsandboxed paths.
- The helper's own env is empty; the scrubbed command env travels inside the fd-3 config (least exposure via `/proc/<pid>/environ`).
- Setup failures are exit codes: 126 (config/chdir/cc/seccomp/gate-socket), 127 (execve failure). The command did not run.
- The filter installs on the helper's calling thread; the helper's other bun threads are unfiltered but run none of the command (execve kills them,
  and post-exec threads inherit filter + listener by kernel design).

## Enforcement ladder (`sandbox.mode`)

One config enum (`bashTool.sandbox`), each level includes the previous. No
other new flags.

| mode            | Mechanism                         | What it stops                                                                                                                                                                                                                                             | Kernel               |
| --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `off` (default) | current spawn                     | nothing new                                                                                                                                                                                                                                               | any                  |
| `static`        | seccomp deny-filter, no fs policy | escape surface: `io_uring_*`, `ptrace`, `mount`/`umount2`/`pivot_root`/`chroot`, `setns`/`unshare`, `bpf`, `perf_event_open`, `userfaultfd`, `kexec_*`, `add_key`/`keyctl`/`request_key`, `open_tree`/`move_mount`/`fsopen`/`fsconfig`/`fsmount`/`fspick` | any w/ seccomp       |
| `fence`         | + Landlock ruleset                | coarse fs allowlist: workspace roots + scratch read-write, system dirs read-only, home dirs unreachable, TCP bind blocked. **Cannot express `workspace.deny`** (allowlist-only, no subtree subtraction)                                                   | ≥ 5.13               |
| `gate`          | + USER_NOTIF supervisor           | exact policy in TS: the deny list (writes), per-op human approval, egress denial. Trap set: every syscall that can write/create/alias/truncate/egress (see below)                                                                                         | ≥ 5.0 for user_notif |

Division of labor in `gate`: Landlock is the coarse, race-free fence
(nothing outside roots is reachable at all); the notify gate is the precise
policy oracle (deny-listed paths _inside_ roots become promptable rather
than hard-denied; connect becomes a decision; exec becomes auditable).
Gate stacks the fence whenever Landlock is available; without it, gate still
enforces via the trap set alone (out-of-root writes default-deny; the TOCTOU
bounding below weakens -- noted honestly, not papered over).

`static` is the recommended floor for anyone who won't pay the
interactivity. All modes: Linux x86_64 only (`denied-syscalls.ts` pins x86_64
syscall numbers; `capabilities.ts` refuses other archs). arm64 definitions
are a follow-up, not v1.

### The gate trap set

Trap set (built from `GATE_TRAPPED_SYSCALLS` in `denied-syscalls.ts`;
`launcher.c` defines `#define NR_<name> <nr>` per entry, pinned equal by
golden greps in `capabilities.test.ts` so TS and C cannot drift):

- write-opens: `openat` (only with `O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND`
  = 1603, checked in BPF), `creat` (legacy), `openat2` **unconditionally**
  (its flags live in a child-memory `struct open_how` invisible to BPF; the
  supervisor reads the struct over /proc and CONTINUEs read-only opens,
  denying unreadable ones fail-closed),
- entry/destruct ops: `truncate`, `unlink`/`unlinkat`, `rmdir`,
  `mkdir`/`mkdirat`, `mknod`/`mknodat`, `symlink`/`symlinkat` (the ENTRY is
  the operation; the target string is inert until an open, and every open is
  itself trapped), `link`/`linkat` (inode aliasing -- BOTH endpoints are
  classified, closing the "hardlink the deny-listed file into scratch, then
  open the alias" exfil), `rename`/`renameat`/`renameat2`,
- egress: `connect`, `sendto`, `sendmsg`, `sendmmsg` (connectionless sends
  are egress; "connect blocked" alone is not),
- `execve`: trapped for audit only -- allowed always in v1 (see Policy
  defaults).

The legacy twins are not optional: x86_64 keeps `creat`/`truncate`/`unlink`/
`rmdir`/`rename`/`link`/`symlink`/`mkdir`/`mknod` next to every `*at`
variant, and glibc uses the legacy forms. Each addition was a _measured_
deny-list bypass in review rounds, regression-tested with raw-syscall probes
(`tests/utils/sysbox/gate-integration.test.ts`).

`sendmsg` has one carve-out: the helper's control-socket fd (the SCM_RIGHTS
fd-pass happens pre-exec; trapping it unconditionally deadlocks the
handshake). The fd is matched by number in the filter, is never closed, and
post-exec reuse cannot occur because the filter installs after connect.
`ftruncate` needs no trap: a writable fd can only come from a trapped
write-open.

## TOCTOU and the fd-injection problem

A notified `openat` cannot be resolved by "supervisor checks path, then lets
child open path": the child re-resolves, and a symlink swap between check and
open defeats it (same class of bug `workspace.ts` defends against). The
textbook fix -- supervisor opens and injects the fd -- is **not supported**
by USER_NOTIF: `NOTIF_SEND` returns a value or errno, not an fd
(`pidfd_getfd` imports fds _into_ the caller, not into the target; ptrace
arg-rewriting is rejected -- the sandbox could ptrace-back and the perf cost
is untenable).

The design bounds the race instead of eliminating it, and says so:

1. Everything outside the Landlock fence is unreachable at kernel level, so
   gate decisions only ever concern paths inside the sandbox's own write
   surface. A race there can only move the sandbox's own bytes around.
2. Gate-side path decisions reuse `Workspace.resolveSafe` (same semantics as
   the file tools: containment, symlink, and deny-list checks), fed by
   /proc-resolved `(dirfd, path)` pairs (`procfs.ts`, including `/dev/fd/N`
   and `/proc/<pid>/fd/N` expansion).
3. Approve-then-continue races on paths _inside_ the fence are accepted,
   with the ceiling written down: an adversary that already has write access
   to the workspace can rename between approval and open. This is not a
   malicious-code design target; it is a wrong-turn design target.
4. Deny-listed paths inside roots are never fence-allowed past the trap set:
   every write-class syscall touching them notifies; policy denies by
   default, a human may allow per-op. The rename race against a deny-listed
   target requires the adversary to have written the symlink into a directory
   hotdog approved writes for -- at which point hotdog's model is already
   "the user allowed this area to change."

`execve` approval has the same accept-the-race status for the binary path.
Noted as a known ceiling, not fixed.

## Supervisor loop liveness

The notify fd is pollable, which keeps the loop event-driven. The supervisor
is a per-spawn Bun Worker (`sup.ts`): gate polling and the notify ioctls are
blocking FFI and must never block the agent's main loop. The notify fd never
crosses threads by number -- the helper passes it over SCM_RIGHTS _into the
worker thread_ via the abstract socket (`@hotdog-sbx-<pid>-<seq>`), so no
fd-number contract is needed.

Protocol (main thread does ALL parsing; the worker is a thin ioctl pump):

```
 -> {type:"start", gateName}          <- {type:"ready" | "fatal", why}
 <- {type:"notify", id, pid, nr, args[6]}   (u64s as decimal strings)
 -> {type:"resp", id, error, val}     error: 0 allow (CONTINUE) | -errno deny
 <- {type:"log"|"closed", ...}        -> {type:"stop"}
```

- Every notification must be answered. `NOTIF_ID_VALID` before `NOTIF_SEND`;
  if invalid (child died / syscall canceled), drop. Allow responses set
  `SECCOMP_USER_NOTIF_FLAG_CONTINUE` (without it the kernel fakes the return
  value and the real syscall never runs).
- Per-id deadline (60 s) answers `-EINTR` on expiry, so a never-seen prompt
  cannot wedge the agent loop or the child. Decisions are pipelined: the
  recv loop never awaits one before taking the next (awaiting inline
  serialized the whole child behind one decision and made the storm cap
  unreachable).
- Agent cancel maps to: pending approvals resolve toward deny (one
  AbortController per execute; `finish()` -- exit/timeout/kill -- aborts it),
  supervisor `stop` flushes outstanding decisions to `-EINTR`, worker
  terminated on child close.
- Storm cap: outstanding capped at 64; further notifications are answered
  `-EAGAIN` in the worker with a single log line per storm. Measured: 100
  parallel deny-listed writers produce exactly one storm log line, ≤64
  forwarded asks, ≥36 immediate EAGAINs.
- Auto paths stay prompt-free and fast: 50 in-root writes through the full
  supervision loop measure ~1.8 ms/write wall time including spawn.

## Policy defaults (gate mode)

`policy.ts` is a pure TS oracle (no kernel, no /proc), unit-tested in
`gate-policy.test.ts`. Notifications arrive with resolved absolute paths.

- Inside workspace roots, not deny-listed: allow (fast path).
- Deny-listed (`workspace.deny` / `DEFAULT_DENY_PATTERNS` oracle, reused
  unchanged via `resolveSafe`): ask; unresolved asks deny.
- Outside every root: ask -- except scratch (`/tmp`, `/var/tmp`, `$TMPDIR`)
  and `/dev/null`-style sinks, which allow (TOCTOU §3 ceiling: the sandbox's
  own write surface).
- rename/link: both endpoints must pass; deny beats ask beats allow.
- `connect`/sends: deny in v1. Egress proxy reusing fetch-tool's
  `assertPublicHost` is future work. Rationale: IP-level approval is theater
  for the same DNS-rebinding reason the fetch tool already documents; deny
  honestly rather than gate misleadingly.
- `execve`: allow, log (audit for session review). Approval gating exec is
  deliberately out: approval fatigue is what killed every Janus descendant.

### Human approvals (`SANDBOX_GATE` + `user-gate`)

`bash-tool` runs the `HOOKS.SANDBOX_GATE` pipeline for `ask` decisions,
`failOnError: true` (a throwing handler denies; mirrors the `TOOL_CALL`
gate). The payload carries the question-tool UI seam (`input`, straight from
the ToolContext) plus a per-spawn `signal`. The `user-gate` extension is a
pure hook handler over that seam: one question per ask through the existing
question plumbing (interactive CLI, websocket bridge), serialized
process-wide; an ask whose child died while queued denies without prompting.
Unresolved asks stay fail-closed: no input, non-interactive session, a
throwing/rejecting UI, an empty answer, or an aborted prompt all deny. No
remember-answers, no cache, no new config beyond `userGate.enabled`.

## Invariants (fail-closed list)

1. Requested mode unavailable (kernel, arch, `--no-ffi-cc`, cc() failure) →
   `ConfigError` at startup, never a silent downgrade to unsandboxed spawn.
   (`resolveSandboxMode` + the capability matrix from `capabilities.ts`,
   surfaced by `hotdog info`.)
2. A gate handler that throws → deny.
3. Every notification answered, or the child killed; no path leaves a thread
   blocked in a kernel transition waiting on us.
4. The hotdog process never installs a filter. Only the helper, pre-exec.
5. `launcher.c` sha256 logged at first use, included in `hotdog info`.
6. `fence`/`gate` without a workspace on the tool context → refuse to run
   (a fence without roots is not a fence).

## Known ceilings (deliberate, documented)

- **The deny list is write-integrity, not confidentiality.** In-root
  deny-listed _reads_ are ungated in every mode (the open trap mask is
  write-flags only; fence covers out-of-root reads). `cat .env > /tmp/copy`
  succeeds in-sandbox; egress is blocked, but the content remains reachable
  into tool output. The file tools' deny list DOES bind reads -- the
  asymmetry is documented in `docs/config-reference.md`.
- **Parent-process memory under Yama <= 1.** The deny table blocks `ptrace`,
  `process_vm_readv`/`process_vm_writev`, and `pidfd_getfd` -- but Yama scope <= 1 (the common
  distro default) also grants a descendant ancestor access through plain `open("/proc/<ancestor>/mem")`,
  which is a read-openat: untrapped in every mode (the fence mounts /proc read-only, gate's open mask
  is write-flags-only). On such hosts a sandboxed command can read hotdog's memory and environ (API
  keys included), bypassing even the fence's "home dirs unreachable" claim for secrets that live in the
  harness environment. seccomp cannot close this generically; gate could trap read-opens of
  `/proc/*/mem` in a future revision. v1 states it as a ceiling instead.
- Metadata-only syscalls (chmod/chown/utimensat/xattr family) still reach
  deny-listed paths unchanged: no content read, no entry creation, no
  aliasing. Out-of-root metadata ops stay fence-blocked (path traversal).
- `clone`/`clone3` are not denied (pthread creation needs them), so a
  sandboxed process may create a new `CLONE_NEWUSER`: a sandbox-within-the-
  sandbox with no extra reach into the host tree (Landlock cannot be
  escaped with capabilities gained after `restrict_self`, and seccomp
  follows the task).
- Landlock rights newer than the C rights table stay unhandled (= allowed)
  on future ABIs; unsupported rights are masked OUT from handled_access so a
  kernel predating a right can never EINVAL the ruleset.
- TOCTOU: approve-then-continue races inside the fence (§3 above).

## Kernel facts learned the hard way

Recorded so the next reader does not re-learn them expensively:

- Fork from multithreaded bun/JSC is unusable (measured); install-on-self + exec in a dedicated helper sidesteps the entire fork-safety class.
- `SECCOMP_FILTER_FLAG_NEW_LISTENER | TSYNC` is EINVAL on current kernels. Static mode uses TSYNC (deny-only, no listener); gate mode does not.
- BPF placement: RET ERRNO/NOTIFY must sit at the tail so default fallthrough lands on ALLOW, and the `openat` write-flags JSET must never
  sit on a fallthrough path -- `poll(timeout=200)` and `write(count=13)` share bits with `OPEN_WRITE_MASK` and a misplaced JSET NOTIFY-traps them,
  wedging the task ("install hangs" bug).
- `NOTIF_RECV` requires the whole 80-byte buffer zeroed on reuse (`check_zeroed_user`). Buffer is `seccomp_notif` with the embedded
  `seccomp_data`: `id@0, pid@8, nr@16, args@32`.
- Landlock: a rule giving directory-only rights to a non-directory EINVALs (mask by `fstat`); x86_64 `fstat` writes the full 144-byte `struct stat`
  regardless of the caller's struct (a short buffer is a stack smash, not a truncation); `ruleset_attr` is 8 bytes pre-ABI-4, 16 from there; landlock
  syscall numbers (444-446) are arch-generic.
- `/proc/sys/kernel/seccomp/actions_avail` lies for gate: container's outer seccomp profile can list `user_notif` yet EPERM the NEW_LISTENER flag,
  so availability is decided by a real install probe (a filter trapping nothing, raw-exit 0 on success -- a filtered process must never return to bun shutdown code).
- `sbx_fence_probe` (ABI query + ruleset create/close, never restricts) is side-effect-free, so a normal exit is safe there.
- Bun `node:child_process` stdio mis-wires under full-suite fd pressure: a spawned child can get fd1/fd2 pointing at the same socketpair end (writes
  EPIPE/EIO). Repros ~1/3 only in single-process `bun test` of the whole suite; fresh spawns and `--parallel` (the repo's `bun run test`) are
  clean. Upstream (bun 1.3.14) -- do not run the full suite single-process on hotdog CI. Coverage instrumentation (`bun run coverage`) reproduces
  the same early-spawn deaths even with `--parallel` (measured: ~2 of 5 full-suite runs; victim varies across the sandbox suites, child dead within
  ~20-40 ms of spawn, exit before the command runs). A sandbox test failing that way under coverage is the upstream flake, not a policy
  regression -- re-run and check the timing before believing it.

## Future work (not built)

- `overlay` mode: userns/bind/overlayfs writable scratch upper with reviewable diff-on-exit; all network via an egress proxy reusing
  fetch-tool's `assertPublicHost` (IP-level approval is the wrong gate).
- arm64 syscall tables.
- Per-child policy (e.g. subagents at `fence`, main agent at `gate`) -- deferred until a real use exists; mode is global per the no-speculative-flags rule.
- Flipping the default from `off` -- `static` passes the full suite at zero measured overhead, but the default change wants real-session mileage, not one CI-shaped run.
