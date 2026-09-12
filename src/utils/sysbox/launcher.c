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
#define __NR_execve 59
#define __NR_prctl 157
#define __NR_seccomp 317

#define PR_SET_NO_NEW_PRIVS 38
#define SECCOMP_SET_MODE_FILTER 1
#define SECCOMP_FILTER_FLAG_TSYNC 1

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
/* Network rights (linux/landlock.h net_access). TCP bind/connect arrive with
 * ABI v4; the UDP pair arrives with ABI v10 -- measured on this host (kernel
 * 7.2.3, Landlock ABI 10): bits 0..3 are the ENTIRE net surface (bit 2 =
 * BIND_UDP, bit 3 = CONNECT_SEND_UDP; handling bit 2 EACCESes bind(2) on a UDP
 * socket, bit 3 EACCESes sendto(2)), and any higher bit EINVALs the ruleset
 * create. The plan guessed 8/9; the guess is wrong, which is why
 * tests/utils/sysbox/fence-integration.test.ts pins all four by behavior and
 * this table stays the only place a bit number is asserted. CONNECT_SEND_UDP
 * covers both connect(2) on a UDP socket and a datagram send to a fresh
 * destination -- trapping connect alone was never an egress claim.
 *
 * Deliberately unhandled (= allowed), same ceiling family as the fs rights
 * newer than the table (IOCTL_DEV v5, RESOLVE_UNIX v9): the ABI v6 scope
 * rights (abstract unix sockets, signals). Handling them would deny IPC
 * between the sandbox and processes OUTSIDE the domain -- including hotdog's
 * own pipes -- for no egress claim; unix-filesystem sockets are already
 * bounded by the fs rules. */
#define LL_NET_BIND_TCP (1ULL << 0)         /* ABI >= 4 */
#define LL_NET_CONNECT_TCP (1ULL << 1)      /* ABI >= 4 */
#define LL_NET_BIND_UDP (1ULL << 2)         /* ABI >= 10 */
#define LL_NET_CONNECT_SEND_UDP (1ULL << 3) /* ABI >= 10 */

static uint64_t ll_fs_rights(int32_t abi) {
  uint64_t m = LL_FS_ALL_V1;
  if (abi >= 2) m |= LL_FS_REFER;
  if (abi >= 3) m |= LL_FS_TRUNCATE;
  return m;
}

/* Everything net, per the runtime ABI: handled with ZERO allow rules, so
 * every TCP bind/connect and UDP bind/send in the sandbox is EACCES. */
static uint64_t ll_net_rights(int32_t abi) {
  uint64_t m = 0;
  if (abi >= 4) m |= LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
  if (abi >= 10) m |= LL_NET_BIND_UDP | LL_NET_CONNECT_SEND_UDP;
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
 * ABI; every net right the ABI knows handled with no allow rules => every
 * TCP bind/connect and UDP bind/send is denied), one RW rule per rw path, one
 * EXECUTE|READ rule per ro path, then restrict_self. Rules persist across
 * fork/execve. The fence is allowlist-only: it cannot express
 * workspace.deny -- no layer here does (docs/sysbox-sandbox.md
 * "Known ceilings"). MUST run before the seccomp install and after
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
  rattr.handled_access_net = ll_net_rights((int32_t)abi);
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
