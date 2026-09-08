import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import {
  detectCapabilities,
  launcherCPath,
  sbHelperPath,
  resetCapabilitiesForTesting,
} from "../../../src/utils/sysbox/capabilities.ts";
import type { SysboxCapabilities } from "../../../src/utils/sysbox/capabilities.ts";
import { STATIC_DENIED_SYSCALLS, GATE_TRAPPED_SYSCALLS, MAX_DENY_SYSCALLS, OPEN_WRITE_MASK } from "../../../src/utils/sysbox/denied-syscalls.ts";
import { resolveSandboxMode } from "../../../src/extensions/bash-tool/index.ts";
import { ConfigError } from "../../../src/core/error.ts";

describe("sysbox capabilities", () => {
  it("detects without throwing and caches", () => {
    const a = detectCapabilities();
    const b = detectCapabilities();
    expect(a).toBe(b);
    expect(typeof a.staticAvailable).toBe("boolean");
    expect(typeof a.landlockAvailable).toBe("boolean");
    expect(Number.isInteger(a.landlockAbi)).toBe(true);
    expect(typeof a.gateAvailable).toBe("boolean");
    // gate is a strict superset: it can never be available without static.
    if (a.gateAvailable) expect(a.staticAvailable).toBe(true);
    // fence ladder: fence implies static; abi only nonzero when available.
    if (a.landlockAvailable) {
      expect(a.staticAvailable).toBe(true);
      expect(a.landlockAbi).toBeGreaterThanOrEqual(1);
    } else {
      expect(a.landlockAbi).toBe(0);
    }
    if (!a.staticAvailable || !a.gateAvailable || !a.landlockAvailable) {
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
    expect(b.gateAvailable).toBe(a.gateAvailable);
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
    ]);
  });

  it("fits the launcher MAX_DENY bound and has no duplicate numbers", () => {
    expect(STATIC_DENIED_SYSCALLS.length).toBeLessThanOrEqual(MAX_DENY_SYSCALLS);
    const nrs = STATIC_DENIED_SYSCALLS.map((d) => d.nr);
    expect(new Set(nrs).size).toBe(nrs.length);
    expect(nrs.every((n) => Number.isInteger(n) && n >= 0 && n <= 1024)).toBe(true);
  });

  // The gate BPF trap set, pinned exactly (launcher.c reads nothing else):
  // a change here IS a change in the syscall surface the supervisor sees.
  // The legacy/openat2/send* entries are the review-fix bypass set: a probe
  // wrote through the deny list with openat2, unlink(87), rename(82) and a
  // UDP sendto when only openat/unlinkat/renameat2/connect/execve were trapped.
  // The second-round entries (creat/truncate/mkdir*/mknod*/link*/symlink*) are
  // the same legacy-twin class, re-measured: with Landlock granting each root
  // rw wholesale, ANY untrapped create/alias/truncate syscall is missing
  // deny-list policy, not just missing audit.
  it("gate trap set is the pinned x86_64 set and disjoint from the deny set", () => {
    expect(GATE_TRAPPED_SYSCALLS.map((t) => `${t.name}:${t.nr}:${t.kind}`)).toEqual([
      "openat:257:open.write",
      "openat2:437:open.write",
      "creat:85:open.write",
      "truncate:76:truncate",
      "unlink:87:unlink",
      "unlinkat:263:unlink",
      "rmdir:84:unlink",
      "mkdir:83:create",
      "mkdirat:258:create",
      "mknod:133:create",
      "mknodat:259:create",
      "symlink:88:create",
      "symlinkat:266:create",
      "link:86:link",
      "linkat:265:link",
      "rename:82:rename",
      "renameat:264:rename",
      "renameat2:316:rename",
      "connect:42:connect",
      "sendto:44:connect",
      "sendmsg:46:connect",
      "sendmmsg:345:connect",
      "execve:59:execve",
    ]);
    const deniedNrs = new Set(STATIC_DENIED_SYSCALLS.map((d) => d.nr));
    for (const t of GATE_TRAPPED_SYSCALLS) {
      expect(deniedNrs.has(t.nr)).toBe(false);
    }
  });

  // Drift pin between the TS tables and the C filter: every trap must be
  // defined in launcher.c as `#define NR_<name> <nr>` and the open-write
  // flag mask must match the TS constant the supervisor applies to
  // openat2's struct open_how.
  it("launcher.c gate defines match the TS trap table and mask", () => {
    const c = readFileSync(launcherCPath(), "utf8");
    for (const t of GATE_TRAPPED_SYSCALLS) {
      expect(c).toContain(`#define NR_${t.name} ${t.nr}\n`);
    }
    expect(c).toContain(`#define OPEN_WRITE_MASK ${OPEN_WRITE_MASK}\n`);
  });
});

describe("bashTool resolveSandboxMode (fail-closed)", () => {
  const both: SysboxCapabilities = {
    staticAvailable: true,
    landlockAvailable: true,
    landlockAbi: 4,
    gateAvailable: true,
    reasons: [],
  };

  it("defaults to off; accepts static, fence and gate only when available", () => {
    expect(resolveSandboxMode(undefined, both)).toBe("off");
    expect(resolveSandboxMode("off", both)).toBe("off");
    expect(resolveSandboxMode("static", both)).toBe("static");
    expect(resolveSandboxMode("fence", both)).toBe("fence");
    expect(resolveSandboxMode("gate", both)).toBe("gate");
  });

  it("throws on an unavailable mode instead of downgrading", () => {
    const caps: SysboxCapabilities = {
      staticAvailable: false,
      landlockAvailable: false,
      landlockAbi: 0,
      gateAvailable: false,
      reasons: ["arch is \"arm64\""],
    };
    expect(() => resolveSandboxMode("static", caps)).toThrow(ConfigError);
    expect(() => resolveSandboxMode("static", caps)).toThrow(/not available[\s\S]*arm64/);
    expect(() => resolveSandboxMode("fence", caps)).toThrow(/fence" is not available/);
    expect(() => resolveSandboxMode("gate", caps)).toThrow(/gate" is not available/);
    expect(resolveSandboxMode("off", caps)).toBe("off");
  });

  it("static may work while gate is blocked (container seccomp profiles)", () => {
    const caps: SysboxCapabilities = {
      staticAvailable: true,
      landlockAvailable: true,
      landlockAbi: 4,
      gateAvailable: false,
      reasons: ["SECCOMP_FILTER_FLAG_NEW_LISTENER blocked here"],
    };
    expect(resolveSandboxMode("static", caps)).toBe("static");
    expect(resolveSandboxMode("fence", caps)).toBe("fence");
    expect(() => resolveSandboxMode("gate", caps)).toThrow(/NEW_LISTENER/);
  });

  it("static may work while landlock is blocked (kernels < 5.13, landlock=0)", () => {
    const caps: SysboxCapabilities = {
      staticAvailable: true,
      landlockAvailable: false,
      landlockAbi: 0,
      gateAvailable: true,
      reasons: ["landlock unavailable (kernel without landlock, disabled at boot, or blocked by container policy)"],
    };
    expect(resolveSandboxMode("static", caps)).toBe("static");
    expect(() => resolveSandboxMode("fence", caps)).toThrow(/landlock unavailable/);
    // gate stays selectable without landlock (degraded: no TOCTOU bound;
    // the capability matrix in `hotdog info` is the loud part).
    expect(resolveSandboxMode("gate", caps)).toBe("gate");
  });

  it("throws on an unknown mode even when everything would be fine", () => {
    expect(() => resolveSandboxMode("paranoid", both)).toThrow(
      /must be "off", "static", "fence", or "gate"/,
    );
  });
});
