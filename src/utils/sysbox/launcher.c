/* hotdog sysbox launcher — seccomp filter install + exec, for the sbx-exec helper.
 *
 * Compiled in-process by the SANDBOX HELPER only (bun:ffi cc()/TinyCC), never
 * by the main hotdog process. The helper installs the filter on itself and
 * then execve's the target: there is no fork anywhere, because fork() from a
 * multithreaded JSC process corrupts state in ways no child-side discipline
 * can contain (measured on bun 1.3.14: random child deaths plus parent
 * shutdown segfaults). See docs/sysbox-sandbox.md.
 *
 * No libc/system headers assumed beyond stdint: TinyCC compiles this with
 * explicit prototypes only, so no linux-headers package needs to exist on the
 * host. Constants below are pinned Linux x86_64 ABI values; capabilities.ts
 * keeps this path unreachable on any other kernel/arch pair.
 */
#include <stdint.h>

long syscall(long number, ...);
int *__errno_location(void);
/* glibc syscall() returns -1 and sets errno (it does NOT return -errno);
 * every raw wrapper below converts through these or diagnostics lie. */
#define SYS_ERR() (-(long)(*__errno_location()))
#define SYS_RET(r) ((r) >= 0 ? (long)(r) : SYS_ERR())

/* ── x86_64 syscall numbers (stable ABI) ──────────────────────────────── */
#define __NR_write 1
#define __NR_execve 59
#define __NR_prctl 157
#define __NR_seccomp 317

#define PR_SET_NO_NEW_PRIVS 38
#define SECCOMP_SET_MODE_FILTER 1
#define SECCOMP_FILTER_FLAG_TSYNC 1
#define SECCOMP_FILTER_FLAG_NEW_LISTENER 8

/* ── classic BPF (linux/filter.h layout) ──────────────────────────────── */
struct sock_filter {
  uint16_t code;
  uint8_t jt;
  uint8_t jf;
  uint32_t k;
};
struct sock_fprog {
  uint16_t len;
  struct sock_filter *filter;
};

#define BPF_LD_W_ABS 0x20
#define BPF_JMP_JEQ_K 0x15
#define BPF_RET_K 0x06

/* seccomp_data offsets: nr @0, arch @4 (SECCOMP_RET_* values) */
#define OFF_NR 0
#define OFF_ARCH 4
#define AUDIT_ARCH_X86_64 0xC000003E
#define RET_KILL_THREAD 0x00000000
#define RET_ERRNO_BASE 0x00050000 /* | errno */
#define RET_ALLOW 0x7fff0000

#define EPERM 1

/* Program: reject any architecture that is not x86_64 (a foreign-ABI exec
 * would reinterpret struct sock_fprog and the syscall table); deny every
 * syscall passed in from TS with EPERM; allow everything else. */
#define MAX_DENY 96
static struct sock_filter g_prog[6 + 2 * MAX_DENY];

/* returns 0 on success, -errno on failure (caller has ~5 calls before exec) */
int32_t sbx_install(const void *deny_buf, int32_t deny_n) {
  if (!deny_buf || deny_n < 0 || deny_n > MAX_DENY) return -22; /* EINVAL */
  if (syscall(__NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return (int32_t)SYS_ERR();

  const int32_t *deny = (const int32_t *)deny_buf;
  int fi = 0;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_ARCH; fi++;
  g_prog[fi].code = BPF_JMP_JEQ_K; g_prog[fi].jt = 1; g_prog[fi].jf = 0; g_prog[fi].k = AUDIT_ARCH_X86_64; fi++;
  g_prog[fi].code = BPF_RET_K;     g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_KILL_THREAD; fi++;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_NR; fi++;
  /* RET ERRNO goes LAST so the default fallthrough (jf chains + exhausted
   * checks) lands on RET ALLOW. BPF jump target = PC + 1 + jt. */
  int err_at = 5 + deny_n;
  int i;
  for (i = 0; i < deny_n; i++) {
    g_prog[fi].code = BPF_JMP_JEQ_K;
    g_prog[fi].jt = (uint8_t)(err_at - fi - 1);
    g_prog[fi].jf = 0;
    g_prog[fi].k = (uint32_t)deny[i];
    fi++;
  }
  g_prog[fi].code = BPF_RET_K; g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_ALLOW; fi++;
  g_prog[fi].code = BPF_RET_K; g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_ERRNO_BASE | EPERM; fi++;

  struct sock_fprog fprog;
  fprog.len = (uint16_t)fi;
  fprog.filter = g_prog;
  long r = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, (long)&fprog);
  return r >= 0 ? 0 : (int32_t)SYS_ERR();
}

/* ── exec helper: unpack TLV and execve ───────────────────────────────── */
/* TLV: repeated [u32 LE len][bytes], each entry NUL-terminated inside len.
 * argv pack: item 0 is the executable PATH, items 1.. are argv[0..].
 * Returns only if execve fails: -errno. */

#define MAX_ARGS 16
#define MAX_ENV 256
#define MAX_FENCE_PATHS 64
static char *g_argv[MAX_ARGS + 1];
static char *g_env[MAX_ENV + 1];

static int unpack(const uint8_t *buf, int64_t len, char **out, int maxn) {
  int64_t off = 0;
  int n = 0;
  while (off < len) {
    if (off + 4 > len) return -22;
    uint32_t l = (uint32_t)buf[off] | ((uint32_t)buf[off + 1] << 8)
               | ((uint32_t)buf[off + 2] << 16) | ((uint32_t)buf[off + 3] << 24);
    off += 4;
    if (l < 1 || off + l > len) return -22;
    if (buf[off + l - 1] != 0) return -22;
    if (n >= maxn) return -22;
    out[n++] = (char *)(buf + off);
    off += l;
  }
  out[n] = 0;
  return n;
}

/* ── fence mode: Landlock ruleset ─────────────────────────────────────── */
/* The landlock syscall numbers are arch-generic (fixed 444-446 on every
 * arch, unlike most syscall tables). The ABI is probed at runtime via
 * CREATE_RULESET_VERSION -- nothing here hardcodes a kernel version, and
 * rights the running kernel predates are masked OUT of handled_access (an
 * unknown right would EINVAL the ruleset). Rights NEWER than the table
 * below stay unhandled (= allowed): documented gap, docs/sysbox-sandbox.md. */
#define __NR_openat 257
#define __NR_close 3
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#define LANDLOCK_CREATE_RULESET_VERSION 1
#define LANDLOCK_RULE_PATH_BENEATH 1
#define O_PATH_C 0x2000000
#define O_CLOEXEC_C 0x80000
#define ENOENT_C 2
#define EOPNOTSUPP_C 95

/* linux/landlock.h filesystem rights */
#define LL_FS_EXECUTE (1ULL << 0)
#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_READ_FILE (1ULL << 2)
#define LL_FS_READ_DIR (1ULL << 3)
#define LL_FS_ALL_V1 0x1FFFULL /* EXECUTE..MAKE_SYM (ABI 1) */
#define LL_FS_REFER (1ULL << 13) /* ABI >= 2 */
#define LL_FS_TRUNCATE (1ULL << 14) /* ABI >= 3 */
#define LL_NET_BIND_TCP (1ULL << 0) /* ABI >= 4 */

static uint64_t ll_fs_rights(int32_t abi) {
  uint64_t m = LL_FS_ALL_V1;
  if (abi >= 2) m |= LL_FS_REFER;
  if (abi >= 3) m |= LL_FS_TRUNCATE;
  return m;
}

/* ABI probe: side-effect-free (CREATE_RULESET_VERSION takes no ruleset).
 * Returns abi >= 1, or -errno (-ENOSYS: kernel without landlock;
 * -EOPNOTSUPP: landlock disabled at boot, abi == 0). */
int32_t sbx_fence_probe(void) {
  long abi = syscall(__NR_landlock_create_ruleset, 0, 0,
                     (long)LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return (int32_t)SYS_ERR();
  if (abi == 0) return -EOPNOTSUPP_C;
  return (int32_t)abi;
}

/* Packed kernel layouts (linux/landlock.h). ruleset_attr.net is only passed
 * when the ABI knows it (>= 4); older kernels EINVAL a size mismatch. */
struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};
struct ll_path_beneath {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

/* x86_64 struct stat is 144 bytes and the kernel writes all of it into the
 * buffer -- head fields only + padding to the full size (a short buffer is
 * a stack smash, not a truncation). */
struct fstat_head {
  uint64_t dev;
  uint64_t ino;
  uint64_t nlink;
  uint32_t mode;
  uint8_t _pad[116];
};
#define S_IFDIR_C 0x4000u

/* add a path_beneath rule for `path` (opened O_PATH here, closed on return;
 * rules outlive the fd). Returns 0 or -errno. Kernel EINVALs a rule that
 * gives directory-only rights (READ_DIR, REMOVE_*, MAKE_*, REFER) to a
 * non-directory, so rights are masked by fstat (e.g. the /dev/null sink
 * rules take WRITE|READ|TRUNCATE only). A failed fstat masks down (never
 * over-grants). */
static int32_t ll_add_beneath(int32_t rsfd, uint64_t rights, const char *path) {
  long fd = syscall(__NR_openat, -100 /*AT_FDCWD*/, (long)path,
                    (long)(O_PATH_C | O_CLOEXEC_C));
  if (fd < 0) return (int32_t)SYS_ERR();
  struct fstat_head st;
  long fr = syscall(5 /*fstat*/, fd, (long)&st);
  int is_dir = fr >= 0 && ((st.mode & 0xF000u) == S_IFDIR_C);
  if (!is_dir) rights &= LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE;
  struct ll_path_beneath attr;
  attr.allowed_access = rights;
  attr.parent_fd = (int32_t)fd;
  long r = syscall(__NR_landlock_add_rule, rsfd, LANDLOCK_RULE_PATH_BENEATH,
                   (long)&attr, 0);
  int32_t e = r >= 0 ? 0 : (int32_t)SYS_ERR();
  syscall(__NR_close, fd);
  return e;
}

/* Install the fence on this process: ruleset (rights masked to the runtime
 * ABI; NET_BIND_TCP handled with no allow rules => every TCP bind is
 * denied), one RW rule per rw path, one EXECUTE|READ rule per ro path, then
 * restrict_self. Rules persist across fork/execve. The fence is
 * allowlist-only: it cannot express workspace.deny (precise policy is
 * gate's trap set). MUST run before the seccomp install and after
 * prctl(NO_NEW_PRIVS) (done here; sbx_install repeats it idempotently).
 * rw paths are required (a missing workspace root is a config error, fail
 * closed); ro paths skip only on ENOENT (distro variation: /lib32 &co). */
int32_t sbx_fence_install(const void *rw_buf, int64_t rw_len,
                          const void *ro_buf, int64_t ro_len) {
  if (!rw_buf || !ro_buf || rw_len < 0 || ro_len < 0) return -22; /* EINVAL */
  if (syscall(__NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return (int32_t)SYS_ERR();

  long abi = syscall(__NR_landlock_create_ruleset, 0, 0,
                     (long)LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return (int32_t)SYS_ERR();
  if (abi == 0) return -EOPNOTSUPP_C;

  struct ll_ruleset_attr rattr;
  rattr.handled_access_fs = ll_fs_rights((int32_t)abi);
  rattr.handled_access_net = abi >= 4 ? LL_NET_BIND_TCP : 0;
  long rs = syscall(__NR_landlock_create_ruleset, (long)&rattr,
                    abi >= 4 ? 16 : 8, 0);
  if (rs < 0) return (int32_t)SYS_ERR();

  static char *rw_paths[MAX_FENCE_PATHS + 1];
  static char *ro_paths[MAX_FENCE_PATHS + 1];
  int nrw = unpack((const uint8_t *)rw_buf, rw_len, rw_paths, MAX_FENCE_PATHS);
  int nro = unpack((const uint8_t *)ro_buf, ro_len, ro_paths, MAX_FENCE_PATHS);
  if (nrw < 1) { syscall(__NR_close, rs); return nrw < 0 ? nrw : -22; }
  if (nro < 0) { syscall(__NR_close, rs); return nro; }

  uint64_t rwmask = ll_fs_rights((int32_t)abi);
  uint64_t romask = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  int i;
  for (i = 0; i < nrw; i++) {
    int32_t e = ll_add_beneath((int32_t)rs, rwmask, rw_paths[i]);
    if (e) { syscall(__NR_close, rs); return e; }
  }
  for (i = 0; i < nro; i++) {
    int32_t e = ll_add_beneath((int32_t)rs, romask, ro_paths[i]);
    if (e == -ENOENT_C) continue;
    if (e) { syscall(__NR_close, rs); return e; }
  }
  long r = syscall(__NR_landlock_restrict_self, rs, 0);
  syscall(__NR_close, rs);
  return r >= 0 ? 0 : (int32_t)SYS_ERR();
}

int32_t sbx_exec(void *argv_buf, int64_t argv_len, void *env_buf, int64_t env_len) {
  if (!argv_buf || !env_buf || argv_len < 0 || env_len < 0) return -22;
  int na = unpack((const uint8_t *)argv_buf, argv_len, g_argv, MAX_ARGS);
  if (na < 2) return -22; /* need exe + argv[0] */
  int ne = unpack((const uint8_t *)env_buf, env_len, g_env, MAX_ENV);
  if (ne < 0) return ne;
  long r = syscall(__NR_execve, (long)g_argv[0], (long)(g_argv + 1), (long)g_env, 0, 0, 0);
  return (int32_t)r; /* -errno; only reached on failure */
}

/* ── gate mode: USER_NOTIF listener + supervisor plumbing ─────────────── */
/* Filter: trap set -> SECCOMP_RET_NOTIFY (supervisor decides), static deny
 * set -> ERRNO, everything else ALLOW. Installed with TSYNC|NEW_LISTENER;
 * the returned listener fd is handed to the supervisor over an abstract
 * unix socket via SCM_RIGHTS (the notify fd must be able to cross into the
 * helper thread of the parent process without any fd-number contract). */

#define BPF_JMP_JSET_K 0x45
#define RET_NOTIFY 0x7fc00000
#define OFF_ARGS0 16 /* seccomp_data.args[0] low word (sendmsg fd) */
#define OFF_ARGS2 32 /* seccomp_data.args[2] low word (openat flags) */
/* O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND (OPEN_WRITE_MASK in
 * denied-syscalls.ts; pinned equal by capabilities.test.ts) */
#define OPEN_WRITE_MASK 1603
/* The trap set: names/numbers pinned exactly against GATE_TRAPPED_SYSCALLS
 * by capabilities.test.ts (#define NR_<name> <nr> is the drift pin).
 * The legacy path syscalls are NOT optional: x86_64 still has unlink(87),
 * rmdir(84), rename(82), renameat(264) next to their *at variants, and
 * glibc's unlink()/rename() use them; openat2(437) does everything openat
 * does. A review probe wrote through the deny list with each of them when
 * only the *at variants were trapped. openat2 is trapped UNCONDITIONALLY:
 * its flags live in a child-memory struct open_how, invisible to BPF; the
 * supervisor reads the struct over /proc and CONTINUEs read-only opens.
 * sendto/sendmsg/sendmmsg close the UDP hole: a connectionless datagram
 * leaves without ever calling connect, so "connect blocked" alone is not
 * an egress claim. Second review round added the create/link/truncate
 * family (measured deny-list bypasses: creat(85) wrote .env, truncate(76)
 * truncated it, link(86)/linkat(265) aliased it into allowed scratch):
 * x86_64 keeps a legacy twin for EVERY path operation, not just the
 * unlink/rename pair. ftruncate(77) needs no trap -- a writable fd can
 * only come from a trapped write-open. */
#define NR_connect 42
#define NR_sendto 44
#define NR_sendmsg 46
#define NR_execve 59
#define NR_truncate 76
#define NR_rename 82
#define NR_mkdir 83
#define NR_rmdir 84
#define NR_creat 85
#define NR_link 86
#define NR_unlink 87
#define NR_symlink 88
#define NR_mknod 133
#define NR_openat 257
#define NR_mkdirat 258
#define NR_mknodat 259
#define NR_unlinkat 263
#define NR_renameat 264
#define NR_linkat 265
#define NR_symlinkat 266
#define NR_renameat2 316
#define NR_sendmmsg 345
#define NR_openat2 437

/* returns listener fd >= 0, or -errno */
/* install the gate filter on this process. ctrl_fd is the connected
 * supervisor socket: sendmsg on THAT fd is the SCM_RIGHTS handshake that
 * hands the listener fd up, so it must be allowed; every other sendmsg (and
 * all sendto/sendmmsg) is trapped -- otherwise connectionless UDP egress
 * bypasses "connect blocked" (the review finding). The helper's own send_fd
 * is the only sendmsg it makes pre-exec, on ctrl_fd. Trapping sendmsg
 * unconditionally deadlocks: the fd-pass sendmsg traps before the supervisor
 * holds the notify fd, so nothing can answer it. */
int32_t sbx_gate_install(const void *deny_buf, int32_t deny_n, int32_t ctrl_fd) {
  if (!deny_buf || deny_n < 0 || deny_n > MAX_DENY) return -22; /* EINVAL */
  if (syscall(__NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return (int32_t)SYS_ERR();

  const int32_t *deny = (const int32_t *)deny_buf;
  int fi = 0;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_ARCH; fi++;
  g_prog[fi].code = BPF_JMP_JEQ_K; g_prog[fi].jt = 1; g_prog[fi].jf = 0; g_prog[fi].k = AUDIT_ARCH_X86_64; fi++;
  g_prog[fi].code = BPF_RET_K;     g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_KILL_THREAD; fi++;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_NR; fi++;
  /* openat is decided FIRST, entirely by its write flags, and read-only
   * opens fall through to their own ALLOW at [7]: every other syscall must
   * jump OVER the ld/jset block (jf=3). The flags check must never sit on
   * the default fallthrough -- measured on this kernel: poll(timeout=200)
   * and write(count=13) share bits with OPEN_WRITE_MASK and a fallthrough
   * placement NOTIFY-traps them, wedging the task ("install hangs" bug).
   * Then sendmsg is decided by its fd: the control-socket sendmsg (the
   * fd-pass) ALLOWs, any other sendmsg NOTIFYs. Layout for deny_n entries:
   *  [0..3]  arch guard + ld nr
   *  [4]  jeq openat     jt=0 -> [5], jf=3 -> [8]
   *  [5]  ld args2       [6] jset OPEN_WRITE_MASK -> NOTIFY(24+n), jf -> [7]
   *  [7]  RET ALLOW (read-only openat)
   *  [8]  jeq sendmsg    jt=0 -> [9], jf=3 -> [12]
   *  [9]  ld args0       [10] jeq ctrl_fd -> ALLOW(23+n), jf -> [11] NOTIFY
   *  [11] RET NOTIFY (sendmsg on a non-control fd)
   *  [12..32] jeq <the 21 unconditional traps> -> NOTIFY(34+n)
   *  [33..32+n] jeq deny_i -> ERRNO(35+n)
   *  [33+n] RET ALLOW | [34+n] RET NOTIFY | [35+n] RET ERRNO
   */
  const int allow_at = 33 + deny_n;
  const int notif_at = 34 + deny_n;
  const int errno_at = 35 + deny_n;
  g_prog[fi].code = BPF_JMP_JEQ_K; g_prog[fi].jt = 0; g_prog[fi].jf = 3; g_prog[fi].k = NR_openat; fi++;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_ARGS2; fi++;
  g_prog[fi].code = BPF_JMP_JSET_K; g_prog[fi].jt = (uint8_t)(notif_at - fi - 1); g_prog[fi].jf = 0; g_prog[fi].k = OPEN_WRITE_MASK; fi++;
  g_prog[fi].code = BPF_RET_K;     g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_ALLOW; fi++;
  g_prog[fi].code = BPF_JMP_JEQ_K; g_prog[fi].jt = 0; g_prog[fi].jf = 3; g_prog[fi].k = NR_sendmsg; fi++;
  g_prog[fi].code = BPF_LD_W_ABS;  g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = OFF_ARGS0; fi++;
  g_prog[fi].code = BPF_JMP_JEQ_K; g_prog[fi].jt = (uint8_t)(allow_at - fi - 1); g_prog[fi].jf = 0; g_prog[fi].k = (uint32_t)ctrl_fd; fi++;
  g_prog[fi].code = BPF_RET_K;     g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_NOTIFY; fi++;
  /* Every remaining trapped syscall targets NOTIFY directly. */
  static const uint32_t traps[] = {
    NR_unlinkat, NR_renameat2, NR_connect, NR_execve,
    NR_unlink, NR_rmdir, NR_rename, NR_renameat,
    NR_openat2, NR_sendto, NR_sendmmsg,
    NR_truncate, NR_creat, NR_mkdir, NR_mknod, NR_link, NR_symlink,
    NR_mkdirat, NR_mknodat, NR_linkat, NR_symlinkat,
  };
  int t;
  for (t = 0; t < (int)(sizeof(traps) / sizeof(traps[0])); t++) {
    g_prog[fi].code = BPF_JMP_JEQ_K;
    g_prog[fi].jt = (uint8_t)(notif_at - fi - 1);
    g_prog[fi].jf = 0;
    g_prog[fi].k = traps[t];
    fi++;
  }
  int i;
  for (i = 0; i < deny_n; i++) {
    g_prog[fi].code = BPF_JMP_JEQ_K;
    g_prog[fi].jt = (uint8_t)(errno_at - fi - 1);
    g_prog[fi].jf = 0;
    g_prog[fi].k = (uint32_t)deny[i];
    fi++;
  }
  g_prog[fi].code = BPF_RET_K; g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_ALLOW; fi++;
  g_prog[fi].code = BPF_RET_K; g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_NOTIFY; fi++;
  g_prog[fi].code = BPF_RET_K; g_prog[fi].jt = 0; g_prog[fi].jf = 0; g_prog[fi].k = RET_ERRNO_BASE | EPERM; fi++;

  struct sock_fprog fprog;
  fprog.len = (uint16_t)fi;
  fprog.filter = g_prog;
  /* NO TSYNC here (unlike static mode): NEW_LISTENER|TSYNC is EINVAL on
   * current kernels. Not needed for this process model -- post-exec
   * threads inherit the filter+listener by design (seccomp can_transfer),
   * and pre-exec bun threads run none of the command. */
  long r = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                   SECCOMP_FILTER_FLAG_NEW_LISTENER, (long)&fprog);
  return r >= 0 ? (int32_t)r : (int32_t)SYS_ERR();
}

/* ── unix socket + SCM_RIGHTS + notify ioctls ─────────────────────────── */
struct iovec_x { void *base; uint64_t len; };
/* x86_64 struct msghdr (natural alignment == kernel layout) */
struct msghdr_x {
  void *name; uint32_t namelen;
  struct iovec_x *iov; uint64_t iovlen;
  void *control; uint64_t controllen;
  int32_t flags;
};
struct pollfd_x { int32_t fd; int16_t events; int16_t revents; };
struct sockaddr_un_x { uint16_t family; char path[108]; };
/* one-fd SCM record, x86_64 cmsghdr layout: cmsg_len is size_t(8);
 * CMSG_LEN(4) == 20, CMSG_SPACE(4) == 24 (the control buffer wire size) */
#define SCM_CMSG_LEN 20
#define SCM_CMSG_SPACE 24
struct cmsg_fd_x { uint64_t len; int32_t level; int32_t type; int32_t fd; };

#define __NR_socket 41
#define __NR_bind 49
#define __NR_listen 50
#define __NR_exit_group 231
#define __NR_accept4 288
#define __NR_connect 42
#define __NR_sendmsg 46
#define __NR_recvmsg 47
#define __NR_poll 7
#define __NR_close 3
#define __NR_ioctl 16
#define AF_UNIX 1
#define SOCK_STREAM_C 1
#define SOL_SOCKET 1
#define SCM_RIGHTS 1
#define IOC_NOTIF_RECV 0xc0502100UL  /* _IOWR('!', 0, seccomp_notif: 80 bytes) */
#define IOC_NOTIF_SEND 0xc0182101UL /* _IOWR('!', 1, seccomp_notif_resp: 24 bytes) */
#define IOC_NOTIF_VALID 0x40082102UL /* _IOW('!', 2, u64) */

/* copy NUL-terminated `name` into an abstract-namespace sockaddr;
 * returns wire length or -36 (ENAMETOOLONG) */
static int set_un(struct sockaddr_un_x *a, const char *name) {
  int i;
  a->family = AF_UNIX;
  a->path[0] = 0;
  for (i = 0; i < 106 && name[i]; i++) a->path[1 + i] = name[i];
  if (name[i]) return -36;
  return i;
}

/* supervisor side: create + bind + listen an abstract-namespace stream
 * socket. Returns fd or -errno. */
int32_t sbx_gate_listen(const char *name) {
  struct sockaddr_un_x a;
  int n = set_un(&a, name);
  if (n < 0) return (int32_t)n;
  long fd = syscall(__NR_socket, AF_UNIX, SOCK_STREAM_C, 0);
  if (fd < 0) return (int32_t)SYS_ERR();
  long r = syscall(__NR_bind, fd, (long)&a, 2 + 1 + n);
  if (r < 0) { int32_t e = (int32_t)SYS_ERR(); syscall(__NR_close, fd); return e; }
  r = syscall(__NR_listen, fd, 4);
  if (r < 0) { int32_t e = (int32_t)SYS_ERR(); syscall(__NR_close, fd); return e; }
  return (int32_t)fd;
}

/* helper side: connect() to the supervisor's abstract socket (called
 * BEFORE the filter installs, so trapping connect cannot deadlock it).
 * Returns fd or -errno. */
int32_t sbx_gate_connect(const char *name) {
  struct sockaddr_un_x a;
  int n = set_un(&a, name);
  if (n < 0) return (int32_t)n;
  long fd = syscall(__NR_socket, AF_UNIX, SOCK_STREAM_C, 0);
  if (fd < 0) return (int32_t)SYS_ERR();
  long r = syscall(__NR_connect, fd, (long)&a, 2 + 1 + n);
  if (r < 0) { int32_t e = (int32_t)SYS_ERR(); syscall(__NR_close, fd); return e; }
  return (int32_t)fd;
}

int32_t sbx_gate_accept(int32_t lfd) {
  long r = syscall(__NR_accept4, (long)lfd, 0, 0, 0);
  return (int32_t)SYS_RET(r);
}

/* send one byte 'F' plus one fd (SCM_RIGHTS). Returns 1 or -errno. */
int32_t sbx_send_fd(int32_t sock, int32_t fd) {
  char tag = 'F';
  struct cmsg_fd_x cmsg;
  cmsg.len = SCM_CMSG_LEN; cmsg.level = SOL_SOCKET; cmsg.type = SCM_RIGHTS; cmsg.fd = fd;
  struct iovec_x io; io.base = &tag; io.len = 1;
  struct msghdr_x m;
  m.name = 0; m.namelen = 0; m.iov = &io; m.iovlen = 1;
  m.control = &cmsg; m.controllen = SCM_CMSG_SPACE; m.flags = 0;
  long r = syscall(__NR_sendmsg, (long)sock, (long)&m, 0);
  if (r < 0) return (int32_t)SYS_ERR();
  return r == 1 ? 1 : -71; /* EPROTO */
}

/* receive one 'F' byte plus one fd. Returns fd or -errno/-EPROTO. */
int32_t sbx_recv_fd(int32_t sock) {
  char tag = 0;
  struct cmsg_fd_x cmsg;
  cmsg.len = 0; cmsg.level = 0; cmsg.type = 0; cmsg.fd = -1;
  struct iovec_x io; io.base = &tag; io.len = 1;
  struct msghdr_x m;
  m.name = 0; m.namelen = 0; m.iov = &io; m.iovlen = 1;
  m.control = &cmsg; m.controllen = SCM_CMSG_SPACE; m.flags = 0;
  long r = syscall(__NR_recvmsg, (long)sock, (long)&m, 0);
  if (r < 0) return (int32_t)SYS_ERR();
  if (r == 0) return -104; /* ECONNRESET: helper died before sending */
  if (r != 1 || tag != 'F' || cmsg.fd < 0) return -71; /* EPROTO */
  return cmsg.fd;
}

/* poll(POLLIN) with timeout. Returns 1 readable, 0 timeout, or -errno. */
int32_t sbx_poll_in(int32_t fd, int32_t timeout_ms) {
  struct pollfd_x p; p.fd = fd; p.events = 1 /* POLLIN */; p.revents = 0;
  long r = syscall(__NR_poll, (long)&p, 1, (long)timeout_ms);
  if (r < 0) return (int32_t)SYS_ERR();
  return (p.revents & 1) ? 1 : 0;
}

int32_t sbx_close(int32_t fd) {
  long r = syscall(__NR_close, (long)fd);
  return (int32_t)SYS_RET(r);
}

/* ioctl wrappers for the notify fd. buf sizes: recv 80, id 8, resp 24
 * (buffers are built/read with a DataView on the TS side). */
int32_t sbx_notif_recv(int32_t fd, void *buf80) {
  long r = syscall(__NR_ioctl, (long)fd, IOC_NOTIF_RECV, (long)buf80);
  return (int32_t)SYS_RET(r);
}
int32_t sbx_notif_id_valid(int32_t fd, void *id8) {
  long r = syscall(__NR_ioctl, (long)fd, IOC_NOTIF_VALID, (long)id8);
  return (int32_t)SYS_RET(r);
}
int32_t sbx_notif_send(int32_t fd, void *resp24) {
  long r = syscall(__NR_ioctl, (long)fd, IOC_NOTIF_SEND, (long)resp24);
  return (int32_t)SYS_RET(r);
}

/* capability probe: install a real NEW_LISTENER filter that traps NOTHING
 * (a full trap set with no supervisor would block this process's own
 * openat/connect calls -- probe3 taught that the hard way). Success = the
 * kernel grants a listener fd: raw-exit 0 without returning to any
 * bun-shutdown path that would run under the filter. Failure returns
 * -errno (no filter remains installed on failure). */
int32_t sbx_probe_gate(void) {
  if (syscall(__NR_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return (int32_t)SYS_ERR();
  static struct sock_filter probe_prog[5];
  int fi = 0;
  probe_prog[fi].code = BPF_LD_W_ABS;  probe_prog[fi].jt = 0; probe_prog[fi].jf = 0; probe_prog[fi].k = OFF_ARCH; fi++;
  probe_prog[fi].code = BPF_JMP_JEQ_K; probe_prog[fi].jt = 1; probe_prog[fi].jf = 0; probe_prog[fi].k = AUDIT_ARCH_X86_64; fi++;
  probe_prog[fi].code = BPF_RET_K;     probe_prog[fi].jt = 0; probe_prog[fi].jf = 0; probe_prog[fi].k = RET_KILL_THREAD; fi++;
  probe_prog[fi].code = BPF_LD_W_ABS;  probe_prog[fi].jt = 0; probe_prog[fi].jf = 0; probe_prog[fi].k = OFF_NR; fi++;
  probe_prog[fi].code = BPF_RET_K;     probe_prog[fi].jt = 0; probe_prog[fi].jf = 0; probe_prog[fi].k = RET_ALLOW; fi++;
  struct sock_fprog fprog;
  fprog.len = (uint16_t)fi;
  fprog.filter = probe_prog;
  long r = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                   SECCOMP_FILTER_FLAG_NEW_LISTENER, (long)&fprog);
  if (r < 0) return (int32_t)SYS_ERR();
  syscall(__NR_close, r);
  syscall(__NR_exit_group, 0); /* NOT __NR_exit: that ends one thread only */
  return -1; /* not reached */
}
