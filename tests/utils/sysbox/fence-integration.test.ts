// End-to-end sysbox `fence` mode tests: a real Landlock ruleset installed
// by the helper before exec. Skipped (with a logged reason) where the
// kernel lacks landlock or it is disabled -- the capabilities probe is the
// authority, so this suite runs on modern kernels and skips, not fails,
// elsewhere (docs/sysbox-sandbox.md "Enforcement ladder").
//
// Acceptance: writes outside roots -> EACCES + file not created; reads
// outside roots -> EACCES; workspace RW ok; later-created files inside roots
// covered by the parent-dir rule (no rule re-open); scratch and /dev/null
// stay writable (consistent with policy.ts); deny-listed paths inside roots
// REMAIN reachable in pure fence -- allowlist-only is Landlock's design,
// pinned here so the limitation can't regress silently when gate stacks on
// fence.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { BashTool } from "../../../src/extensions/bash-tool/index.ts";
import { ToolContext } from "../../../src/core/extensions/tool-context.ts";
import { Workspace } from "../../../src/utils/workspace.ts";
import { detectCapabilities } from "../../../src/utils/sysbox/index.ts";

const caps = detectCapabilities();
const suite = caps.landlockAvailable ? describe : describe.skip;

if (!caps.landlockAvailable) {
  console.log(`[sysbox] fence tests skipped: ${caps.reasons.join("; ")}`);
}

suite("sysbox fence mode (real landlock)", () => {
  let base: string;
  let root: string;
  let tool: BashTool;
  let ctx: ToolContext;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "sysbox-fence-"));
    root = join(base, "ws");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "seed.txt"), "seed");
    tool = new BashTool({ timeoutMs: 20000, maxOutputLines: 600, sandbox: "fence" });
    ctx = new ToolContext();
    ctx.set("workspace", new Workspace(root));
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("runs ordinary commands (behavior parity)", async () => {
    const r = await tool.execute({ command: "echo hi; grep -c . /etc/passwd >/dev/null && echo ETC_OK" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("hi");
    expect(r.output).toContain("ETC_OK"); // system ro dirs readable
    expect(r.metadata?.get("exit_code")).toBe("0");
  });

  it("workspace roots read-write, incl. files/dirs created after install", async () => {
    // The parent-dir rule must cover not-yet-existing subtree entries.
    const r = await tool.execute({
      command: `cat ${join(root, "seed.txt")} && mkdir -p ${join(root, "sub/deep")} && echo x > ${join(root, "new.txt")} && echo y > ${join(root, "sub/deep/f.txt")}`,
    }, ctx);
    expect(r.success).toBe(true);
    expect(existsSync(join(root, "new.txt"))).toBe(true);
    expect(existsSync(join(root, "sub/deep/f.txt"))).toBe(true);
  });

  it("blocks writes outside roots and scratch (file not created)", async () => {
    // Home is writable by the unsandboxed user, so a non-created victim
    // proves the kernel denied it (fence roots are under $TMPDIR scratch).
    const victim = join(homedir(), `.sysbox-fence-victim-${process.pid}.txt`);
    try {
      const r = await tool.execute({ command: `echo x > ${victim}; exit $?` }, ctx);
      expect(existsSync(victim)).toBe(false);
      expect(r.metadata?.get("exit_code")).not.toBe("0");
    } finally {
      rmSync(victim, { force: true });
    }
  });

  it("blocks reads outside roots (no content leak)", async () => {
    const victim = join(homedir(), `.sysbox-fence-secret-${process.pid}.txt`);
    writeFileSync(victim, "TOPSECRET-MUST-NOT-LEAK");
    try {
      const r = await tool.execute({ command: `cat ${victim} 2>&1; exit $?` }, ctx);
      expect(r.metadata?.get("exit_code")).not.toBe("0");
      expect(r.output).not.toContain("TOPSECRET");
    } finally {
      rmSync(victim, { force: true });
    }
  });

  it("allows scratch (/tmp) writes and /dev/null", async () => {
    const f = join(tmpdir(), `sysbox-fence-scratch-${process.pid}`);
    const r = await tool.execute({ command: `echo ok > ${f} && cat ${f} && echo sink > /dev/null && echo DEVOK` }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("ok");
    expect(r.output).toContain("DEVOK");
    rmSync(f, { force: true });
  });

  it("deny-listed paths inside roots REMAIN reachable in pure fence (documented Landlock ceiling)", async () => {
    // Landlock is allowlist-only: workspace.deny has no kernel expression.
    // Pinned on purpose -- the gate trap set is what enforces deny entries;
    // if fence ever appears to enforce one, that IS a change in policy.
    const envPath = join(root, ".env");
    try {
      const r = await tool.execute({ command: `echo SECRET=1 > ${envPath}; exit $?` }, ctx);
      expect(r.metadata?.get("exit_code")).toBe("0");
      expect(existsSync(envPath)).toBe(true);
    } finally {
      rmSync(envPath, { force: true });
    }
  });

  // Landlock network rights exist from ABI v4; older kernels simply don't
  // deny bind (documented in config-reference).
  const netIt = caps.landlockAbi >= 4 ? it : it.skip;
  netIt("blocks TCP bind (ABI v4+; abi here: " + caps.landlockAbi + ")", async () => {
    const port = 40000 + (process.pid % 20000);
    const js =
      `const net=require("node:net");const s=net.createServer();` +
      `s.on("error",e=>{console.log("ERR:"+e.code);process.exit(7)});` +
      `s.listen(${port},"127.0.0.1",()=>{console.log("BIND-SUCCEEDED");process.exit(0)});`;
    const r = await tool.execute({ command: `${JSON.stringify(process.execPath)} -e '${js}'` }, ctx);
    expect(r.output).toContain("ERR:EACCES");
    expect(r.metadata?.get("exit_code")).not.toBe("0");
  });
});
