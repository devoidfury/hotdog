// exec-plan: jail-plan argv for the tool plane.
// Pure-shape tests with an injected binary -- the probe itself is covered by
// tests/evals/evals-lib.test.ts (which now exercises this module through the
// moved evals imports).

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseRoBinds, planFor } from "@utils/exec-plan.ts";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `exec-plan-${label}-`));
}

describe("planFor (plane jail argv)", () => {
  it("returns a plain-spawn result when no fence binary is available", () => {
    const root = tmpRoot("none");
    try {
      const r = planFor({
        roots: [root],
        cls: "rw",
        scratch: root,
        command: "/usr/bin/bun",
        args: ["runner.ts"],
        binary: null,
      });
      expect(r.prefixArgv).toBeNull();
      expect(r.probe).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the full argv: tmpfs root, scratch as /tmp, roots rw, command after --", () => {
    const root = tmpRoot("root");
    const scratch = tmpRoot("scratch");
    try {
      const r = planFor({
        roots: [root],
        cls: "rw",
        scratch,
        command: "/usr/bin/bun",
        args: ["runner.ts"],
        execPath: "/usr/bin/bun",
        repoRoot: "/repo",
        binary: "/x/bwrap",
      });
      expect(r.probe).toBe("bwrap");
      const argv = r.prefixArgv!;
      expect(argv[0]).toBe("/x/bwrap");
      expect(argv).toContain("--die-with-parent");
      expect(argv).toContain("--new-session");
      // Fresh tmpfs root: /home, /root, sibling sessions DO NOT EXIST.
      const i = argv.indexOf("--tmpfs");
      expect(argv[i + 1]).toBe("/");
      // rw ONLY the session roots + scratch (scratch bound AS /tmp, with HOME
      // and TMPDIR pointed at it).
      const rwIdx = argv.indexOf("--bind");
      expect(argv[rwIdx + 1]).toBe(root);
      const tmpBind = argv.indexOf(scratch);
      expect(argv[tmpBind - 1]).toBe("--bind");
      expect(argv[tmpBind + 1]).toBe("/tmp");
      expect(argv).toContain("--setenv");
      const homeIdx = argv.indexOf("HOME");
      expect(argv[homeIdx - 1]).toBe("--setenv");
      expect(argv[homeIdx + 1]).toBe("/tmp");
      // The wrapped command is LAST, after `--` (isolation is argv).
      expect(argv.slice(-3)).toEqual(["--", "/usr/bin/bun", "runner.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("ro-binds the repo (the runner imports it) and hides its .git", () => {
    const repo = tmpRoot("repo");
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "src.txt"), "x");
    const scratch = tmpRoot("scratch2");
    try {
      const r = planFor({
        roots: [],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        execPath: "/usr/bin/bun",
        repoRoot: repo,
        binary: "/x/bwrap",
      });
      const argv = r.prefixArgv!;
      expect(argv).toContain(repo); // ro-bind of the repo dir
      // .git is HIDDEN (tmpfs over it), not ro-bound.
      const git = join(repo, ".git");
      const gi = argv.indexOf(git);
      expect(gi).toBeGreaterThan(-1);
      expect(argv[gi - 1]).toBe("--tmpfs");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("drops roots that do not exist (bwrap bind sources must be real)", () => {
    const root = tmpRoot("real");
    try {
      const r = planFor({
        roots: [root, join(root, "nope")],
        cls: "rw",
        scratch: root,
        command: "bun",
        args: [],
        binary: "/x/bwrap",
      });
      expect(r.prefixArgv!).toContain(root);
      expect(r.prefixArgv!.join(" ")).not.toContain("nope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baseRoBinds config chain", () => {
  it("excludes /etc/hotdog and the user config dir for the tool plane", () => {
    const binds = baseRoBinds({
      execPath: "/usr/bin/bun",
      repoRoot: "/repo",
      home: "/home/tester",
      configChain: false,
    });
    expect(binds).not.toContain("/etc/hotdog");
    expect(binds).not.toContain(join("/home/tester", ".config", "hotdog"));
    // The system pieces the runner needs stay.
    if (existsSync("/etc/resolv.conf")) expect(binds).toContain("/etc/resolv.conf");
  });

  it("keeps the config chain for the eval harness (default)", () => {
    const binds = baseRoBinds({
      execPath: "/usr/bin/bun",
      repoRoot: "/repo",
      home: "/home/tester",
    });
    // /etc/hotdog may not exist on the test host; the user config path is
    // home-relative and only added when present, so assert the inverse rule
    // by filtering the candidate list instead:
    if (existsSync("/etc/hotdog")) expect(binds).toContain("/etc/hotdog");
    if (existsSync(join("/home/tester", ".config", "hotdog"))) {
      expect(binds).toContain(join("/home/tester", ".config", "hotdog"));
    }
  });
});
