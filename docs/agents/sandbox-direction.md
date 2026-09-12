# Sandbox direction -- enforcement loci, fence's ceiling, gate's failure anatomy

Conceptual notes, starting with naming the axes that decide sandbox design, then current modes and the alternatives (bwrap, podman/docker), and records of what we learned first-hand.

Status while reading: `off | static | fence` are live (docs/sysbox-sandbox.md). Landlock-net
is shipped, `gate` is **deleted**, and the mount view is design-only. The dynamic surface gate lost
has been rebuilt above the spawn boundary -- tool-call approvals in `user-gate`
(docs/config-reference.md "userGate"), on `HOOKS.TOOL_CALL`, opt-in. Sections about gate are a
post-mortem, not a spec; the kernel facts it cost us are in the appendix at the end.

## The framing: where does enforcement live, and how does it fail?

Every sandbox is a policy-evaluation point standing between an action and its effect.

1. **Where is the evaluation point?**
   The syscall boundary, the filesystem protocol boundary, the mount-view boundary, or a different kernel entirely.

2. **What happens when the enforcement machinery itself fails?**
   A sandbox's real quality is mostly its failure taxonomy:
   - *wedge*: task frozen forever (USER_NOTIF with a dead supervisor),
   - *destructive release*: kernel sweeps frozen tasks with ENOSYS when the notify fd's last reference drops (observed first-hand, see 3),
   - *silent allow*: policy skipped because mechanism raced,
   - *benign error*: I/O fails with EIO/EAGAIN, nothing is unlocked,
   - *complete teardown*: kill the outermost process, kernel reclaims all of it (PID namespace + die-with-parent, or whole VM).
3. **Who is the Trusted Computing Base (TCB)?**
   Same-kernel designs (seccomp, Landlock, namespaces) trust the kernel and your policy table.
   VM designs trust KVM plus a device model, and get to treat the kernel as hostile. Neither is "safe"; they fail on different timescales. Seccomp-table design fails on the timescale of a distro kernel update. VM design fails on the timescale of a qemu CVE.

A useful health indicator, from this session: **count the capability probes.**
Gate needed six (actions_avail, NEW_LISTENER install, pidfd_getfd import, landlock ABI, compiler presence, cgroup delegation).
bwrap needs one (can I create a user namespace?). A mode whose availability matrix rivals its enforcement matrix is a mode that will mostly not run --
and the least-running mode is the least-tested one. What survives gate is two probes (seccomp errno action + Landlock ABI), plus
the non-fail-closed cgroup delegation probe.

The `gate` suite skipped on containers and, until the cgroup-parent fix, skipped its DoS half on every systemd host (including bare metal).

## Fence: what it is good at, and exactly where it stops

Fence (Landlock) is the only mode whose policy is **installed once, then enforced by the kernel with no userspace participants**.
That is the architectural strength worth keeping: after `seccomp`/`landlock` calls, there are zero decision points left in hotdog's process.
Nothing can race, leak an fd, or die. Landlock is also *additive* (stacked rulesets only restrict); fence composes with anything else a host layers on.

Fence's hard ceilings, in order of how much they cost us:

- **Landlock cannot deny a path inside a granted tree; it can only bound access at directory granularity.**
  The deny-list (`.env`, `.git/hooks`, shell rc files) is therefore invisible to fence -- a file the uid may read inside an allowed root stays readable. Syscall-level policy (`gate`) existed in this repo mostly because Landlock has no answer to "everything in the workspace except these files"; gate is deleted, so that gap is open again rather than moved.
- **No view control.**
  Sandbox sees the host's `/proc`, the same paths, the same symlinks. Scratch `/tmp` is shared with the whole machine (collision names in tests are a symptom). Concretely still open today: `/proc/kcore`, `/proc/kpage*`, `/dev/mem|kmem|port`, and `/dev/pts/N` (the terminal the harness is attached to) sit inside the read-only mirrors, and Landlock cannot subtract them.
- **Network**: handled now, by ABI.
  The ruleset sets `handled_access_net` to every net right the running ABI knows with **zero allow rules**: TCP bind+connect from ABI v4 (kernels ~6.7+), UDP bind + connect_send from ABI v10. `hotdog info` prints which (`net: tcp bind+connect denied +udp` on an ABI-10 host, `net: unhandled` below v4), and the bit numbers are pinned by behavior probes rather than by doc trust -- the plan guessed UDP at bits 8/9 and this kernel put them at 2/3. It doesn't do domains, raw sockets, or unix sockets (scope rights at ABI v6 are deliberately left unhandled); it does turn "no exfiltration to the network" from a syscall-table game into a stacked-ruleset property.

The central idea for the next step of fence: **deny as absence, not as error.** (Design only -- not built; see "Availability of the view" below.)
Most of what gate enforced per-syscall could be *built into the filesystem view before exec*, in the pre-exec window the launcher already has:

- over-mount deny-listed files with an empty tmpfs. the file is *absent* to the sandbox --
  stronger than openat-time denial: no read, no stat size oracle, no race window between path resolution and policy);
- assemble the root from bind-mounts: workspace rw, system ro, everything else simply not there --
  which is also a mount-escape answer, because a symlink can't resolve to a path the view doesn't contain;
- then stack Landlock on top as the second, monotone layer (bounds writes to the roots even if the view is later remounted by
  something inside a nested userns), Landlock-net for egress, and the per-spawn cgroup caps that now actually apply on systemd hosts.

The result keeps fence's invariant (all policy installed pre-exec, kernel enforces, zero decision points live) and absorbs gate's *static* policy
surface: deny-list, egress, paths. What it structurally cannot absorb is gate's *dynamic* surface -- asking a human mid-command. See the failure-mode
note in the next section: the mediation point has to move or die.

**Availability of the view (measured, and the reason it is still design).** The whole design costs one
boolean: can this process create a user namespace? On the dev host yes (`unshare -Ur --mount` + tmpfs +
write works). In this workspace container it is EPERM -- docker's own seccomp profile refuses
`unshare(CLONE_NEWUSER)`, and `clone3` returns ENOSYS -- even though `/proc/sys/kernel/unprivileged_userns_clone=1`
and `max_user_namespaces=60851`. So on the machine most automation runs on, a view-based fence would be a
per-spawn degrade with a warn, and its enforcement tests could only ever skip. Build it where a real host is
available, and make the degraded host visible (`hotdog info`, one warn), never silently different.

## Gate: anatomy of the flakiness, not just this bug (post-mortem -- mode deleted)

The storm hunt (frozen tasks woken with "Function not implemented" while the supervisor's own fd watchdog insisted everything was fine)
is not one bug; it is the mode's shape. What is structurally wrong:

1. **A userspace process is on the enforcement path.** Correctness =
   the distributed protocol among helper, worker thread, kernel notify state,
   and the JS bus: fd lifetimes (pidfd_getfd import, CLOEXEC on the child
   side, the *process-wide* "last reference" bookkeeping for a file the
   supervisor doesn't own), thread lifetime (terminate() skips cleanup),
   message ordering, and shared scratch buffers. Every class of flake lives
   in one of those seams. The kernel's own semantics under load were a
   moving target underneath all of it: USER_NOTIF waits are *interruptible*
   by default (signals → syscall restart → fresh notification), ID_VALID
   errno drifts across kernel versions (ENOENT vs EBADFD), and releasing the
   notify file **sweeps every frozen task with ENOSYS** -- so the destruction
   path for a wedged sandbox is destructive-by-design. We were one closed-fd
   bug away from the sandbox silently becoming a policy-bypass generator,
   and closed-fd bugs are invisible to fd-owning code.
2. **The deny-list is an enumeration problem over the x86_64 syscall table,
   and enumerations don't end.** Every review round this repo ran found
   another bypass: round 2 (`creat`/`truncate`/`link`), round 3 (`sendmsg`
   fd-number carve-out), then `openat2`, legacy `unlink`/`rename`,
   `sendto`/`sendmmsg`. Each effect (open, unlink, rename, send, symlink,
   link) has several syscall spellings per arch. This is a fuzzer's game, and
   the fuzzers are kernel CVE trackers with more time than us.
3. **Path reconstruction is a second kernel in userspace.** `resolvedPath`
   read frozen task memory over dirfd chains and mirrors to decide what a
   path *means*; the TOCTOU/alias-laundering sections it needed were long
   because that mirror is hard to keep consistent. Policy that must
   re-derive the kernel's view of a path will always be a step behind it.
4. **Policy duplication is baked in.** The read fast path needed a `fastPolicy`
   snapshot that "MUST match" the main decider. Two evaluators of the same
   oracle, kept in sync by convention, is drift waiting to happen -- and the
   duplication existed only because a 2ms main-thread round trip per `openat`
   would otherwise dominate normal workloads.
5. **Availability roulette.** NEW_LISTENER is blocked under common container
   seccomp profiles; nested hotdog blocked pidfd_getfd import; on macOS the
   whole mode doesn't exist. So the most complex mode was also the one most
   likely to be running zero hours, tested deterministically by nobody.

Fix directions, ranked by honesty:

- **Demote or delete (this is what was done).** `gate`'s static policy (paths,
  secrets, egress) moves to fence-view -- egress shipped as Landlock-net, the
  deny list still unbuilt; its dynamic policy (approvals) moves *above the spawn
  boundary*: the human approves the command, its declared mounts, and its net
  posture before it runs, never mid-syscall. (Built, at the coarser tool-call
  granularity: `user-gate` on `HOOKS.TOOL_CALL`. Mounts and net posture are not
  part of it -- that shape waits on fence-view.) Approval UX welded to the syscall
  seam means that whenever the mechanism degrades, the product degrades.
- **If mediation must be live, move it to a protocol boundary.** A
  policy-aware filesystem *server* (the 9p/virtiofs shape VMs use) is the
  same idea as gate -- every open passes a userspace decider -- but its
  failure mode is benign by construction: server death = EIO on I/O, never a
  frozen task, never a destructive sweep. There is no kernel state that
  outlives the connection. "Which mediation boundary has safe failure modes"
  is the question gate failed and 9p passes.
- If USER_NOTIF is kept at all, keep it **off** the enforcement path: audit
  and observability (execve logging), where dropping notifications is fine.

## bwrap: namespaces as a view, one small binary

The concept: `bwrap` builds the filesystem *view* in an unprivileged user + mount namespace, then execs you into it.
There is no daemon, no state, no supervisor -- it is a single exec that assembles bind-mounts, tmpfses, and namespaces and then disappears.
The isolation model is exactly "fence's view idea", preassembled by someone else:

- **Deny-as-absence for free**: `--tmpfs` over `~/.ssh`, simply not binding `$HOME`; hotdog's secret model ("don't export it") maps directly.
- **Fresh scratch**: tmpfs `/tmp` per spawn. Host-scraped-test-pollution and cross-run collisions stop being a category.
- **Complete teardown**: a PID namespace plus die-with-parent semantics means killing the outer process reaps the whole tree in the kernel.
  The daemonized-leftover-keeps-cgroup-busy failure (our rmdir-retry dance) and the "helper's children escaped tracking" problem stop existing --
  the namespace is the lifetime.
- **Net is boolean**: `--unshare-net` gives literally no connectivity, which beats a deny-list of socket syscalls.
  The cost: there is no filtered net -- "allow this proxy only" has to come back as env-var convention plus a proxy outside the sandbox.
- **Composition over competition**: bwrap and Landlock stack (the view is the coarse bound, Landlock the monotone inner bound);
  cgroup caps still apply from outside; the launcher's seccomp ERRNO table still fits inside.
  bwrap replaces gate's *view* ambitions while fence++ keeps its enforcement invariant.

Where bwrap does not get you: file-granular policy *inside* a shared mount
(the workspace is one bind; `.env` inside it needs an inner over-mount -- possible per-file, but the deny-list becomes a mount list),
and any dynamic approval (same answer as fence: move it above spawn).
Availability: unprivileged userns is a distro toggle (on by default on Arch and GH runners, restricted on Debian, per-policy on RHEL);
inside a container without the right privileges, nested userns is often refused -- same skip-on-container class of story as today,
but with one boolean probe, and the failure is visible at startup rather than as a 3am notify-fd race.

The risk model is straightforward enough: bwrap exists to run untrusted desktop apps; its attack surface is the kernel plus a ~5k-line
exec-only binary with no SUID on modern kernels.
Compare firejail, same primitives but SUID legacy and an opaque seccomp denylist: strictly the worse wrapper for this design.

## podman/docker: the same kernel, plus an ecosystem

Conceptually containers land on the *view* locus like bwrap -- namespaces, cgroups, bind-mount tables as policy.

Additions:

- **The environment becomes an asset.** An image pins the toolchain, so commands cannot pollute or read the host's `/usr` at all,
  and "the build box" is reproducible. No fence/gate design gets this: they sandbox host binaries against host files.
  This is the real product-level difference.
- **Limits are first-class and boring**: memory, pids, cpu -- the DoS story as CLI flags instead of delegation archaeology.
- **Mount-as-policy is user-literate**: people understand "the secret is not in the mount table". That translates to enforcement strength too.

The subtractive truth: **rootless podman's isolation is bwrap's isolation**
(same kernel shared with the hostile process, same namespaces, crun/runc under the hood with a larger codebase and a CVE history to match),
plus -- for docker -- a root daemon whose socket is a local-root oracle on shared machines.
If the threat model is "the model wrote adversarial bash," a container buys ecosystem and ergonomics, not a stronger kernel boundary than
fence++/bwrap. Per-spawn latency (~100-300ms) and image/GC state management are real, just ops-cost ones.

The wall they share with every same-kernel design: **mount granularity is a path.**
Bind-mount the workspace and everything inside it, `.env` included, is visible; excluding one file inside a bound tree requires
overlay trickery or a copy (with the staleness race as a feature). File-granular policy on a shared tree needs a mediator
(gate, or a 9p-style server), which is precisely the locus containers delegate away.

## Cross-cutting principles, the parts worth keeping

- **Enforcement installed pre-exec or not at all.** Every live userspace decision point is a future race condition we'll get a bug report for.
  If a decision must be live, it belongs where its failure is an I/O error, not a frozen task or a swept set. Failure modes are a design property, not an implementation detail.
- **Deny as absence beats deny as error.** Not exporting a secret, not binding a path, tmpfs over a file -- all strictly stronger than
  "openat will return EACCES," because absence has no race window, no stat oracle, and no spelling variants.
- **Syscall deny-lists are a bottomless pit; prefer allow-listed *views* and cap-shaped kernel features** (Landlock, namespaces, cgroups, landlock-net).
  The kernel's feature APIs encode one enforcement point each; deny tables encode one per syscall per arch.
- **Approvals are a spawn-time product surface.** Human policy ("may this command run, with what mounts, with net or without")
  belongs above the process boundary. Welding UX to a syscall-supervisor couples product reliability to kernel ABI drift.
- **The locus ladder, final form**: view (namespaces+Landlock) for the static policy we have today;
  protocol server (9p/virtiofs) if file-granular dynamic mediation is ever genuinely needed;
  VM (qemu/firecracker) if the kernel itself leaves the TCB ever becomes the requirement.
  Gate tried to put the mediator at the syscall seam, which is the one locus where the kernel conspires with the race.

## Appendix: kernel facts bought by the deleted USER_NOTIF gate

`sup.ts`, `procfs.ts`, `policy.ts`, the `user-gate` extension and their four suites are gone. What
follows is what they cost -- mostly properties of the kernel or of bun, not of code that no longer
exists, so they survive the deletion here instead of in a doc for a mode nobody can run.

### seccomp USER_NOTIF

- Releasing the notify fd's **last reference sweeps every frozen task with `ENOSYS`**. There is no
  clean teardown of a wedged supervisor: destroying the mediation destroys the state of everything
  waiting on it. Observed as frozen commands waking with "Function not implemented" while the
  supervisor's own fd watchdog insisted the fd was alive.
- USER_NOTIF waits are **interruptible by default**. A signal to the frozen task restarts the syscall
  and produces a *fresh* notification, so "one notification per syscall invocation" is false under
  load, and answering the first copy after a restart executes the syscall twice.
- `NOTIF_ID_VALID` errno drifts across kernel versions (`ENOENT` vs `EBADFD`) for one condition:
  "this notification no longer exists". Code that switches on the errno instead of "any error -> drop"
  breaks on a kernel update.
- Every notification must be answered or the task stays frozen, and the only safe teardown is killing
  the task. So supervisor liveness (thread alive, per-id deadline answering `-EINTR`, `stop` flushing
  pending decisions) is on the enforcement path *by definition*, not by accident of implementation.
- `NOTIF_RECV` requires the whole 80-byte buffer **zeroed on reuse** (`check_zeroed_user`); a recycled
  buffer gets `EFAULT`. Layout: `seccomp_notif` = `id@0, pid@8, nr@16, args@32`.
- `NOTIF_SEND` returns a value or an errno -- **it cannot inject an fd**. That one limitation is why
  "supervisor checks the path, then lets the child open it" is a TOCTOU race with no textbook fix:
  `pidfd_getfd` imports fds *into* the caller, not into the target, and ptrace arg-rewriting means
  trusting the sandbox to ptrace back.
- `SECCOMP_FILTER_FLAG_NEW_LISTENER | TSYNC` is `EINVAL` on current kernels. A listener filter is
  per-thread, so it cannot cover the whole process, so whatever the sandbox's other threads do
  alongside the command is unsupervised.
- The notify fd arrives **`O_CLOEXEC`** (measured `fd_flags == 1` immediately after install), so it does
  not survive the helper's `execve`, and the ctrl socket needs `SOCK_CLOEXEC` for the same reason.
  Anything that must hold it across the exec imports it; it cannot inherit it.
- Reopening the notify fd through the child's fd table (`open("/proc/<pid>/fd/N")`) is `EACCES`. Not an
  alternate handoff path.
- **An fd number is not a capability.** Any predicate of the form "allow iff `args[0] ==` a number we
  know" is bypassable by `close` + reallocation. The round-3 `sendmsg` carve-out (which existed so the
  SCM_RIGHTS handshake could pass the notify fd) leaked a UDP datagram through a real spawn whose
  decider denied every other notification. Trap the syscall, or match on something the child cannot forge.
- The replacement handshake rides syscalls that stay untrapped: the helper `write()`s the notify fd's
  *number*, the supervisor imports the fd itself (`pidfd_open` + `pidfd_getfd`) while the child sits
  frozen at its trapped `execve` with its fd table intact, then verifies the imported fd is actually a
  notify fd (`readlink /proc/self/fd/N` contains `seccomp`; measured target `anon_inode:seccomp notify`).
  The verification is not paranoia: the `SO_PEERCRED` uid check proves *who* called, not *which of their
  fds* they named, and at `ptrace_scope` 0 a same-uid process that wins the `accept` can hand over
  another sandbox's notify fd -- at which point this supervisor is deciding another sandbox's frozen
  tasks. A non-notify fd dies on the first `NOTIF_RECV` (`EINVAL`) by accident; a foreign *notify* fd
  does not.
- `pidfd_getfd` is gated on the ptrace relationship, so a *self*-import proves nothing about the
  parent->child case; the probe had to spawn a real child and import from it. That is also the only way
  an outer policy ERRNOing 438 (hotdog inside hotdog) surfaces -- as an honest "gate unavailable" at
  startup instead of a spawn hanging forever in the handshake.
- Probe exit codes are a **contract** with the capability layer, because a probe reporting one code for
  every failure lies about the host: `0` = the import worked; `3` = **only** `EPERM`/`EACCES` from a real
  parent->child `pidfd_getfd`, i.e. a policy verdict; `4` = the probe could not run its own test at all
  (no compiler, no `/proc`, probe child died). Both fail closed, but only `3` may be reported as a
  kernel verdict. Before the split, a missing C compiler told the user "an outer seccomp policy blocks
  pidfd_getfd" -- a diagnosis they cannot check.
- Trapping `openat` unconditionally taxes every open with a round trip, which forced a second evaluator
  of the same policy inside the supervisor thread ("fast policy MUST match the main decider"). Two
  evaluators kept in sync by convention is drift waiting to happen; the duplication existed only because
  ~1.8 ms per read-open would tax every `ls` and every `dlopen`.
- Path reconstruction is a second kernel in userspace, and four alias rules had to be exactly right (each
  one was a measured bypass):
  - fd links (`/dev/fd/N`, `/proc/self/fd/N`) expand to their target, so policy judges the file rather
    than the alias;
  - magic links (`/proc/self/root/...`, `/proc/self/cwd/...`) expand **to a fixed point** -- the kernel
    re-follows `root` inside the remainder, so one hop leaves a `/proc/self/root/` prefix behind and the
    /proc read-only mirror then admits the real target (`/proc/self/root/proc/self/root/proc/self/root/etc/hostname`
    prints the hostname);
  - only **self-addressed** links expand. The readlink runs on the notifying task, so
    `/proc/<other pid>/fd/5` answers with *our* fd 5 -- deciding a different file than the kernel opens
    (measured: a read of pid 1's fd allowed as `anon_inode:[timerfd]`). Foreign prefixes stay as written
    and fail closed;
  - `..` collapses **after** expansion, never before, and the alias guard runs before any fold, at any
    depth: `/proc/self/cwd/../../home/u/.ssh/id_rsa` folds to the mirror-allowed
    `/proc/home/u/.ssh/id_rsa` while the kernel walks to `/` and reads the key, and with fd 3 ->
    `<ws>/a/b`, `/proc/self/fd/3/../../.env` folds to `/proc/self/.env` while the kernel opens
    `<ws>/.env`. Folding is what hid these from a fixed-point check -- after the fold the alias is gone
    from the string.
- BPF placement law (also in docs/sysbox-sandbox.md): a `NOTIFY`/`ERRNO` return belongs at the tail so
  default fallthrough lands on ALLOW, and an argument predicate must never sit on a fallthrough path --
  `poll(timeout=200)` and `write(count=13)` share bits with an open-flags mask, so a misplaced `JSET`
  trapped them and the install appeared to hang.
- A `NOTIFY` return off by one converts every trap into an ALLOW and the kernel accepts the program
  anyway (jump targets are validated, semantic intent is not). The suite passed with a completely broken
  filter until a behavior test installed the real filter with **no supervisor attached** and demanded
  that an untrapped syscall reach the end.
- A filter installed in a test-runner thread is inherited by that thread's spawned children with its
  listener still attached, so the children's own `NEW_LISTENER` install `EBUSY`s. Probe listener
  availability in a throwaway process, never in-runner.
- `/dev/tty` is not a `/dev/null`-style sink, and it is not quiet either: `bash -c` opens `/dev/tty` with
  `O_RDWR|O_NONBLOCK` on every startup (measured, bash 5.2 -- `/bin/sh` on a bash-default distro; CI's
  dash never does it). A policy that *asks* there raises one approval per command over a decision the
  kernel has already made (`ENXIO`, the spawn being its own session leader), and the first prompt of a
  session is the terminal rather than the file under test. Read-side, a spawn attached to a terminal
  captures what the human types into hotdog; write-side it forges output into the session that is
  approving the sandbox.
- Cross-process procfs needed one rule set, not two: hard-deny in the read class only let a foreign-pid
  open into the promptable class by adding write flags (`O_RDWR` is not a policy escape hatch), and the
  confidential family is `mem|environ|auxv|fd|fdinfo|maps|smaps|map_files|pagemap|syscall` in both the
  plain and `task/<tid>/` forms. `/proc/<pid>/fd/N` and `map_files/<range>` are the two that re-open
  *another process's* handles, which at scope 0 is read-anything over everything the harness holds open.
  Machine-wide surfaces (`/proc/kcore`, `/proc/kpage*`, `/dev/mem|kmem|port`) have no `<pid>` component,
  so a per-pid rule structurally cannot see them and the `/proc`+`/dev` mirror admits them wholesale.
- A string rule can be satisfied by a symlink the sandbox made inside its own rw root: `ws/x -> /proc/1/mem`
  is invisible to pathname rules until the resolution step flags the escape, at which point the *real*
  target has to be re-run through the deny families. Otherwise the prompt reads "read `<ws>/x`".

### bun, at the pin (1.3.14)

- `process.uid` is undefined; the peer-cred check takes our own uid from `getuid(2)` rather than
  comparing against JS.
- `child.stdio[N]` is a Stream with **no numeric `.fd`**, so a spawned child cannot announce anything to
  the parent over a stdio pipe synchronously. The import probe discovered the child's listener through
  `/proc/<child>/fd` instead -- and a parent that cannot read that table is precisely one where
  `pidfd_getfd` would fail anyway.

### Mount view, if it gets built

The facts the view design depends on, recorded because the C that would have used them never shipped:

- `uid_map`/`gid_map` name the uid the process has in the **parent** namespace, and they are written
  **after** `unshare(CLONE_NEWUSER)` -- by then the process's own `getuid(2)` answers 0. Capture the uid
  before the unshare.
- `setgroups=deny` is a prerequisite for the `gid_map` write.
- `mount("", "/", NULL, MS_REC|MS_PRIVATE)` before any tmpfs. Without it the tmpfs mounts **propagate
  onto the host's `/tmp`** through shared subtrees -- a sandbox escaping into the machine's scratch.
- Mount order is chicken-and-egg for a workspace under `/tmp`: `open_tree(AT_FDCWD, path,
  OPEN_TREE_CLONE)` while the path is still reachable, tmpfs over `/tmp`, then
  `move_mount(fd, "", AT_FDCWD, root)` onto the fresh tmpfs. After the tmpfs there is no way to name the
  original by path.
- Post-maps the task is root-in-ns with full caps, which can simply `umount` every mask. `capset` to
  all-zero (with `NO_NEW_PRIVS` already set) is what makes deny-as-absence stick: a nested
  `CLONE_NEWUSER` still gets root in its own namespace, but mounts made by an **ancestor** userns stay
  locked in the descendant's mount namespace.
- A view probe must run the real sequence on a throwaway scratch (unshare, maps, rprivate, tmpfs,
  `open_tree`+`move_mount`) and exit -- no restrictions left on the probing process, and no reuse of the
  probing process for anything else.
- Absence changes errnos callers see: a masked path is `ENOENT`, not `EACCES`. That is the point (no stat
  oracle, no spelling variants, no race window) and it is also what breaks naive callers.
