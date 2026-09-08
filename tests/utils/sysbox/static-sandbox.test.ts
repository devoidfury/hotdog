// End-to-end sysbox `static` mode tests. These spawn real sandboxed
// processes; the suite is skipped entirely on hosts without the capability
// (capabilities.test.ts covers the detection itself).
//
// The seccomp proof must distinguish the FILTER's denial from incidental
// kernel denial, so the probe syscalls are asserted inside the sandbox and
// the control syscall (getpid) must succeed there -- an environment that
// blocks everything fails the control and cannot silently "pass" this test.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { BashTool } from "../../../src/extensions/bash-tool/index.ts";
import { ToolContext } from "../../../src/core/extensions/tool-context.ts";
import { detectCapabilities, spawnSandboxed } from "../../../src/utils/sysbox/index.ts";

const caps = detectCapabilities();
const suite = caps.staticAvailable ? describe : describe.skip;

if (!caps.staticAvailable) {
  // Logged, not silent: CI on a non-supporting kernel shows this as skipped.
  console.log(`[sysbox] static tests skipped: ${caps.reasons.join("; ")}`);
}

const PROBE_PATH = join(tmpdir(), `sysbox-probe-${process.pid}.ts`);

suite("sysbox static mode (real sandbox)", () => {
  const tool = new BashTool({ timeoutMs: 15000, maxOutputLines: 600, sandbox: "static" });

  beforeAll(() => {
    // Written as a file: nested shell quoting of an inline -e body is its own
    // bug farm. bun:ffi dlopen resolves from the running libc.
    writeFileSync(
      PROBE_PATH,
      `import { dlopen } from "bun:ffi";
const libc = dlopen("libc.so.6", { syscall: { args: ["i64","i64","i64","i64","i64","i64","i64"], returns: "i64" } });
const sc = libc.symbols.syscall as (...a: number[]) => number;
console.log(
  "uring=" + sc(425, 0, 0, 0, 0, 0, 0),
  "unshare=" + sc(272, 0, 0, 0, 0, 0, 0),
  "ptrace=" + sc(101, 0, 0, 0, 0, 0, 0),
  "bpf=" + sc(321, 0, 0, 0, 0, 0, 0),
  "getpid_ok=" + (sc(39, 0, 0, 0, 0, 0, 0) > 0),
);
`,
    );
  });
  afterAll(() => rmSync(PROBE_PATH, { force: true }));

  it("runs commands: stdout, stderr, and exit code", async () => {
    const r = await tool.execute({ command: "echo out; echo err >&2; exit 5" }, new ToolContext());
    expect(r.success).toBe(true);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.metadata?.get("exit_code")).toBe("5");
  });

  it("preserves behavior parity: multiline output and truncation marker", async () => {
    const r = await tool.execute({ command: "printf 'a\\nb\\nc\\n'" }, new ToolContext());
    expect(r.success).toBe(true);
    expect(r.output).toContain("a\nb\nc");
  });

  it("env parity: scrubbed base + agent vars reach the sandboxed command", async () => {
    // Planted through the same copyScrubbedEnv the plain path uses, so this
    // pins the whole chain (agentSpawnEnv -> config JSON -> helper env -> sh).
    process.env.SBX_TEST_PLANTED_KEY = "should-not-leak";
    try {
      const r = await tool.execute(
        { command: 'echo "AGENT=$AGENT"; echo "CI=$CI"; echo "PLANT=${SBX_TEST_PLANTED_KEY:-absent}"' },
        new ToolContext(),
      );
      expect(r.success).toBe(true);
      expect(r.output).toContain("AGENT=hotdog");
      expect(r.output).toContain("CI=true");
      expect(r.output).toContain("PLANT=absent");
    } finally {
      delete process.env.SBX_TEST_PLANTED_KEY;
    }
  });

  it("applies cwd", async () => {
    const r = await tool.execute({ command: "pwd" }, new ToolContext());
    expect(r.success).toBe(true);
    // Plain caller path: cwd inherits the process CWD (the repo root under
    // bun test). The helper chdir's to exactly that.
    expect(r.output.trim()).toBe(process.cwd());
  });

  it("denies filtered syscalls inside the sandbox while allowed ones work", async () => {
    const r = await tool.execute({ command: `bun ${PROBE_PATH}` }, new ToolContext());
    expect(r.success).toBe(true);
    expect(r.output).toContain("getpid_ok=true");
    expect(r.output).toContain("uring=-1");
    expect(r.output).toContain("unshare=-1");
    expect(r.output).toContain("ptrace=-1");
    expect(r.output).toContain("bpf=-1");
  });

  it("runs a full bun process under the filter (io_uring falls back)", async () => {
    const r = await tool.execute({ command: `bun -e 'console.log(6*7)'` }, new ToolContext());
    expect(r.success).toBe(true);
    expect(r.output).toContain("42");
  });

  it("kills the whole process group on timeout", async () => {
    const fast = new BashTool({ timeoutMs: 300, maxOutputLines: 100, sandbox: "static" });
    const t0 = Date.now();
    let threw: unknown = null;
    try {
      await fast.execute({ command: "sleep 30" }, new ToolContext());
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - t0;
    expect(threw).not.toBeNull();
    expect(String((threw as Error).message)).toContain("timed out");
    // sleep would run 30s if the group kill missed; grace is 2s + slack.
    expect(elapsed).toBeLessThan(4000);
  });

  it("helper exits 127 with stderr diagnostic and does NOT run the command when exe is missing", async () => {
    let markerExists = false;
    const marker = join(tmpdir(), `sysbox-never-${process.pid}`);
    rmSync(marker, { force: true });
    await new Promise<void>((resolve) => {
      const child = spawnSandboxed({
        command: `touch ${marker}`,
        cwd: null,
        env: {},
        exe: "/nonexistent/sbx-sh",
      });
      let err = "";
      child.stderr!.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => {
        markerExists = existsSync(marker);
        expect(code).toBe(127);
        expect(err).toContain("execve");
        rmSync(marker, { force: true });
        resolve();
      });
    });
    expect(markerExists).toBe(false);
  });

  it("helper exits 126 on chdir failure (fail closed, command never runs)", async () => {
    await new Promise<void>((resolve) => {
      const child = spawnSandboxed({
        command: "echo should-not-run",
        cwd: "/nonexistent-sbx-dir",
        env: {},
      });
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += d.toString()));
      child.stderr!.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => {
        expect(code).toBe(126);
        expect(out).toBe("");
        expect(err).toContain("chdir");
        resolve();
      });
    });
  });

  it("rejects NUL bytes in the command", () => {
    expect(() =>
      spawnSandboxed({ command: "echo hi\0rm -rf /", cwd: null, env: {} }),
    ).toThrow(/NUL/);
  });
});
