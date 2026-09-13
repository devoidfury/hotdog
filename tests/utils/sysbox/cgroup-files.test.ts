// The cgroup DoS-limit plumbing driven WITHOUT cgroupfs: fake parents made
// of ordinary directories, fake children made of plain objects. This is the
// precedent set by buildMemoryKillNote (cgroup-limits.test.ts): the kernel
// semantics can only be pinned where they exist, but the create/retry/
// cleanup logic around them can be pinned everywhere. Same reason
// probeCapabilities/seccompErrnoActionReason/probeCgroupLimits are
// parameterized: the fail-closed guards must be assertable on any host,
// and mock.module is banned.

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSbxCgroupDir,
  removeSbxCgroupDir,
  cleanupSbxCgroup,
  sysboxMemoryKillNote,
  SBX_CGROUP_PIDS_MAX,
} from "@utils/sysbox/index.ts";
import {
  cgroupMemoryCapBytes,
  parseMemTotalKb,
  probeCapabilities,
  probeCgroupLimits,
  seccompErrnoActionReason,
} from "@utils/sysbox/capabilities.ts";

const fakeBase = (): string => mkdtempSync(join(tmpdir(), `sysbox-fake-cg-${process.pid}-`));

describe("createSbxCgroupDir (fake parent of ordinary files)", () => {
  it("creates the dir and writes the limit files", () => {
    const base = fakeBase();
    try {
      const dir = createSbxCgroupDir(base, 9001);
      expect(dir).toBe(join(base, `hotdog-sbx-${process.pid}-9001`));
      expect(existsSync(dir!)).toBe(true);
      expect(readFileSync(join(dir!, "pids.max"), "utf8")).toBe(String(SBX_CGROUP_PIDS_MAX));
      // memory.max is sized from /proc/meminfo (readable on linux; the
      // null-meminfo fallback is capped-unknown and still a number).
      const memMax = readFileSync(join(dir!, "memory.max"), "utf8");
      expect(/^\d+$/.test(memMax)).toBe(true);
      const memKb = (() => {
        try {
          return parseMemTotalKb(readFileSync("/proc/meminfo", "utf8"));
        } catch {
          return null;
        }
      })();
      expect(Number(memMax)).toBe(cgroupMemoryCapBytes(memKb));
      expect(readFileSync(join(dir!, "memory.swap.max"), "utf8")).toBe("0");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null (degrades) when the parent cannot host a mkdir", () => {
    // Nonexistent parent: the mkdir throws, the outer catch warns and degrades.
    expect(createSbxCgroupDir("/nonexistent-sysbox-dir-here", 9002)).toBeNull();
    // Read-only parent: same outer catch through EACCES.
    const base = fakeBase();
    try {
      chmodSync(base, 0o555);
      expect(createSbxCgroupDir(base, 9003)).toBeNull();
      chmodSync(base, 0o755);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("removeSbxCgroupDir (retry budget injected)", () => {
  it("returns silently when the dir is already gone (ENOENT)", () => {
    expect(() => removeSbxCgroupDir(join(fakeBase(), "never-existed"), 5)).not.toThrow();
  });

  it("rmdirs an empty dir on the first attempt", () => {
    const base = fakeBase();
    const dir = join(base, "empty");
    mkdirSync(dir);
    removeSbxCgroupDir(dir, 5);
    expect(existsSync(dir)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it("gives up after 20 attempts and leaves the busy dir in place", async () => {
    const base = fakeBase();
    const dir = join(base, "busy");
    mkdirSync(dir);
    writeFileSync(join(dir, "member"), "still-running\n"); // emulates a daemonized process
    removeSbxCgroupDir(dir, 5);
    await Bun.sleep(350); // 20 attempts x 5ms ~= 100ms, generous margin
    expect(existsSync(dir)).toBe(true); // limits stay ON, which is the right failure mode
    rmSync(base, { recursive: true, force: true });
  });

  it("succeeds on a later retry once the dir becomes empty", async () => {
    const base = fakeBase();
    const dir = join(base, "draining");
    mkdirSync(dir);
    const member = join(dir, "member");
    writeFileSync(member, "bye\n");
    setTimeout(() => rmSync(member, { force: true }), 15).unref?.();
    removeSbxCgroupDir(dir, 5);
    const deadline = Date.now() + 2000;
    while (existsSync(dir) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(dir)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("cleanupSbxCgroup (fake child + fake cgroup dir)", () => {
  it("records the OOM note when the counters say so, then removes the dir", async () => {
    const base = fakeBase();
    const dir = join(base, "cg");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "memory.events"),
      "low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\noom_group_kill 0\n",
    );
    writeFileSync(join(dir, "memory.max"), "1048576\n");
    const child = new EventEmitter() as unknown as ChildProcess;
    cleanupSbxCgroup(child, dir);
    const note = sysboxMemoryKillNote(child);
    expect(note).not.toBeNull();
    expect(note).toContain("OOM-killed");
    expect(note).toContain("1048576 bytes");
    expect(note).toContain("oom_kill = 2");
    // The dir holds ordinary files, so the rmdir retries will give up
    // exactly like the daemonized-process case; tear it down ourselves and
    // the outstanding retries end on ENOENT.
    rmSync(base, { recursive: true, force: true });
    await Bun.sleep(50);
  });

  it("records nothing when oom_kill stayed 0 or the files are absent", () => {
    const base = fakeBase();
    const dir = join(base, "cg");
    mkdirSync(dir);
    writeFileSync(join(dir, "memory.events"), "low 0\nhigh 0\noom_kill 0\n");
    const c1 = new EventEmitter() as unknown as ChildProcess;
    cleanupSbxCgroup(c1, dir);
    expect(sysboxMemoryKillNote(c1)).toBeNull();

    const empty = join(base, "cg2");
    mkdirSync(empty); // no memory.events at all
    const c2 = new EventEmitter() as unknown as ChildProcess;
    cleanupSbxCgroup(c2, empty);
    expect(sysboxMemoryKillNote(c2)).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("seccompErrnoActionReason (path-injected)", () => {
  it("fails closed when the procfs entry does not exist", () => {
    const reason = seccompErrnoActionReason("/proc/sys/kernel/seccomp/actions-does-not-exist");
    expect(reason).toContain("not readable");
    expect(reason).toContain("unverifiable");
  });

  it("accepts an actions list containing errno", () => {
    const base = fakeBase();
    const p = join(base, "actions");
    writeFileSync(p, "kill process kill_signal trap errno log user_notification\n");
    expect(seccompErrnoActionReason(p)).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses a kernel built without the errno action", () => {
    const base = fakeBase();
    const p = join(base, "actions");
    writeFileSync(p, "kill process kill_signal trap\n");
    expect(seccompErrnoActionReason(p)).toContain("SECCOMP_RET_ERRNO");
    rmSync(base, { recursive: true, force: true });
  });

  it("treats an unreadable entry like a missing one (read throws -> no errno)", () => {
    // A directory passes existsSync but readFileSync throws EISDIR for every
    // user, root included -- deterministic stand-in for EACCES on the real file.
    expect(seccompErrnoActionReason(fakeBase())).toContain("SECCOMP_RET_ERRNO");
  });
});

describe("probeCapabilities guards (platform/arch/helper injected)", () => {
  // probeCapabilities never touches the detectCapabilities cache, so these
  // can run alongside every other suite in the same process.
  it("refuses non-linux platforms", () => {
    const caps = probeCapabilities("darwin", "x64");
    expect(caps.staticAvailable).toBe(false);
    expect(caps.reasons.some((r) => r.includes('platform is "darwin"'))).toBe(true);
    // Everything downstream is gated on `ok`: nothing probed, nothing available.
    expect(caps.landlockAvailable).toBe(false);
    expect(caps.landlockAbi).toBe(0);
    expect(caps.cgroupAvailable).toBe(false);
    expect(caps.cgroupParentDir).toBeNull();
  });

  it("refuses non-x64 arches (the deny table pins x86_64 numbers)", () => {
    const caps = probeCapabilities("linux", "arm64");
    expect(caps.staticAvailable).toBe(false);
    expect(caps.reasons.some((r) => r.includes('arch is "arm64"'))).toBe(true);
  });

  it("refuses a broken install: missing sbx-exec helper", () => {
    const caps = probeCapabilities("linux", "x64", "/nonexistent/sbx-exec.ts");
    expect(caps.staticAvailable).toBe(false);
    expect(caps.reasons.some((r) => r.includes("sbx-exec helper not found"))).toBe(true);
  });

  it("a helper probe that fails closes landlock off (exit non-zero, reasons say why)", () => {
    const base = fakeBase();
    // Stand-in helper: exits like the real one does when landlock is absent.
    const script = join(base, "fake-sbx.ts");
    writeFileSync(script, "process.exit(3);\n");
    const caps = probeCapabilities("linux", "x64", script);
    expect(caps.staticAvailable).toBe(true); // seccomp itself still verified
    expect(caps.landlockAvailable).toBe(false);
    expect(caps.landlockAbi).toBe(0);
    expect(
      caps.reasons.some((r) => r.includes("landlock unavailable")),
    ).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("probeCgroupLimits (fake parent)", () => {
  it("reports neither controller for a plain dir and cleans up after itself", () => {
    const base = fakeBase();
    try {
      expect(probeCgroupLimits(base)).toEqual({ pids: false, memory: false });
      // The probe's own dir must be gone (mkdir/rmdir in a finally).
      expect(existsSync(join(base, `hotdog-sbx-probe-${process.pid}`))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("degrades to neither controller when its mkdir cannot even land (name squat)", () => {
    const base = fakeBase();
    try {
      // Squat the exact probe dir: mkdirSync EEXISTs, the catch answers
      // {pids:false, memory:false}, and the squatted dir is left alone.
      const squat = join(base, `hotdog-sbx-probe-${process.pid}`);
      mkdirSync(squat);
      expect(probeCgroupLimits(base)).toEqual({ pids: false, memory: false });
      expect(existsSync(squat)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
