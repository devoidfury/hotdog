// exec-plan-seatbelt: the macOS jail profile is pure string generation, so
// every shape and every escaping rule below pins on THIS host. What cannot
// be pinned here (does mediation bite?) is exec-plan-seatbelt-live.test.ts
// territory -- that file only runs on a real mac.
//
// The golden profile is re-stated here line by line on purpose (the module's
// own constants are NOT imported): a change to the profile's shape, order,
// flags or mach list must fail this test, never silently ride along.

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFenceBackend, planFor } from "@utils/exec-plan.ts";
import {
  probeSeatbelt,
  seatbeltBinary,
  seatbeltPlan,
  seatbeltProfile,
} from "@utils/exec-plan-seatbelt.ts";

function fixture(label: string): string {
  return mkdtempSync(join(tmpdir(), `exec-plan-seatbelt-${label}-`));
}

/** Expected ro emission: module list re-stated, host-filtered exactly the
 *  way the generator filters (realpath or skip; exact dedup). */
function expectedRo(execDir: string, repo: string): string[] {
  const candidates = [
    "/usr", "/bin", "/sbin", "/usr/lib", "/usr/share", "/System",
    "/Library/Frameworks", "/private/etc", "/dev", execDir, repo,
  ];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const real = realpathSync(c); // throws when absent: skipped
      if (!out.includes(real)) out.push(real);
    } catch {
      // skipped like the generator skips it
    }
  }
  return out;
}

/**
 * Remove the BODY of every quoted string (honoring backslash escapes),
 * keeping quote characters and everything outside strings -- a mini model
 * of how seatbelt's lexer sees tokens. What survives is exactly the rule
 * structure a hostile path could have added; an escaped injection disappears
 * here because it never escaped its string.
 */
function strippedGrammar(profile: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < profile.length; i++) {
    const ch = profile[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') { inStr = false; out += ch; }
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

describe("seatbeltProfile (golden)", () => {
  it("emits the full profile, line by line, for fixed inputs", () => {
    const base = fixture("golden");
    try {
      const ws = join(base, "ws");
      mkdirSync(ws);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      const repo = join(base, "repo");
      mkdirSync(repo);
      const ro = expectedRo("/usr/bin", repo);
      // rw emission is sorted: deterministic for a fixed input set, the way
      // the fence id (a hash over the joined argv) needs it.
      const rw = [scratch, ws].map((p) => realpathSync(p)).sort();
      const expected = [
        "(version 1)",
        "(deny default)",
        "(allow process-exec* process-fork file-map-executable sysctl-read)",
        `(allow file-read-metadata (literal "/"))`,
        // owner ruling: NO blanket signal; the deny is stated explicitly.
        "(deny process-signal)",
        // nine mach names, incl. dnssd (.local hangs without it).
        '(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.dnssd.service") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.tccd") (global-name "com.apple.tccd.system"))',
        '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
        `(allow file-read-data file-read-metadata${ro.map((p) => ` (subpath "${p}")`).join("")})`,
        `(allow file-read* file-write*${rw.map((p) => ` (subpath "${p}")`).join("")})`,
        "(allow network-outbound network-inbound)",
      ].join("\n");
      expect(seatbeltProfile({ roots: [ws], scratch, execPath: "/usr/bin/bun", repoRoot: repo })).toBe(expected);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips non-existent roots and dedups realpath'd aliases", () => {
    const base = fixture("dedup");
    try {
      const ws = join(base, "ws");
      mkdirSync(ws);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      // A non-existent root never reaches the profile (like a bwrap bind
      // source that does not exist); a symlink alias and its target are ONE
      // entry (seatbelt matches resolved paths, so the alias must not leak).
      const link = join(base, "ws-alias");
      symlinkSync(ws, link);
      const profile = seatbeltProfile({
        roots: [ws, join(base, "gone"), link],
        scratch,
        execPath: "/nonexistent/bun",
        repoRoot: join(base, "gone-repo"),
      });
      expect(profile).toContain(`(subpath "${realpathSync(ws)}")`);
      expect(profile).not.toContain("gone");
      expect(profile).not.toContain("gone-repo");
      expect(profile).not.toContain("ws-alias");
      const rwLine = profile.split("\n").find((l) => l.includes("file-read*"))!;
      expect(rwLine.split(`(subpath "${realpathSync(ws)}")`).length).toBe(2); // exactly once
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("seatbeltProfile escaping (SECURITY BOUNDARY)", () => {
  it("a root named like a profile injection grants nothing", () => {
    const base = fixture("inject");
    try {
      const evil = join(base, 'x")(allow file-write* (subpath "/');
      mkdirSync(evil);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      const profile = seatbeltProfile({
        roots: [evil],
        scratch,
        execPath: "/nonexistent/bun",
        repoRoot: "/nonexistent/repo",
      });
      // The quotes/backslash are escaped INSIDE the string; stripping all
      // string bodies (the way a lexer sees them) must leave exactly the
      // 7 allow rules / 2 deny rules of the honest profile -- an escaped
      // injection is gone, an unescaped one would show an extra allow.
      const grammar = strippedGrammar(profile);
      expect(grammar.split("(allow").length - 1).toBe(7);
      expect(grammar.split("(deny").length - 1).toBe(2);
      // The injection's payload was a `(allow file-write* ...` rule. No
      // honest line starts that way (the rw line reads file-read* FIRST),
      // so any occurrence means the string closed -- escaped, it is zero.
      expect(grammar.split("(allow file-write*").length - 1).toBe(0);
      // And the escape is actually present in the raw profile.
      expect(profile).toContain('\\"');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("backslashes in root names either resolve escaped or skip, never break grammar", () => {
    const base = fixture("backslash");
    try {
      const bs = join(base, "a\\b");
      mkdirSync(bs);
      const trailing = join(base, "tail\\");
      mkdirSync(trailing);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      const profile = seatbeltProfile({
        roots: [bs, trailing],
        scratch,
        execPath: "/nonexistent/bun",
        repoRoot: "/nonexistent/repo",
      });
      // Bun's realpathSync rejects backslash-named components on some
      // hosts (mkdir/lstat/existsSync are fine): those roots then skip the
      // allowlist exactly like missing ones -- under-allowing (fail-safe),
      // never interpolating unescaped. Where realpath DOES resolve them,
      // they must appear with the backslash doubled.
      const grammar = strippedGrammar(profile);
      expect(grammar.split("(allow").length - 1).toBe(7);
      expect(grammar.split("(deny").length - 1).toBe(2);
      for (const p of [bs, trailing]) {
        let real: string | null;
        try {
          real = realpathSync(p);
        } catch {
          real = null;
        }
        if (real === null) {
          expect(profile).not.toContain(p);
        } else {
          expect(profile).toContain(`(subpath "${real.replace(/\\/g, "\\\\")}")`);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("paths containing newline or CR throw (unquotable to the parser)", () => {
    const base = fixture("ctrl");
    try {
      const nl = join(base, "nl\nname");
      mkdirSync(nl);
      const cr = join(base, "cr\rname");
      mkdirSync(cr);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      expect(() => seatbeltProfile({ roots: [nl], scratch, execPath: "/nonexistent/bun", repoRoot: "/nonexistent/repo" }))
        .toThrow(/[Cc]ontrol character/);
      expect(() => seatbeltProfile({ roots: [cr], scratch, execPath: "/nonexistent/bun", repoRoot: "/nonexistent/repo" }))
        .toThrow(/[Cc]ontrol character/);
      // NUL cannot exist in an fs path (realpath throws first: skipped), but
      // the guard covers it at the escaping boundary all the same.
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("seatbeltPlan argv (env sandwich)", () => {
  it("sandbox-exec -p <profile> /usr/bin/env HOME/TMPDIR=scratch command, no --", () => {
    const base = fixture("argv");
    try {
      const ws = join(base, "ws");
      mkdirSync(ws);
      const scratch = join(base, "scratch");
      mkdirSync(scratch);
      const r = seatbeltPlan({
        roots: [ws],
        cls: "rw",
        scratch,
        command: "/usr/bin/bun",
        args: ["runner.ts", "--flag"],
        execPath: "/usr/bin/bun",
        repoRoot: join(base, "repo"),
      });
      expect(r.probe).toBe("seatbelt");
      const argv = r.prefixArgv!;
      const realScratch = realpathSync(scratch);
      expect(argv[0]).toBe("/usr/bin/sandbox-exec");
      expect(argv[1]).toBe("-p");
      expect(argv[2]).toContain("(deny default)");
      // sandbox-exec has no --setenv: HOME/TMPDIR ride in argv via env,
      // pointing at the REAL host scratch (not a jail /tmp like bwrap's).
      expect(argv[3]).toBe("/usr/bin/env");
      expect(argv[4]).toBe(`HOME=${realScratch}`);
      expect(argv[5]).toBe(`TMPDIR=${realScratch}`);
      expect(argv[6]).toBe("/usr/bin/bun");
      expect(argv.slice(7)).toEqual(["runner.ts", "--flag"]);
      expect(argv.length).toBe(9);
      // No "--" separator anywhere: sandbox-exec takes the command directly.
      expect(argv).not.toContain("--");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "darwin")("on linux (never seatbelt, never spawns)", () => {
  it("probeSeatbelt short-circuits on the platform guard with zero spawn attempts", () => {
    const holder = Bun as unknown as { spawnSync: unknown };
    const real = holder.spawnSync;
    let calls = 0;
    holder.spawnSync = (...args: unknown[]) => {
      calls++;
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    try {
      expect(probeSeatbelt(true)).toBeNull();
      expect(seatbeltBinary()).toBeNull(); // /usr/bin/sandbox-exec is not a linux binary
      expect(calls).toBe(0);
    } finally {
      holder.spawnSync = real;
    }
  });

  it("execFenceBackend can never report seatbelt here", () => {
    expect(execFenceBackend()).not.toBe("seatbelt");
  });

  it("planFor keeps the exact bwrap-or-null shape it always had", () => {
    const scratch = fixture("linux-plan");
    try {
      const fenced = planFor({
        roots: [],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        repoRoot: "/nonexistent-repo",
        binary: "/x/bwrap",
      });
      expect(fenced.probe).toBe("bwrap");
      expect(fenced.prefixArgv![0]).toBe("/x/bwrap");
      const plain = planFor({
        roots: [],
        cls: "rw",
        scratch,
        command: "bun",
        args: [],
        binary: null,
      });
      expect(plain).toEqual({ prefixArgv: null, probe: null });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
