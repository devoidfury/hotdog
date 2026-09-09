// Pure unit tests for the gate policy oracle (no kernel, no /proc).
// The scratch list is passed explicitly everywhere: the test roots live
// under /tmp themselves, which is exactly the interesting overlap between
// "inside the workspace" and "inside scratch".

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "@utils/workspace.ts";
import { evaluateGate, EACCES, scratchDirs, type GateRequest } from "@utils/sysbox/policy.ts";

const SCRATCH = ["/tmp", "/var/tmp"];

let base: string;
let root: string;
let ws: Workspace;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "sysbox-policy-"));
  root = join(base, "ws");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ok.txt"), "x");
  ws = new Workspace(root);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function req(kind: GateRequest["kind"], paths: (string | null)[], extra: Partial<GateRequest> = {}): GateRequest {
  return { kind, pid: 1, syscall: 0, paths, ...extra };
}

describe("evaluateGate", () => {
  it("allows writes inside the root", () => {
    expect(evaluateGate(ws, req("open.write", [join(root, "new.md")]), SCRATCH)).toEqual({ action: "allow" });
    expect(evaluateGate(ws, req("open.write", [join(root, "ok.txt")]), SCRATCH)).toEqual({ action: "allow" });
  });

  it("asks (not allows) on deny-listed paths INSIDE the root, even under /tmp", () => {
    const d = evaluateGate(ws, req("open.write", [join(root, ".env")]), SCRATCH);
    expect(d.action).toBe("ask");
    expect((d as { why: string }).why).toContain("deny-listed");
    // order test: scratch (/tmp) must NOT win over the deny list
    expect(evaluateGate(ws, req("unlink", [join(root, ".ssh", "id_rsa")]), SCRATCH).action).toBe("ask");
  });

  it("asks on paths outside every root; allows scratch outside roots", () => {
    expect(evaluateGate(ws, req("open.write", ["/etc/passwd"]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("open.write", ["/tmp/scratch-file"]), SCRATCH)).toEqual({ action: "allow" });
    expect(evaluateGate(ws, req("unlink", ["/var/tmp/x"]), SCRATCH)).toEqual({ action: "allow" });
  });

  it("allows device sinks", () => {
    for (const p of ["/dev/null", "/dev/zero", "/dev/urandom"]) {
      expect(evaluateGate(ws, req("open.write", [p]), SCRATCH)).toEqual({ action: "allow" });
    }
  });

  it("asks on symlink escape attempts inside the root", () => {
    const link = join(root, "escape");
    symlinkSync("/etc", link);
    const d = evaluateGate(ws, req("open.write", [join(link, "shadow")]), SCRATCH);
    expect(d.action).toBe("ask");
  });

  it("rename requires both endpoints to pass; worst decision wins", () => {
    expect(evaluateGate(ws, req("rename", [join(root, "a.txt"), join(root, "b.txt")]), SCRATCH)).toEqual({ action: "allow" });
    const outMove = evaluateGate(ws, req("rename", [join(root, "a.txt"), "/tmp/out"]), SCRATCH);
    expect(outMove).toEqual({ action: "allow" }); // /tmp scratch is writable surface
    const inDeny = evaluateGate(ws, req("rename", [join(root, "a.txt"), join(root, ".env")]), SCRATCH);
    expect(inDeny.action).toBe("ask");
    const bothAsk = evaluateGate(ws, req("rename", ["/etc/a", "/etc/b"]), SCRATCH);
    expect(bothAsk.action).toBe("ask");
  });

  it("create/truncate classify the single target path", () => {
    expect(evaluateGate(ws, req("create", [join(root, "dir")]), SCRATCH)).toEqual({ action: "allow" });
    expect(evaluateGate(ws, req("create", [join(root, ".ssh", "authorized_keys")]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("truncate", [join(root, "ok.txt")]), SCRATCH)).toEqual({ action: "allow" });
    expect(evaluateGate(ws, req("truncate", [join(root, ".env")]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("create", [null]), SCRATCH).action).toBe("deny");
  });

  it("link requires both endpoints to pass (hardlink-alias exfil)", () => {
    // aliasing a deny-listed source into allowed scratch must NOT be allow:
    // the alias path alone would pass, the source endpoint must not.
    expect(evaluateGate(ws, req("link", [join(root, ".env"), "/tmp/alias"]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("link", [join(root, ".env"), join(root, "alias")]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("link", ["/etc/passwd", "/tmp/alias"]), SCRATCH).action).toBe("ask");
    expect(evaluateGate(ws, req("link", [join(root, "ok.txt"), join(root, "alias")]), SCRATCH)).toEqual({ action: "allow" });
    expect(evaluateGate(ws, req("link", [join(root, "ok.txt"), null]), SCRATCH).action).toBe("deny");
  });

  it("null (unresolvable) paths deny", () => {
    const d = evaluateGate(ws, req("open.write", [null]), SCRATCH);
    expect(d.action).toBe("deny");
    expect((d as { errno: number }).errno).toBe(EACCES);
  });

  it("connect denies in v1 (gate theater avoided)", () => {
    const d = evaluateGate(ws, req("connect", [], { domain: 2 }));
    expect(d.action).toBe("deny");
    expect((d as { why: string }).why).toContain("connect blocked");
  });

  it("execve always allows (audit-only)", () => {
    expect(evaluateGate(ws, req("execve", [], { argv: ["sh", "-c", "x"] }))).toEqual({ action: "allow" });
  });

  it("no workspace means every fs op denies", () => {
    expect(evaluateGate(null, req("open.write", ["/whatever"]), SCRATCH).action).toBe("deny");
    expect(evaluateGate(null, req("unlink", ["/tmp/x"]), SCRATCH).action).toBe("deny");
    // execve still fine, connect still denied
    expect(evaluateGate(null, req("execve", [])).action).toBe("allow");
  });

  it("scratchDirs honors TMPDIR", () => {
    const dirs = scratchDirs({ TMPDIR: "/scratch/" });
    expect(dirs).toContain("/scratch");
    expect(dirs).toContain("/tmp");
    expect(scratchDirs({})).toEqual(["/tmp", "/var/tmp"]);
  });
});
