// Tests for src/utils/process-group.ts — own-process-group spawn options and
// group kill, with a real grandchild to prove the whole tree is reached.

import { describe, it, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { IS_POSIX, OWN_PROCESS_GROUP, killProcessGroup } from "../../src/utils/process-group.ts";
import { tmpDir, cleanupDir } from "../mocks/io.ts";
import { processAlive, waitForExit } from "../mocks/process.ts";

describe("process-group utils", () => {
  it("OWN_PROCESS_GROUP.detached follows the platform (POSIX true, win32 false)", () => {
    expect(OWN_PROCESS_GROUP.detached).toBe(IS_POSIX);
  });

  it("killProcessGroup does not throw when the child has no pid", () => {
    expect(() =>
      killProcessGroup({ pid: undefined } as unknown as ChildProcess, "SIGTERM"),
    ).not.toThrow();
  });

  it("killProcessGroup does not throw when the group already exited", async () => {
    const child = spawn("sh", ["-c", "exit 0"], { ...OWN_PROCESS_GROUP, stdio: "ignore" });
    await new Promise<void>((r) => child.on("exit", () => r()));
    expect(() => killProcessGroup(child, "SIGTERM")).not.toThrow();
  });

  it("killProcessGroup kills grandchildren, not just the direct child", async () => {
    const dir = tmpDir("hotdog-procgroup-");
    const pidFile = `${dir}/pid`;
    try {
      // sh is the direct child; the backgrounded sleep is its grandchild.
      // Without the own-process-group + group kill, the sleep outlives sh.
      const child = spawn("sh", ["-c", `sleep 300 & echo $! > ${pidFile}; cat`], {
        ...OWN_PROCESS_GROUP,
        stdio: ["ignore", "ignore", "ignore"],
      });

      // Poll until the file holds a full pid: under load the file can exist
      // momentarily empty before `echo $!` finishes writing it.
      const start = Date.now();
      let grandchildPid = NaN;
      while (Number.isNaN(grandchildPid)) {
        if (Date.now() - start > 5000) throw new Error("grandchild pid never written");
        const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf-8").trim() : "";
        if (/^\d+$/.test(raw)) grandchildPid = parseInt(raw, 10);
        else await new Promise((r) => setTimeout(r, 20));
      }
      expect(processAlive(grandchildPid)).toBe(true);

      killProcessGroup(child, "SIGTERM");

      await waitForExit(grandchildPid);
      expect(processAlive(grandchildPid)).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  }, 15000);
});
