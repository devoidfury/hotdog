// netns-shim: the hard-egress pre-exec hop. Capability-gated: hosts where
// unprivileged user namespaces are off (containers with seccomp, Ubuntu <24
// with AppArmor restrictions, ...) must see a clean nonzero probe and a
// refusal downstream -- exactly the posture the tier promises. Where the
// probe passes, the namespace's shape is asserted too.

import { describe, it, expect } from "bun:test";
import { fileURLToPath } from "node:url";

const SHIM = fileURLToPath(new URL("../../src/utils/netns-shim.ts", import.meta.url));

function runShim(...args: string[]) {
  return Bun.spawnSync([process.execPath, SHIM, ...args], { stdout: "pipe", stderr: "pipe" });
}

const probe = runShim("--probe");
const shimWorks = probe.exitCode === 0;

describe("netns-shim", () => {
  it("probe agrees with spawns: 0 here means 0 for every jail", () => {
    // Probe never reports success with a broken chain (the exit is either
    // 0 or the environment-refusal 120 / setup 121).
    expect([0, 120, 121]).toContain(probe.exitCode);
    if (!shimWorks) {
      expect(probe.stderr.toString()).toContain("netns-shim:");
    }
  });

  it("rejects an empty argv with usage (122)", () => {
    expect(runShim().exitCode).toBe(122);
    expect(runShim("--bridge").exitCode).toBe(122); // bridge without a path
  });

  it("--exec runs the command through the exec mechanics (no namespaces)", () => {
    const r = runShim("--exec", "--", "echo", "shim-exec");
    expect(r.stdout.toString().trim()).toBe("shim-exec");
    expect(r.exitCode).toBe(0);
    const code = runShim("--exec", "--", "sh", "-c", "exit 41");
    expect(code.exitCode).toBe(41);
  });

  it.skipIf(!shimWorks)("inside the jail netns: loopback only, 127.0.0.1, nothing else", () => {
    const r = runShim("--", process.execPath, "-e", "console.log(JSON.stringify(Object.keys(Bun.os.networkInterfaces())))");
    const names = JSON.parse(r.stdout.toString().trim()) as string[];
    expect(names).toEqual(["lo"]);
    const addr = runShim(
      "--",
      process.execPath,
      "-e",
      'console.log(Bun.os.networkInterfaces().lo?.[0]?.address ?? "none")',
    );
    expect(addr.stdout.toString().trim()).toBe("127.0.0.1");
  });

  it.skipIf(!shimWorks)("a raw connect to the outside world fails inside the jail", () => {
    const r = runShim(
      "--",
      process.execPath,
      "-e",
      `const s = Bun.connect({ hostname: "example.com", port: 80, data() {} });
       s.then(() => console.log("EGRESSED")).catch((e) => console.log("blocked:" + e.code));`,
    );
    expect(r.stdout.toString()).toContain("blocked:");
  });
});
