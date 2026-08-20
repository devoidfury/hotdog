// Tests for workspace.ts — path boundary resolution and escape rejection.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, PathEscapeError } from "../../src/utils/workspace.ts";

let workDir: string; // scratch root for the "workspace"
let outsideDir: string; // sibling dir acting as "outside the workspace"
let ws: Workspace;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-workspace-"));
  workDir = path.join(base, "ws");
  outsideDir = path.join(base, "outside");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, "sub", "deep"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "file.txt"), "hello");
  ws = new Workspace(workDir);
});

afterAll(() => {
  const base = path.dirname(workDir);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("PathEscapeError", () => {
  it("is a ToolError with name set", () => {
    const e = new PathEscapeError("boom");
    expect(e.name).toBe("PathEscapeError");
    expect(e.message).toBe("boom");
  });

  it("invalidInput includes the bad value", () => {
    expect(PathEscapeError.invalidInput("").message).toContain("Invalid path");
    expect(PathEscapeError.invalidInput(undefined).message).toBe("Invalid path: undefined");
  });

  it("directEscape is distinguishable", () => {
    const e = PathEscapeError.directEscape("../x");
    expect(e).toBeInstanceOf(PathEscapeError);
    expect(e.message).toBe("Path escape rejected: ../x");
  });

  it("symlinkEscape is distinguishable", () => {
    const e = PathEscapeError.symlinkEscape("link");
    expect(e).toBeInstanceOf(PathEscapeError);
    expect(e.message).toBe("Symlink escape rejected: link");
  });
});

describe("Workspace constructor", () => {
  it("resolves a relative root against the process CWD", () => {
    const w = new Workspace("some/dir");
    expect(w.root).toBe(path.resolve("some/dir"));
  });

  it("resolves the scratch root to an absolute path", () => {
    expect(ws.root).toBe(workDir);
    expect(path.isAbsolute(ws.root)).toBe(true);
  });
});

describe("resolveSafe — valid paths", () => {
  it("returns the root for '.'", () => {
    expect(ws.resolveSafe(".")).toBe(workDir);
  });

  it("resolves an existing file", () => {
    expect(ws.resolveSafe("file.txt")).toBe(path.join(workDir, "file.txt"));
  });

  it("resolves a nested path", () => {
    expect(ws.resolveSafe("sub/deep/notes.md")).toBe(path.join(workDir, "sub", "deep", "notes.md"));
  });

  it("resolves a path that does not exist yet (planned write)", () => {
    expect(ws.resolveSafe("brand/new/file.txt")).toBe(path.join(workDir, "brand", "new", "file.txt"));
  });

  it("normalizes internal .. that stay inside the root", () => {
    expect(ws.resolveSafe("sub/deep/../../file.txt")).toBe(path.join(workDir, "file.txt"));
  });

  it("accepts an absolute path inside the root", () => {
    expect(ws.resolveSafe(path.join(workDir, "file.txt"))).toBe(path.join(workDir, "file.txt"));
  });

  it("accepts a dangling symlink whose target stays inside the root", () => {
    const link = path.join(workDir, "dangle-in");
    fs.symlinkSync(path.join(workDir, "sub/never-existed"), link);
    expect(ws.resolveSafe("dangle-in")).toBe(link);
    fs.unlinkSync(link);
  });
});

describe("resolveSafe — invalid input", () => {
  it("rejects an empty string", () => {
    expect(() => ws.resolveSafe("")).toThrow(PathEscapeError);
    expect(() => ws.resolveSafe("")).toThrow("Invalid path");
  });

  it("rejects non-string values", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ws.resolveSafe(undefined as any)).toThrow(PathEscapeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => ws.resolveSafe(null as any)).toThrow(PathEscapeError);
  });
});

describe("resolveSafe — direct escapes", () => {
  it("rejects .. past the root", () => {
    expect(() => ws.resolveSafe("../evil")).toThrow(PathEscapeError);
    expect(() => ws.resolveSafe("../evil")).toThrow("Path escape rejected");
  });

  it("rejects deep .. past the root", () => {
    expect(() => ws.resolveSafe("../../../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => ws.resolveSafe("/etc/passwd")).toThrow(PathEscapeError);
  });

  it("allows .. that normalizes back to a path inside the root", () => {
    // Lexical traversal: the normalized result is what matters, and it is inside.
    expect(ws.resolveSafe("../" + path.basename(workDir) + "/file.txt")).toBe(path.join(workDir, "file.txt"));
  });

  it("rejects a sibling root with a shared prefix", () => {
    // workDir = <base>/ws; <base>/ws-evil is a different directory
    const evil = workDir + "-evil";
    expect(() => ws.resolveSafe("../ws-evil/file.txt")).toThrow(PathEscapeError);
    fs.mkdirSync(evil, { recursive: true });
    expect(() => ws.resolveSafe("../ws-evil/file.txt")).toThrow(PathEscapeError);
    fs.rmSync(evil, { recursive: true, force: true });
  });
});

describe("resolveSafe — symlink escapes", () => {
  it("rejects an existing symlink to a file outside the root", () => {
    const target = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(workDir, "out-file");
    fs.symlinkSync(target, link);
    expect(() => ws.resolveSafe("out-file")).toThrow(PathEscapeError);
    expect(() => ws.resolveSafe("out-file")).toThrow("Symlink escape rejected");
    fs.unlinkSync(link);
  });

  it("rejects an existing symlink to a directory outside the root", () => {
    const link = path.join(workDir, "out-dir");
    fs.symlinkSync(outsideDir, link);
    expect(() => ws.resolveSafe("out-dir")).toThrow(PathEscapeError);
    expect(() => ws.resolveSafe("out-dir/anything")).toThrow(PathEscapeError);
    fs.unlinkSync(link);
  });

  it("rejects a symlink in an intermediate component", () => {
    const outsideSub = path.join(outsideDir, "nested");
    fs.mkdirSync(outsideSub, { recursive: true });
    const link = path.join(workDir, "sub", "out-mid");
    fs.symlinkSync(outsideSub, link);
    expect(() => ws.resolveSafe("sub/out-mid/file.txt")).toThrow(PathEscapeError);
    fs.unlinkSync(link);
  });

  it("rejects a dangling symlink (absolute target outside) that the existsSync walk cannot see", () => {
    const link = path.join(workDir, "dangle-out");
    fs.symlinkSync(path.join(outsideDir, "never-created.txt"), link);
    expect(() => ws.resolveSafe("dangle-out")).toThrow(PathEscapeError);
    expect(() => ws.resolveSafe("dangle-out")).toThrow("Symlink escape rejected");
    fs.unlinkSync(link);
  });

  it("rejects a dangling symlink with a relative target escaping the root", () => {
    const link = path.join(workDir, "dangle-rel");
    fs.symlinkSync("../outside/never-created.txt", link);
    expect(() => ws.resolveSafe("dangle-rel")).toThrow(PathEscapeError);
    fs.unlinkSync(link);
  });

  it("rejects a dangling symlink in a nested location", () => {
    const link = path.join(workDir, "sub", "deep", "dangle");
    fs.symlinkSync(path.join(outsideDir, "never-created.txt"), link);
    expect(() => ws.resolveSafe("sub/deep/dangle")).toThrow(PathEscapeError);
    fs.unlinkSync(link);
  });

  it("rejects a chain of symlinks ending outside the root", () => {
    const mid = path.join(workDir, "chain-mid");
    const end = path.join(workDir, "chain-end");
    fs.symlinkSync(mid, end); // end -> mid (inside)
    fs.symlinkSync(path.join(outsideDir, "never-created.txt"), mid); // mid -> outside (dangling)
    expect(() => ws.resolveSafe("chain-end")).toThrow(PathEscapeError);
    fs.unlinkSync(mid);
    fs.unlinkSync(end);
  });

  it("allows a chain of symlinks that stays inside the root", () => {
    const mid = path.join(workDir, "chain2-mid");
    const end = path.join(workDir, "chain2-end");
    fs.symlinkSync(path.join(workDir, "sub"), mid);
    fs.symlinkSync(mid, end); // end -> mid -> sub (all inside)
    expect(ws.resolveSafe("chain2-end")).toBe(end);
    fs.unlinkSync(mid);
    fs.unlinkSync(end);
  });
});

describe("resolveSafe — root accessed through a symlink", () => {
  it("resolves paths when the root itself is a symlink to a real dir", () => {
    const real = path.join(outsideDir, "real-ws");
    fs.mkdirSync(real, { recursive: true });
    const linkRoot = path.join(outsideDir, "link-ws");
    fs.symlinkSync(real, linkRoot, "dir");
    const w = new Workspace(linkRoot);

    // The root's real path differs from its lexical path; both must be honored.
    expect(w.resolveSafe(".")).toBe(linkRoot);
    expect(w.resolveSafe("a.txt")).toBe(path.join(linkRoot, "a.txt"));
    expect(() => w.resolveSafe("../real-ws/a.txt")).toThrow(PathEscapeError);

    fs.unlinkSync(linkRoot);
  });
});

describe("contains", () => {
  it("is true for paths inside the root", () => {
    expect(ws.contains(path.join(workDir, "file.txt"))).toBe(true);
    expect(ws.contains(path.join(workDir, "sub", "deep", "x"))).toBe(true);
  });

  it("is true for the root itself", () => {
    expect(ws.contains(workDir)).toBe(true);
  });

  it("is false for paths outside the root", () => {
    expect(ws.contains(path.join(outsideDir, "file.txt"))).toBe(false);
    expect(ws.contains("/etc/passwd")).toBe(false);
  });

  it("is false for a sibling with a shared name prefix", () => {
    expect(ws.contains(workDir + "-evil")).toBe(false);
    expect(ws.contains(workDir + "/../outside")).toBe(false);
  });
});

describe("relative", () => {
  it("converts an inside path to workspace-relative", () => {
    expect(ws.relative(path.join(workDir, "file.txt"))).toBe("file.txt");
    expect(ws.relative(path.join(workDir, "sub", "deep", "x"))).toBe("sub/deep/x");
  });

  it("returns an empty string for the root", () => {
    expect(ws.relative(workDir)).toBe("");
  });

  it("normalizes dot segments in the input", () => {
    expect(ws.relative(path.join(workDir, "sub", "..", "file.txt"))).toBe("file.txt");
  });

  it("returns null for paths outside the root", () => {
    expect(ws.relative(path.join(outsideDir, "file.txt"))).toBeNull();
    expect(ws.relative("/etc/passwd")).toBeNull();
  });

  it("returns null for a sibling with a shared name prefix", () => {
    expect(ws.relative(workDir + "-evil")).toBeNull();
  });
});
