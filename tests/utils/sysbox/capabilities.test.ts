import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import {
  cgroupMemoryCapBytes,
  detectCapabilities,
  findCgroupParentDir,
  LANDLOCK_NET_RIGHTS,
  landlockNetPosture,
  launcherCPath,
  parseMemTotalKb,
  parseMemoryEventsOomKill,
  parseUnifiedCgroup,
  sbHelperPath,
  resetCapabilitiesForTesting,
} from "@utils/sysbox/capabilities.ts";
import type { SysboxCapabilities } from "@utils/sysbox/capabilities.ts";
import { STATIC_DENIED_SYSCALLS, MAX_DENY_SYSCALLS } from "@utils/sysbox/denied-syscalls.ts";
import { resolveSandboxMode } from "@extensions/bash-tool/index.ts";
import { ConfigError } from "@core/error.ts";

describe("sysbox capabilities", () => {
  it("detects without throwing and caches", () => {
    const a = detectCapabilities();
    const b = detectCapabilities();
    expect(a).toBe(b);
    expect(typeof a.staticAvailable).toBe("boolean");
    expect(typeof a.landlockAvailable).toBe("boolean");
    expect(Number.isInteger(a.landlockAbi)).toBe(true);
    expect(typeof a.cgroupAvailable).toBe("boolean");
    expect(typeof a.cgroupPidsAvailable).toBe("boolean");
    expect(typeof a.cgroupMemoryAvailable).toBe("boolean");
    // cgroupAvailable is the union: it can never be true with neither.
    if (a.cgroupAvailable) {
      expect(a.cgroupPidsAvailable || a.cgroupMemoryAvailable).toBe(true);
      expect(a.cgroupParentDir).not.toBeNull();
    }
    // fence ladder: fence implies static; abi only nonzero when available.
    if (a.landlockAvailable) {
      expect(a.staticAvailable).toBe(true);
      expect(a.landlockAbi).toBeGreaterThanOrEqual(1);
    } else {
      expect(a.landlockAbi).toBe(0);
    }
    if (!a.staticAvailable || !a.landlockAvailable) {
      expect(a.reasons.length).toBeGreaterThan(0);
    }
  });

  it("agrees with the current process platform", () => {
    const caps = detectCapabilities();
    if (process.platform !== "linux" || process.arch !== "x64") {
      expect(caps.staticAvailable).toBe(false);
    }
  });
});

describe("capabilities paths and reset", () => {
  // The fail-closed guards inside detectCapabilities (non-linux platform,
  // non-x64 arch, unreadable actions_avail, missing helper file, probe
  // spawn failure) are deliberately not unit-covered: reaching them needs
  // mock.module (banned) or a different host. They are defensive branches
  // whose only job is to refuse; the integration suites exercise the happy
  // paths on every kernel where the modes are real.
  it("ships the helper and launcher sources next to the module", () => {
    expect(existsSync(sbHelperPath())).toBe(true);
    expect(existsSync(launcherCPath())).toBe(true);
  });

  it("resetCapabilitiesForTesting forces a re-probe with the same verdict", () => {
    const a = detectCapabilities();
    resetCapabilitiesForTesting();
    const b = detectCapabilities();
    expect(b).not.toBe(a);
    expect(b.staticAvailable).toBe(a.staticAvailable);
    expect(b.landlockAvailable).toBe(a.landlockAvailable);
    expect(b.landlockAbi).toBe(a.landlockAbi);
    expect(b.cgroupAvailable).toBe(a.cgroupAvailable);
    expect(b.cgroupParentDir).toBe(a.cgroupParentDir);
    expect(b.cgroupPidsAvailable).toBe(a.cgroupPidsAvailable);
    expect(b.cgroupMemoryAvailable).toBe(a.cgroupMemoryAvailable);
    resetCapabilitiesForTesting();
  });
});

describe("deny table", () => {
  // Pinned exact set: the BPF filter is built from this table, so a change
  // here IS a change in policy. Anything unlisted becomes ALLOW.
  it("is the pinned x86_64 escape-surface set", () => {
    expect(STATIC_DENIED_SYSCALLS.map((d) => `${d.name}:${d.nr}`)).toEqual([
      "io_uring_setup:425",
      "io_uring_enter:426",
      "io_uring_register:427",
      "ptrace:101",
      "process_vm_readv:440",
      "process_vm_writev:441",
      "pidfd_getfd:438",
      "mount:165",
      "umount2:166",
      "pivot_root:155",
      "chroot:161",
      "setns:308",
      "unshare:272",
      "bpf:321",
      "perf_event_open:298",
      "userfaultfd:323",
      "kexec_load:246",
      "kexec_file_load:518",
      "add_key:248",
      "request_key:249",
      "keyctl:250",
      "open_tree:428",
      "move_mount:429",
      "fsopen:430",
      "fsconfig:431",
      "fsmount:432",
      "fspick:433",
      "name_to_handle_at:303",
      "open_by_handle_at:304",
    ]);
  });

  it("fits the launcher MAX_DENY bound and has no duplicate numbers", () => {
    expect(STATIC_DENIED_SYSCALLS.length).toBeLessThanOrEqual(MAX_DENY_SYSCALLS);
    const nrs = STATIC_DENIED_SYSCALLS.map((d) => d.nr);
    expect(new Set(nrs).size).toBe(nrs.length);
    expect(nrs.every((n) => Number.isInteger(n) && n >= 0 && n <= 1024)).toBe(true);
  });

});

// The fence's network claim, and the drift pin between its TS mirror and
// launcher.c's ll_net_rights. The BIT NUMBERS here are measured, not copied:
// the plan guessed 8/9 for the UDP pair and this host's ABI-10 kernel rejects
// those (2/3 is what it takes), which is exactly why the behavior half of the
// pin lives in fence-integration.test.ts -- bind, connect and sendto must
// EACCES on a real fenced spawn. A wrong bit would EINVAL the ruleset create:
// a refused spawn, never a silent hole.
describe("landlock net rights", () => {
  it("launcher.c ll_net_rights matches the TS table (name, bit, ABI tier)", () => {
    const c = readFileSync(launcherCPath(), "utf8");
    const fn = /static uint64_t ll_net_rights\(int32_t abi\) \{([\s\S]*?)\n\}/.exec(c);
    expect(fn).not.toBeNull();
    const body = fn![1]!;
    for (const r of LANDLOCK_NET_RIGHTS) {
      expect(c).toContain(`#define LL_NET_${r.name} (1ULL << ${r.bit})`);
      expect(body).toMatch(new RegExp(`if \\(abi >= ${r.abi}\\) m \\|= [^;]*\\bLL_NET_${r.name}\\b`));
    }
    // Handled with NO allow rules anywhere: adding a NET_PORT rule would turn
    // the default-deny into a per-port allowlist nobody reviewed.
    expect(c).not.toContain("LANDLOCK_RULE_NET_PORT");
    expect(c).not.toContain("net_port");
  });

  it("posture wording says unhandled rather than implying safety", () => {
    expect(landlockNetPosture(0)).toBe("net: unhandled");
    expect(landlockNetPosture(3)).toBe("net: unhandled");
    expect(landlockNetPosture(4)).toBe("net: tcp bind+connect denied");
    expect(landlockNetPosture(9)).toBe("net: tcp bind+connect denied");
    expect(landlockNetPosture(10)).toBe("net: tcp bind+connect denied +udp");
  });
});

describe("bashTool resolveSandboxMode (fail-closed)", () => {
  const both: SysboxCapabilities = {
    staticAvailable: true,
    landlockAvailable: true,
    landlockAbi: 4,
    cgroupAvailable: true,
    cgroupParentDir: "/sys/fs/cgroup",
    cgroupPidsAvailable: true,
    cgroupMemoryAvailable: true,
    reasons: [],
  };

  it("defaults to off; accepts static and fence only when available", () => {
    expect(resolveSandboxMode(undefined, both)).toBe("off");
    expect(resolveSandboxMode("off", both)).toBe("off");
    expect(resolveSandboxMode("static", both)).toBe("static");
    expect(resolveSandboxMode("fence", both)).toBe("fence");
  });

  it("throws on an unavailable mode instead of downgrading", () => {
    const caps: SysboxCapabilities = {
      staticAvailable: false,
      landlockAvailable: false,
      landlockAbi: 0,
      cgroupAvailable: false,
      cgroupParentDir: null,
      cgroupPidsAvailable: false,
      cgroupMemoryAvailable: false,
      reasons: ["arch is \"arm64\""],
    };
    expect(() => resolveSandboxMode("static", caps)).toThrow(ConfigError);
    expect(() => resolveSandboxMode("static", caps)).toThrow(/not available[\s\S]*arm64/);
    expect(() => resolveSandboxMode("fence", caps)).toThrow(/fence" is not available/);
    expect(resolveSandboxMode("off", caps)).toBe("off");
  });

  // A container may block landlock while seccomp ERRNO works fine (docker's
  // default profile does exactly this on older kernels): static stays
  // selectable, fence refuses rather than downgrading to it.
  it("static may work while landlock is blocked (kernels < 5.13, landlock=0)", () => {
    const caps: SysboxCapabilities = {
      staticAvailable: true,
      landlockAvailable: false,
      landlockAbi: 0,
      cgroupAvailable: false,
      cgroupParentDir: null,
      cgroupPidsAvailable: false,
      cgroupMemoryAvailable: false,
      reasons: ["landlock unavailable (kernel without landlock, disabled at boot, or blocked by container policy)"],
    };
    expect(resolveSandboxMode("static", caps)).toBe("static");
    expect(() => resolveSandboxMode("fence", caps)).toThrow(/landlock unavailable/);
  });

  it("throws on an unknown mode even when everything would be fine", () => {
    expect(() => resolveSandboxMode("paranoid", both)).toThrow(
      /must be "off", "static", or "fence"/,
    );
  });
});

// Pure logic behind the cgroup DoS limits (all sandbox modes, best-effort).
// The probe itself (real mkdir under our own subtree) is host-dependent --
// read-only /sys/fs/cgroup in containers is its COMMON verdict; what is
// pinned here are the parse/compute functions the probe and the spawner
// share, and the integration assertion in cgroup-limits.test.ts runs only
// where the probe says available.
describe("cgroup limit helpers", () => {
  it("parseUnifiedCgroup finds only the 0:: entry", () => {
    expect(parseUnifiedCgroup("0::/\n")).toBe("/");
    expect(parseUnifiedCgroup("0::/user.slice/user-1000.slice/app\n")).toBe(
      "/user.slice/user-1000.slice/app",
    );
    // v1 hybrid: controller lines have nonzero hierarchy ids; only a real
    // 0:: line counts.
    expect(
      parseUnifiedCgroup("11:memory:/user.slice\n1:name=systemd:/user.slice\n"),
    ).toBeNull();
    expect(parseUnifiedCgroup("")).toBeNull();
    expect(parseUnifiedCgroup("0::relative/invalid\n")).toBeNull();
  });

  it("parseMemTotalKb extracts MemTotal", () => {
    expect(
      parseMemTotalKb("MemTotal:       15645176 kB\nMemFree:   100 kB\n"),
    ).toBe(15645176);
    expect(parseMemTotalKb("MemFree: 1 kB\n")).toBeNull();
    expect(parseMemTotalKb("MemTotal: 0 kB\n")).toBeNull();
  });

  it("cgroupMemoryCapBytes clamps to [512MiB, 4GiB], half of RAM in between", () => {
    const MB = 1024 * 1024;
    expect(cgroupMemoryCapBytes(1024 * 1024)).toBe(512 * MB); // 1GiB host -> floor
    expect(cgroupMemoryCapBytes(8 * 1024 * 1024)).toBe(4096 * MB); // 8GiB -> half
    expect(cgroupMemoryCapBytes(64 * 1024 * 1024)).toBe(4 * 1024 * MB); // big -> cap
    expect(cgroupMemoryCapBytes(null)).toBe(512 * MB); // unknown -> floor, never unlimited
  });

  it("parseMemoryEventsOomKill reads only the oom_kill counter", () => {
    expect(
      parseMemoryEventsOomKill(
        "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
      ),
    ).toBe(0);
    // real kernel shape: header line included, counters above
    expect(
      parseMemoryEventsOomKill(
        "local 0\ndispatch 0\nanon 0\nlow 3\nhigh 1\nmax 1\noom 1\noom_kill 2\n",
      ),
    ).toBe(2);
    // never misread a sibling counter, never accuse on garbage
    expect(parseMemoryEventsOomKill("oom_group_kill 7\n")).toBe(0);
    expect(parseMemoryEventsOomKill("oom_kill not-a-number\n")).toBe(0);
    expect(parseMemoryEventsOomKill("")).toBe(0);
  });

  // The ancestor walk that fixes bare-metal systemd hosts: our own cgroup is
  // a leaf scope with members, so the kernel forbids controllers there and
  // the ONLY usable host is an ancestor. Predicate-injected: pins the walk
  // itself (order, stopping conditions), the real fs answers come from the
  // un-skipped cgroup-limits.test.ts suite.
  describe("findCgroupParentDir", () => {
    const LEAF = "/user.slice/user-1000.slice/user@1000.service/app.slice/tab.scope";
    const usableAt = (...okDirs: string[]) => (abs: string) => okDirs.includes(abs);

    it("takes its own cgroup when it can host limited children", () => {
      expect(findCgroupParentDir(LEAF, usableAt(`/sys/fs/cgroup${LEAF}`))).toBe(
        `/sys/fs/cgroup${LEAF}`,
      );
    });

    it("walks up to the nearest usable ancestor, deepest first", () => {
      const anc = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service";
      const found = findCgroupParentDir(
        LEAF,
        usableAt(anc, "/sys/fs/cgroup/user.slice"),
      );
      expect(found).toBe(anc);
    });

    it("returns null when nothing up to the mount root can host one", () => {
      expect(findCgroupParentDir(LEAF, usableAt("/some/other/tree"))).toBeNull();
      // the mount root itself is a candidate (container at the root cgroup),
      // but nothing above it: usable("/") must not make the walk loop.
      expect(findCgroupParentDir("/", usableAt())).toBeNull();
    });

    it("the mount root rel-path normalizes to the mount, not below it", () => {
      expect(findCgroupParentDir("/", usableAt("/sys/fs/cgroup"))).toBe("/sys/fs/cgroup");
    });
  });
});
