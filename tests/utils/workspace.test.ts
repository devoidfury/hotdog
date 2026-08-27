// Tests for workspace.ts — path boundary resolution and escape rejection.

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, PathEscapeError, expandWorkspacePaths } from "../../src/utils/workspace.ts";
import { ConfigError } from "../../src/core/error.ts";
import { logger } from "../../src/core/logger.ts";

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

describe("Workspace — multi-root", () => {
  let rootA: string; // primary
  let rootB: string; // secondary
  let sibling: string; // shares a prefix with rootB but is outside all roots
  let multi: Workspace;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-multi-"));
    rootA = path.join(base, "a");
    rootB = path.join(base, "b");
    sibling = path.join(base, "b-evil");
    fs.mkdirSync(path.join(rootA, "sub"), { recursive: true });
    fs.mkdirSync(path.join(rootB, "sub"), { recursive: true });
    fs.writeFileSync(path.join(rootA, "same.txt"), "A");
    fs.writeFileSync(path.join(rootB, "same.txt"), "B");
    multi = new Workspace([rootA, rootB]);
  });

  afterAll(() => {
    fs.rmSync(path.dirname(rootA), { recursive: true, force: true });
  });

  it("stores roots in config order", () => {
    expect(multi.roots).toEqual([rootA, rootB]);
  });

  it("root getter returns the primary root", () => {
    expect(multi.root).toBe(rootA);
  });

  it("throws on an empty roots array", () => {
    expect(() => new Workspace([])).toThrow(ConfigError);
  });

  it("resolves relative paths under the primary root only", () => {
    expect(multi.resolveSafe("same.txt")).toBe(path.join(rootA, "same.txt"));
  });

  it("resolves relative paths under the primary even when the same relative exists under the secondary", () => {
    expect(multi.resolveSafe("sub/..")).toBe(rootA);
    expect(multi.resolveSafe("same.txt")).not.toBe(path.join(rootB, "same.txt"));
  });

  it("accepts an absolute path inside the secondary root", () => {
    expect(multi.resolveSafe(path.join(rootB, "same.txt"))).toBe(path.join(rootB, "same.txt"));
    expect(multi.resolveSafe(path.join(rootB, "brand/new.txt"))).toBe(path.join(rootB, "brand", "new.txt"));
  });

  it("rejects an absolute path outside all roots", () => {
    expect(() => multi.resolveSafe("/etc/passwd")).toThrow(PathEscapeError);
    expect(() => multi.resolveSafe("/etc/passwd")).toThrow("Path escape rejected");
  });

  it("accepts .. that leaves the primary root but lands inside the secondary root", () => {
    // Design: relative paths resolve against the primary, and the result is
    // accepted if it falls inside ANY root.
    expect(multi.resolveSafe("../b/same.txt")).toBe(path.join(rootB, "same.txt"));
  });

  it("rejects .. escapes that leave all roots", () => {
    expect(() => multi.resolveSafe("../../../../etc/passwd")).toThrow(PathEscapeError);
    expect(() => multi.resolveSafe("../a-evil/x")).toThrow(PathEscapeError);
  });

  it("rejects a sibling root that shares a name prefix with a configured root", () => {
    expect(() => multi.resolveSafe(path.join(sibling, "x"))).toThrow(PathEscapeError);
    fs.mkdirSync(sibling, { recursive: true });
    expect(() => multi.resolveSafe(path.join(sibling, "x"))).toThrow(PathEscapeError);
  });

  it("rejects a symlink inside the secondary root that points outside", () => {
    const target = path.join(os.tmpdir(), "hotdog-multi-outside.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(rootB, "out-link");
    fs.symlinkSync(target, link);
    expect(() => multi.resolveSafe(path.join(rootB, "out-link"))).toThrow(PathEscapeError);
    expect(() => multi.resolveSafe(path.join(rootB, "out-link"))).toThrow("Symlink escape rejected");
    fs.unlinkSync(link);
    fs.unlinkSync(target);
  });

  it("accepts a symlink that points into another configured root", () => {
    // Directory symlink in the primary root pointing at the secondary root.
    const dirLink = path.join(rootA, "to-b");
    fs.symlinkSync(rootB, dirLink);
    expect(multi.resolveSafe(path.join(dirLink, "same.txt"))).toBe(path.join(dirLink, "same.txt"));
    fs.unlinkSync(dirLink);

    // Final-component symlink pointing at a file in the secondary root
    // (exercises the dangling-link probe loop, not the ancestor walk).
    const fileLink = path.join(rootA, "to-b-file");
    fs.symlinkSync(path.join(rootB, "same.txt"), fileLink);
    expect(multi.resolveSafe(fileLink)).toBe(fileLink);
    fs.unlinkSync(fileLink);
  });

  it("rejects a dangling symlink final component under the secondary root", () => {
    const link = path.join(rootB, "dangle");
    fs.symlinkSync(path.join(os.tmpdir(), "hotdog-multi-never-created.txt"), link);
    expect(() => multi.resolveSafe(path.join(rootB, "dangle"))).toThrow(PathEscapeError);
    expect(() => multi.resolveSafe(path.join(rootB, "dangle"))).toThrow("Symlink escape rejected");
    fs.unlinkSync(link);
  });

  it("contains() is true for any configured root", () => {
    expect(multi.contains(path.join(rootA, "sub", "x"))).toBe(true);
    expect(multi.contains(path.join(rootB, "sub", "x"))).toBe(true);
    expect(multi.contains(rootB)).toBe(true);
    expect(multi.contains(path.join(sibling, "x"))).toBe(false);
    expect(multi.contains("/etc/passwd")).toBe(false);
  });

  it("relative() uses the first containing root in config order", () => {
    expect(multi.relative(path.join(rootA, "same.txt"))).toBe("same.txt");
    expect(multi.relative(path.join(rootB, "same.txt"))).toBe("same.txt");
    expect(multi.relative(rootB)).toBe("");
    expect(multi.relative(path.join(sibling, "x"))).toBeNull();
  });

  it("nested roots: inner root wins for its own paths", () => {
    const inner = path.join(rootA, "sub");
    const w = new Workspace([inner, rootA]);
    expect(w.root).toBe(inner);
    expect(w.resolveSafe("x.txt")).toBe(path.join(inner, "x.txt"));
    expect(w.relative(path.join(rootA, "same.txt"))).toBe("same.txt");
  });
});

describe("expandWorkspacePaths", () => {
  let base: string;
  let cwdBefore: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-expand-"));
    fs.mkdirSync(path.join(base, "proj"), { recursive: true });
    fs.mkdirSync(path.join(base, "glob", "one"), { recursive: true });
    fs.mkdirSync(path.join(base, "glob", "two"), { recursive: true });
    fs.writeFileSync(path.join(base, "glob", "f1.txt"), "1");
    fs.writeFileSync(path.join(base, "glob", "f2.txt"), "2");
    fs.mkdirSync(path.join(base, "brace-a"), { recursive: true });
    fs.mkdirSync(path.join(base, "brace-b"), { recursive: true });
    cwdBefore = process.cwd();
    process.chdir(cwdBefore); // ensure deterministic relative resolution
  });

  afterAll(() => {
    process.chdir(cwdBefore);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("returns absolute paths for absolute entries", () => {
    expect(expandWorkspacePaths([path.join(base, "proj")])).toEqual([path.join(base, "proj")]);
  });

  it("resolves relative entries against the process CWD", () => {
    process.chdir(base);
    expect(expandWorkspacePaths(["proj"])).toEqual([path.join(base, "proj")]);
  });

  it("expands a leading ~ to the home directory", () => {
    // We can't change os.homedir(); verify ~ entries resolve under homedir().
    const expanded = expandWorkspacePaths(["~"]);
    expect(expanded[0]).toBe(os.homedir());
  });

  it("expands a glob into all its matches (files and dirs)", () => {
    const expected = [
      path.join(base, "glob", "f1.txt"),
      path.join(base, "glob", "f2.txt"),
      path.join(base, "glob", "one"),
      path.join(base, "glob", "two"),
    ].sort();
    expect(expandWorkspacePaths([path.join(base, "glob", "*")]).sort()).toEqual(expected);
  });

  it("expands brace patterns", () => {
    const expected = [path.join(base, "brace-a"), path.join(base, "brace-b")].sort();
    expect(
      expandWorkspacePaths([`${base}/brace-{a,b}`]).sort(),
    ).toEqual(expected);
  });

  it("warns and drops a glob that matches nothing", () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      expect(expandWorkspacePaths([path.join(base, "no-such-pattern-*.txt")])).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to a literal path when a glob matches nothing but the path exists", () => {
    // Directory whose name contains glob magic; the glob form matches
    // nothing, but the literal path exists and must be kept.
    const bracketed = path.join(base, "my[1]dir");
    fs.mkdirSync(bracketed, { recursive: true });
    expect(expandWorkspacePaths([bracketed])).toEqual([bracketed]);
  });

  it("throws for an explicit path that does not exist", () => {
    expect(() =>
      expandWorkspacePaths([path.join(base, "never-created")]),
    ).toThrow(ConfigError);
  });

  it("throws for a non-array input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => expandWorkspacePaths("/somewhere" as any)).toThrow(ConfigError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => expandWorkspacePaths(null as any)).toThrow(ConfigError);
  });

  it("throws for an empty array", () => {
    expect(() => expandWorkspacePaths([])).toThrow(ConfigError);
  });

  it("throws for empty-string and non-string entries", () => {
    expect(() => expandWorkspacePaths([""])).toThrow(ConfigError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => expandWorkspacePaths([42 as any])).toThrow(ConfigError);
  });

  it("dedupes while preserving order", () => {
    const p = path.join(base, "proj");
    expect(expandWorkspacePaths([p, p, path.join(base, "glob", "f1.txt"), p])).toEqual([
      p,
      path.join(base, "glob", "f1.txt"),
    ]);
  });
});
