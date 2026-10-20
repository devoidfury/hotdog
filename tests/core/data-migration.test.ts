import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDataLayout, type LayoutFs } from "@core/data-migration.ts";

describe("migrateDataLayout (real fs)", () => {
  let root: string;
  let data: string;
  let sessions: string;
  let savedData: string | undefined;
  let savedSessions: string | undefined;

  beforeEach(() => {
    savedData = process.env.HOTDOG_DATA_DIR;
    savedSessions = process.env.HOTDOG_SESSIONS_DIR;
    root = mkdtempSync(join(tmpdir(), "hotdog-migrate-"));
    data = join(root, "data");
    sessions = join(data, "sessions");
    mkdirSync(sessions, { recursive: true });
    process.env.HOTDOG_DATA_DIR = data;
    delete process.env.HOTDOG_SESSIONS_DIR;
  });

  afterEach(() => {
    // Restore, do not delete: under a single-process `bun test` the pin from
    // tests/setup.ts must survive this file for the ones scheduled after it.
    if (savedData === undefined) delete process.env.HOTDOG_DATA_DIR;
    else process.env.HOTDOG_DATA_DIR = savedData;
    if (savedSessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = savedSessions;
    rmSync(root, { recursive: true, force: true });
  });

  function seedDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.txt"), dir);
    return dir;
  }

  it("moves workflows from the sessions dir into the data dir", () => {
    const old = seedDir(join(sessions, "workflows"));
    migrateDataLayout();
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it("moves task-lanes too, in the same pass", () => {
    seedDir(join(sessions, "workflows"));
    seedDir(join(sessions, "task-lanes"));
    migrateDataLayout();
    expect(existsSync(join(data, "task-lanes", "marker.txt"))).toBe(true);
    expect(existsSync(join(sessions, "task-lanes"))).toBe(false);
  });

  it("leaves session logs untouched in the sessions dir", () => {
    writeFileSync(join(sessions, "abc123.jsonl"), "{}\n");
    seedDir(join(sessions, "workflows"));
    migrateDataLayout();
    expect(existsSync(join(sessions, "abc123.jsonl"))).toBe(true);
  });

  it("is a silent no-op when nothing is at the old locations", () => {
    seedDir(join(data, "workflows"));
    migrateDataLayout();
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
    expect(existsSync(join(sessions, "workflows"))).toBe(false);
  });

  it("never merges or deletes when both locations exist", () => {
    const old = seedDir(join(sessions, "workflows"));
    seedDir(join(data, "workflows"));
    migrateDataLayout();
    expect(existsSync(join(old, "marker.txt"))).toBe(true);
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
  });

  it("leaves a stray file at the old location in place", () => {
    writeFileSync(join(sessions, "workflows"), "not a dir");
    migrateDataLayout();
    expect(readFileSync(join(sessions, "workflows"), "utf-8")).toBe("not a dir");
    expect(existsSync(join(data, "workflows"))).toBe(false);
  });

  it("honors a HOTDOG_SESSIONS_DIR override for the old locations", () => {
    const custom = join(root, "elsewhere");
    seedDir(join(custom, "workflows"));
    process.env.HOTDOG_SESSIONS_DIR = custom;
    migrateDataLayout();
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
    expect(existsSync(join(custom, "workflows"))).toBe(false);
  });

  it("creates a fresh HOTDOG_DATA_DIR and migrates into it", () => {
    // tmpfs sessions dir + a data dir that does not exist yet: the rename
    // would ENOENT on the missing parent and silently orphan the old data.
    const tmpfs = join(root, "tmpfs-sessions");
    const old = seedDir(join(tmpfs, "workflows"));
    process.env.HOTDOG_SESSIONS_DIR = tmpfs;
    process.env.HOTDOG_DATA_DIR = join(root, "fresh-data");
    migrateDataLayout();
    expect(existsSync(join(root, "fresh-data", "workflows", "marker.txt"))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it("skips when the old and new resolutions are the same path", () => {
    // Degenerate env: sessions dir == data dir.
    process.env.HOTDOG_SESSIONS_DIR = data;
    seedDir(join(data, "workflows"));
    expect(() => migrateDataLayout()).not.toThrow();
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
  });

  it("runs twice without incident (idempotent)", () => {
    seedDir(join(sessions, "workflows"));
    seedDir(join(sessions, "task-lanes"));
    migrateDataLayout();
    migrateDataLayout();
    expect(existsSync(join(data, "workflows", "marker.txt"))).toBe(true);
    expect(existsSync(join(data, "task-lanes", "marker.txt"))).toBe(true);
  });
});

describe("migrateDataLayout (injected fs: EXDEV + races)", () => {
  // Loose call recorder: the real signatures take PathLike; the fakes only
  // ever see the strings migration passes. Method syntax keeps the params
  // bivariant so these satisfy the LayoutFs property types.
  interface FakeFs {
    exists?(p: string): boolean;
    mkdir?(p: string): void;
    rename?(from: string, to: string): void;
    copy?(from: string, to: string): void;
    rm?(from: string): void;
  }

  let calls: string[];
  let savedData: string | undefined;
  let savedSessions: string | undefined;

  function fakeFs(overrides: FakeFs): LayoutFs {
    return {
      lstat: () => ({ isDirectory: () => true }),
      // True for the roots (so the fresh-install guard passes), false for
      // the new target locations (so the both-exist branch stays closed).
      exists: (p: string) => !p.endsWith("workflows") && !p.endsWith("task-lanes"),
      mkdir: () => {},
      rename: () => {},
      copy: () => {},
      rm: () => {},
      ...overrides,
    };
  }

  beforeEach(() => {
    savedData = process.env.HOTDOG_DATA_DIR;
    savedSessions = process.env.HOTDOG_SESSIONS_DIR;
    calls = [];
    process.env.HOTDOG_DATA_DIR = "/data";
    delete process.env.HOTDOG_SESSIONS_DIR;
  });

  afterEach(() => {
    if (savedData === undefined) delete process.env.HOTDOG_DATA_DIR;
    else process.env.HOTDOG_DATA_DIR = savedData;
    if (savedSessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = savedSessions;
  });

  function errnoError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  it("creates the data dir before moving", () => {
    const fs = fakeFs({
      mkdir: (p: string) => calls.push(`mkdir:${p}`),
      rename: (from: string, to: string) => calls.push(`rename:${from}->${to}`),
    });
    migrateDataLayout(fs);
    expect(calls).toContain("mkdir:/data");
    expect(calls).toContain("rename:/data/sessions/workflows->/data/workflows");
  });

  it("falls back to copy+delete across filesystems", () => {
    const fs = fakeFs({
      rename: (from: string) => {
        calls.push(`rename:${from}`);
        throw errnoError("EXDEV");
      },
      copy: (from: string, to: string) => calls.push(`copy:${from}->${to}`),
      rm: (from: string) => calls.push(`rm:${from}`),
    });
    migrateDataLayout(fs);
    expect(calls).toContain("copy:/data/sessions/workflows->/data/workflows");
    expect(calls).toContain("rm:/data/sessions/workflows");
    expect(calls).toContain("copy:/data/sessions/task-lanes->/data/task-lanes");
  });

  it("a failed source removal after cross-device copy is survived", () => {
    const fs = fakeFs({
      rename: () => {
        throw errnoError("EXDEV");
      },
      rm: () => {
        throw errnoError("EBUSY");
      },
    });
    // The rm throw happens for both dirs; migrateDataLayout must not throw.
    expect(() => migrateDataLayout(fs)).not.toThrow();
  });

  it("a lost race (ENOENT on rename) is silent, not a failure", () => {
    const fs = fakeFs({
      rename: () => {
        throw errnoError("ENOENT");
      },
    });
    expect(() => migrateDataLayout(fs)).not.toThrow();
  });

  it("a new-dir-appeared race (ENOTEMPTY on rename) keeps the old dir", () => {
    const fs = fakeFs({
      rename: () => {
        throw errnoError("ENOTEMPTY");
      },
      copy: (from: string) => calls.push(`copy:${from}`),
      rm: (from: string) => calls.push(`rm:${from}`),
    });
    expect(() => migrateDataLayout(fs)).not.toThrow();
    expect(calls).toEqual([]); // no copy, no delete -- hands off
  });

  it("an unexpected rename error is swallowed with a warn, startup continues", () => {
    const fs = fakeFs({
      rename: () => {
        throw errnoError("EACCES");
      },
    });
    expect(() => migrateDataLayout(fs)).not.toThrow();
  });

  it("skips all work when neither the data nor sessions dir exists", () => {
    const fs = fakeFs({
      exists: () => false,
      rename: (from: string) => calls.push(`rename:${from}`),
    });
    migrateDataLayout(fs);
    // The cheap guard means not even a rename happens for a fresh install.
    expect(calls).toEqual([]);
  });
});
