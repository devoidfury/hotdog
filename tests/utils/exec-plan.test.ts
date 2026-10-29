// exec-plan: jail-plan argv for the tool plane.
// Pure-shape tests with an injected binary -- the probe itself is covered by
// tests/evals/evals-lib.test.ts (which now exercises this module through the
// moved evals imports).

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseRoBinds,
  bwrapAvailable,
  findBwrap,
  NO_EGRESS_CLASS,
  noEgressBinary,
  planFor,
} from "@utils/exec-plan.ts";

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
      // Process isolation is explicit, not namespace-default (N-1): without
      // these the jail shares the host PID namespace and jailed code could
      // see and SIGKILL host processes.
      expect(argv).toContain("--unshare-pid");
      expect(argv).toContain("--unshare-ipc");
      expect(argv).toContain("--unshare-uts");
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

  it("ro-binds the repo (the runner imports it) and leaves its .git visible", () => {
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
      // .git is NOT hidden -- git status/history read through the ro repo bind.
      const git = join(repo, ".git");
      expect(argv).not.toContain(git);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("mounts /dev and /proc after an rw \"/\" root (bun aborts on a shadowed /proc)", () => {
    const scratch = tmpRoot("rootbind");
    try {
      const r = planFor({
        roots: ["/"],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        repoRoot: "/nonexistent-repo",
        binary: "/x/bwrap",
      });
      const argv = r.prefixArgv!;
      const devIdx = argv.indexOf("--dev");
      // The rw bind (`--bind / /`) must be mounted before --dev/--proc, not after.
      let rootBindIdx = -1;
      for (let i = 0; i < devIdx; i++) {
        if (argv[i] === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/") rootBindIdx = i;
      }
      expect(rootBindIdx).toBeGreaterThan(-1);
      expect(argv.indexOf("/dev")).toBeGreaterThan(rootBindIdx);
      expect(argv.indexOf("/proc")).toBeGreaterThan(rootBindIdx);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("unshares the PID namespace before the /proc mount (the jail's /proc shows only its own pids)", () => {
    const scratch = tmpRoot("pidns");
    try {
      const r = planFor({
        roots: ["/"],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        repoRoot: "/nonexistent-repo",
        binary: "/x/bwrap",
      });
      const argv = r.prefixArgv!;
      // Order matters: --proc must come after --unshare-pid (and after every
      // bind, the sibling test above pins), so the /proc the jail sees is
      // the NEW namespace's procfs, not a host copy.
      expect(argv.indexOf("--unshare-pid")).toBeLessThan(argv.indexOf("--proc"));
      expect(argv.indexOf("--unshare-ipc")).toBeLessThan(argv.indexOf("--proc"));
      expect(argv.indexOf("--unshare-uts")).toBeLessThan(argv.indexOf("--proc"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("never tmpfs-es .git when the workspace IS the repo (rw bind must keep it writable)", () => {
    const root = tmpRoot("gitrw");
    mkdirSync(join(root, ".git"));
    const scratch = tmpRoot("gitrw-scratch");
    try {
      // Workspace == the repo: git status/history/commits must work, so no
      // tmpfs (initial or re-asserted) may cover .git after the rw bind.
      const r = planFor({
        roots: [root],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        repoRoot: root,
        binary: "/x/bwrap",
      });
      const argv = r.prefixArgv!;
      const git = join(root, ".git");
      expect(argv).not.toContain(git);
      const bindIdx = argv.indexOf("--bind");
      expect(argv[bindIdx + 1]).toBe(root); // the rw bind that makes .git writable
    } finally {
      rmSync(root, { recursive: true, force: true });
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

// ── Hard net-block tier ──────────────────────────────────────────────────────

describe("planFor hard net-block tier (NO_EGRESS_CLASS)", () => {
  it("a missing jail refuses the hard tier and degrades the soft ones", () => {
    const root = tmpRoot("hard-refuse");
    try {
      const soft = planFor({
        roots: [root],
        cls: "rw",
        scratch: root,
        command: "/usr/bin/bun",
        args: ["runner.ts"],
        binary: null,
      });
      expect(soft.prefixArgv).toBeNull();
      expect(soft.refusal).toBeNull(); // today's degrade path, unchanged
      const hard = planFor({
        roots: [root],
        cls: NO_EGRESS_CLASS,
        scratch: root,
        command: "/usr/bin/bun",
        args: ["runner.ts"],
        binary: null,
      });
      expect(hard.prefixArgv).toBeNull();
      expect(hard.refusal).toContain("Spawn refused");
      expect(hard.refusal).toContain("--unshare-net");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the no-egress plan adds --unshare-net; rw/net plans do not", () => {
    const root = tmpRoot("hard-argv");
    try {
      const common = {
        roots: [root],
        scratch: root,
        command: "/usr/bin/bun",
        args: ["runner.ts"],
        execPath: "/usr/bin/bun",
        repoRoot: "/repo",
        binary: "/x/bwrap",
      };
      const hard = planFor({ ...common, cls: NO_EGRESS_CLASS });
      expect(hard.probe).toBe("bwrap");
      expect(hard.refusal).toBeNull();
      expect(hard.prefixArgv!).toContain("--unshare-net");
      for (const cls of ["rw", "net"]) {
        expect(planFor({ ...common, cls }).prefixArgv!).not.toContain("--unshare-net");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Probe-backed: graceful when this host has no bwrap at all (the dev/CI
  // box). The contract is superset: the no-egress probe can only pass where
  // the base probe passes too.
  it("the no-egress probe implies the base probe", () => {
    if (findBwrap() === null) {
      expect(noEgressBinary()).toBeNull();
      return;
    }
    const noNet = noEgressBinary(true);
    if (noNet !== null) expect(bwrapAvailable(true)).toBe(true);
  });
});
