// cgroup DoS limits (pids.max / memory.max) applied to every sandboxed
// spawn. The capabilities probe is the authority: hosts without a writable,
// delegated cgroup v2 subtree (containers with ro /sys/fs/cgroup, non-root
// at the root cgroup) SKIP, never fail. Pure logic (parse/clamp) is pinned
// in capabilities.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "@extensions/bash-tool/index.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { Workspace } from "@utils/workspace.ts";
import { detectCapabilities, SBX_CGROUP_PIDS_MAX, buildMemoryKillNote } from "@utils/sysbox/index.ts";

const caps = detectCapabilities();

if (!caps.cgroupAvailable) {
  console.log("[sysbox] cgroup limit tests skipped: no writable delegated cgroup v2 subtree here");
}

describe.skipIf(!caps.staticAvailable || !caps.cgroupAvailable)("sysbox cgroup DoS limits (static mode)", () => {
  let base: string;
  let root: string;
  let tool: BashTool;
  let ctx: ToolContext;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "sysbox-cg-"));
    root = join(base, "ws");
    mkdirSync(root, { recursive: true });
    tool = new BashTool({ timeoutMs: 30000, maxOutputLines: 200, sandbox: "static" });
    ctx = new ToolContext();
    ctx.set("workspace", new Workspace(root));
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("runs the command inside a hotdog-sbx cgroup", async () => {
    const r = await tool.execute({ command: "cat /proc/self/cgroup" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("hotdog-sbx-");
  });

  // Regression pin for the cleanup path: removeSbxCgroupDir must actually
  // rmdir (bun 1.3.14's rmSync without `recursive` fails on directories, so
  // every spawn silently littered the subtree and burned its whole retry
  // budget). Filtered to THIS process's dir-name prefix so a concurrently
  // running suite's live spawns cannot flake it.
  it("spawn cgroup is removed after the command completes", async () => {
    const r = await tool.execute({ command: "true" }, ctx);
    expect(r.success).toBe(true);
    const parent = caps.cgroupParentDir;
    expect(parent).not.toBeNull();
    const prefix = `hotdog-sbx-${process.pid}-`;
    // removal retries run 500 ms apart for up to ~10 s; 15 s is generous slack
    const deadline = Date.now() + 15_000;
    for (;;) {
      const stale = readdirSync(parent!).filter((d) => d.startsWith(prefix));
      if (stale.length === 0) break;
      if (Date.now() >= deadline) {
        expect(`stale cgroups left behind: ${stale.join(", ")}`).toBe("stale cgroups left behind: ");
      }
      await Bun.sleep(250);
    }
  });

  // Fork bomb containment: forks must stop succeeding (EAGAIN) at ~pids.max,
  // NOT at 3*attempts. Children _exit immediately; the parent reaps. The
  // attempt ceiling (3*cap) bounds the probe even if the limit were absent.
  // Gated on the pids controller specifically: delegation is per-controller
  // and a memory-only host buys nothing here (the bomb would really fork
  // 3*CAP times).
  it("fork bomb hits pids.max (EAGAIN at the cap)", async () => {
    if (!caps.cgroupPidsAvailable) {
      console.log("[sysbox] pids controller not delegated; fork cap probe skipped");
      return;
    }
    if (!Bun.which("python3")) {
      console.log("[sysbox] python3 unavailable; fork cap probe skipped");
      return;
    }
    const probe = join(base, "forkcap.py");
    writeFileSync(probe, [
      "import os, errno, time",
      `CAP = ${SBX_CGROUP_PIDS_MAX}`,
      "ok = 0",
      "eagain = False",
      "for _ in range(3 * CAP):",
      "    try:",
      "        pid = os.fork()",
      "    except OSError as e:",
      "        if e.errno == errno.EAGAIN:",
      "            eagain = True",
      "        break",
      "    if pid == 0:",
      "        os._exit(0)",
      "    ok += 1",
      "deadline = time.time() + 8",
      "while time.time() < deadline:",
      "    try:",
      "        p, _ = os.waitpid(-1, os.WNOHANG)",
      "        if p == 0:",
      "            time.sleep(0.05)",
      "    except ChildProcessError:",
      "        break",
      'print("ok=%d eagain=%s" % (ok, eagain))',
    ].join("\n"));
    try {
      const r = await tool.execute({ command: `python3 ${probe}` }, ctx);
      expect(r.output).toContain("eagain=True");
      // slack: threads (python + bun's cgroup entry) already occupy slots,
      // so the fork count lands AT OR BELOW the cap, never meaningfully above.
      const m = /ok=(\d+)/.exec(r.output);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThanOrEqual(SBX_CGROUP_PIDS_MAX);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  // Zip-bomb/heap-growth containment: steady 256MB allocations past the cap
  // must end in an in-cgroup OOM kill (SIGKILL / nonzero), never unbounded
  // host growth. Gated on the memory controller: without memory.max delegated
  // this loop would allocate toward its 6GB ceiling unsandboxed and fail on
  // the assert -- or worse, put global OOM pressure on a small host. With the
  // controller present the cap lands at >= 512MB, so the 6GB ceiling is only
  // the escape hatch if the limit somehow did not apply.
  it("memory hog past memory.max is killed", async () => {
    if (!caps.cgroupMemoryAvailable) {
      console.log("[sysbox] memory controller not delegated; memory cap probe skipped");
      return;
    }
    if (!Bun.which("python3")) {
      console.log("[sysbox] python3 unavailable; memory cap probe skipped");
      return;
    }
    const probe = join(base, "memcap.py");
    writeFileSync(probe, [
      "import os",
      "hold = []",
      "for i in range(24):  # 24 * 256MB = 6GB ceiling",
      "    hold.append(bytearray(256 * 1024 * 1024))",
      "print('SURVIVED-6GB')",
    ].join("\n"));
    try {
      const r = await tool.execute({ command: `python3 ${probe}; exit $?` }, ctx);
      expect(r.output).not.toContain("SURVIVED-6GB");
      expect(r.metadata?.get("exit_code")).not.toBe("0");
      // The whole point of the wiring: a kernel SIGKILL past memory.max must
      // explain itself, not surface as a bare dead exit code. The note comes
      // from the cgroup's oom_kill counter (this test doubles as the
      // behavioral pin for sysboxMemoryKillNote).
      expect(r.output).toContain("sandbox memory limit reached");
      expect(r.output).toContain("oom_kill");
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

// The OOM note builder, driven with fake cgroup dirs (plain files work --
// it only readFileSyncs memory.events/memory.max). Runs EVERYWHERE: the
// skipped suite above is the end-to-end pin, this is the logic pin for
// hosts without a delegated memory controller.
describe("buildMemoryKillNote (fake dirs)", () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "sbx-note-"));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const cg = (name: string, files: Record<string, string>): string => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };

  it("builds the note when oom_kill went up, quoting limit and count", () => {
    const dir = cg("killed", {
      "memory.events": "low 0\nhigh 0\nmax 2\noom 1\noom_kill 2\n",
      "memory.max": "2147483648\n",
    });
    const note = buildMemoryKillNote(dir);
    expect(note).not.toBeNull();
    expect(note).toContain("sandbox memory limit reached");
    expect(note).toContain("2147483648 bytes");
    expect(note).toContain("oom_kill = 2");
  });

  it("no note when nothing was OOM-killed or the memory controller is absent", () => {
    expect(
      buildMemoryKillNote(cg("quiet", {
        "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
        "memory.max": "4294967296\n",
      })),
    ).toBeNull();
    // pids-only host: no memory.events at all
    expect(buildMemoryKillNote(cg("pids-only", { "pids.max": "512\n" }))).toBeNull();
    // dir gone entirely
    expect(buildMemoryKillNote(join(base, "nope"))).toBeNull();
  });

  it("degrades the limit display when memory.max is unreadable or unlimited", () => {
    const dir = cg("nomax", { "memory.events": "oom_kill 1\n" }); // no memory.max file
    expect(buildMemoryKillNote(dir)).toContain("memory.max = unknown");
    writeFileSync(join(dir, "memory.max"), "max\n"); // unlimited cap, killed by external pressure
    const note = buildMemoryKillNote(dir);
    expect(note).toContain("memory.max = max");
    expect(note).not.toContain("max bytes");
  });
});
