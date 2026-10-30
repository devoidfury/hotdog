// H-5: negative confinement tests through REAL `planFor()` plans, spawned
// directly (the broker's shape: `bwrap <plan> -- sh -c ...`, the prefix argv
// prepended verbatim). Where tool-exec-hardening.test.ts proves the seam
// wrapping plumbing and exec-plan.test.ts pins argv SHAPE, this file runs code
// INSIDE a real jail and asserts the security properties themselves: host
// $HOME, /etc/hosts, sibling workspace roots and host pids are unreachable,
// while granted rw roots stay writable.
//
// Gate: the repo's OWN probe (`bwrapAvailable(true)` forces `probeBwrap`
// against the real host -- same detection `planFor()` uses, and the forced
// call re-seeds the shared cache, so probe and plan can never disagree).
// Hosts without bwrap or pidns support skip the whole file loudly; they run
// the exec plane unfenced by the degrade contract, so nothing is pinned.
//
// Anti-vacuity doctrine: every negative pairs with a positive control through
// the SAME runner (plain un-fenced spawn, or a real plan that grants the
// write). Each probe prints one verdict token -- W_OK / DENIED / MISSING for
// writes, K_OK/K_FAIL + SUP_VISIBLE/SUP_ESRCH for signals -- so a broken
// probe binary, an unowned target or a dead kill shows up as a FAILED
// control, never as a passing negative. Mutating the plan (drop tmpfs root,
// drop --unshare-pid, misorder the binds) flips an inside assertion.
//
// Tree location: roots live under $HOME, NOT the OS tmp dir. The plan binds
// scratch over /tmp, so a host-/tmp workspace root would be shadowed inside
// the jail and the negatives would pass for the wrong reason. Home also keeps
// the per-test fake $HOME outside every rw root, which is what case (a) needs.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { bwrapAvailable, planFor } from "@utils/exec-plan.ts";
import { formatError } from "@core/error.ts";
import { processAlive, waitForExit } from "../helpers.ts";

// force=true: tests/evals/evals-lib.test.ts re-probes under a stub/missing
// PATH and leaves the module cache poisoned (null) after restoring PATH, and
// bun test's sequential load runs it before this file on a size-sorted pass.
// A forced re-probe reads the REAL host state and re-seeds the cache planFor()
// reads, so gate and plan still agree (the invariant the stale cache breaks).
const HAS_FENCE = bwrapAvailable(true);
if (!HAS_FENCE) {
  // tests/setup.ts no-ops the console; the loud channel is the reporter's
  // (skip) lines, which carry the describe name below. This warn still lands
  // in any context that runs the module without the suppression preload.
  console.warn(
    "[exec-plan-confinement] bwrap fence probe FAILED on this host -- SKIPPING every confinement test. " +
      "The exec plane degrades to plain spawns here (see exec-plan.ts probe contract); " +
      "run this file on a host with working bwrap + pid namespaces to pin the posture.",
  );
}

// Every spawn (fenced or not) carries this timeout; bun kills on expiry and
// reports exitCode null, which the runner turns into a loud error. bwrap
// spawns here in well under 500ms.
const SPAWN_TIMEOUT_MS = 4000;

let base: string; // the whole test tree, under $HOME, deleted in afterAll
let wsA: string; // rw root of "plan A" (the confinement plans)
let wsB: string; // rw root of ANOTHER plan only -- invisible to plan A
let fakeHome: string; // per-test $HOME, outside every rw root
let roRepo: string; // stands in for the repoRoot ro-bind (holds `hosts`)
let scratchSeq = 0;
const strays = new Set<number>(); // pids we must not leave behind

beforeAll(() => {
  base = fs.mkdtempSync(join(os.homedir(), ".hotdog-fence-"));
  wsA = join(base, "ws-a");
  wsB = join(base, "ws-b");
  fakeHome = join(base, "home");
  roRepo = join(base, "repo");
  for (const d of [wsA, wsB, fakeHome, roRepo]) fs.mkdirSync(d);
  // A user-owned copy of /etc/hosts: our control target (the real /etc/hosts
  // is root-owned; see the /etc/hosts case below).
  fs.writeFileSync(join(roRepo, "hosts"), fs.readFileSync("/etc/hosts"));
});

afterAll(() => {
  for (const pid of strays) {
    if (processAlive(pid)) {
      try {
        process.kill(pid, 9);
      } catch (e) {
        console.warn(`[exec-plan-confinement] stray ${pid} kill failed: ${formatError(e)}`);
      }
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

interface ProbeResult {
  rc: number;
  out: string;
  err: string;
}

function runSpawn(cmd: string[], what: string, env?: Record<string, string | undefined>): ProbeResult {
  try {
    const p = Bun.spawnSync({
      cmd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
      ...(env ? { env } : {}),
    });
    if (p.exitCode === null) throw new Error("timed out (killed)");
    return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  } catch (e) {
    throw new Error(`[exec-plan-confinement] ${what}: spawn failed: ${formatError(e)}`);
  }
}

/** The direct-spawn shape: `planFor()` prefix argv, spawned verbatim. */
function runFenced(roots: string[], script: string, what: string): ProbeResult & { scratch: string } {
  const scratch = join(base, `scratch-${++scratchSeq}`);
  fs.mkdirSync(scratch);
  const { prefixArgv, probe } = planFor({
    roots,
    cls: "rw",
    scratch,
    command: "/bin/sh",
    args: ["-c", `echo FENCE_HOME=$HOME; ${script}`, "_"],
    repoRoot: roRepo,
  });
  if (!prefixArgv || probe !== "bwrap") {
    throw new Error(`[exec-plan-confinement] ${what}: probe passed but planFor() planned no fence`);
  }
  return { ...runSpawn(prefixArgv, what), scratch };
}

/** Control runner: the same /bin/sh -c mechanism, no fence at all. */
function runPlain(script: string, what: string, env?: Record<string, string | undefined>): ProbeResult {
  return runSpawn(["/bin/sh", "-c", script, "_"], what, env);
}

// ── Probe scripts ───────────────────────────────────────────────────────────
// Every probe ends in a verdict token on stdout; the plan decides which token
// comes out. `echo FENCE_HOME=$HOME` rides along in fenced runs: the plan
// sets HOME=/tmp via --setenv, so it doubles as proof the jail really ran
// through planFor() (an unfenced run shows the host HOME instead).

const appendProbe = (target: string) =>
  `if echo appended >> "${target}" 2>/dev/null; then echo W_OK; ` +
  `elif [ ! -e "${target}" ]; then echo MISSING; else echo DENIED; fi`;

const killProbe = (victim: number, spawner: number) =>
  `if kill -9 ${victim} 2>/dev/null; then echo K_OK; else echo K_FAIL; fi; ` +
  `if kill -0 ${spawner} 2>/dev/null; then echo SUP_VISIBLE; else echo SUP_ESRCH; fi`;

const PIDS_SCRIPT = 'ls /proc | grep -E "^[0-9]+$" | tr "\\n" " "';

const DENIED_OR_MISSING = ["DENIED", "MISSING"];

/** The write probe's verdict token: its last stdout line. */
const verdict = (out: string): string => out.trim().split("\n").pop() ?? "";

describe.skipIf(!HAS_FENCE)(
  "planFor() confinement, real bwrap plans + direct spawn [REQUIRES bwrap + pidns -- skipped here where the fence probe fails]",
  () => {
  it("(d) control first: the granted rw root and the scratch /tmp stay writable", () => {
    // The jail-still-works control for every negative below: if bwrap mounted
    // a jail whose binds were silently broken, this fails, not the negatives.
    const r = runFenced([wsA], appendProbe(join(wsA, "granted.txt")), "rw root write");
    expect(r.out).toContain("W_OK");
    expect(r.out).toContain("FENCE_HOME=/tmp"); // --setenv applied: real plan ran
    expect(fs.readFileSync(join(wsA, "granted.txt"), "utf-8")).toContain("appended");

    const t = runFenced([wsA], appendProbe("/tmp/jail-tmp.txt"), "scratch /tmp write");
    expect(t.out).toContain("W_OK");
    // The scratch bind is the SAME dir host-side: writes land on the host.
    expect(fs.readFileSync(join(t.scratch, "jail-tmp.txt"), "utf-8")).toContain("appended");
  });

  it("(a) append/create under the host $HOME fails; unconfined it works", () => {
    const target = join(fakeHome, "notes.log");
    const inside = runFenced([wsA], appendProbe(target), "home append confined");
    expect(DENIED_OR_MISSING).toContain(verdict(inside.out));
    expect(fs.existsSync(target)).toBe(false);

    // Control: the exact same probe, same shell, no fence, with the same HOME.
    const outside = runPlain(appendProbe(target), "home append control", {
      ...process.env,
      HOME: fakeHome,
    });
    expect(outside.out).toContain("W_OK");
    expect(fs.readFileSync(target, "utf-8")).toContain("appended");
  });

  it("(b) append to /etc/hosts fails inside the plan", () => {
    const inside = runFenced([wsA], appendProbe("/etc/hosts"), "etc-hosts confined");
    expect(DENIED_OR_MISSING).toContain(verdict(inside.out));

    // Control honesty: this host runs tests as a NON-ROOT uid, so the
    // unconfined control must not write the real /etc/hosts (it would fail
    // with plain EACCES -- a broken control, and destructive on a root host).
    // The append probe itself is proven on a user-owned copy of the file...
    const copy = join(base, "hosts-copy");
    fs.writeFileSync(copy, "127.0.0.1 localhost\n");
    const outside = runPlain(appendProbe(copy), "etc-hosts control");
    expect(outside.out).toContain("W_OK");
    // ...and the fence's ro enforcement gets an airtight non-vacuous pair
    // below: a USER-OWNED file inside the plan's ro binds is read-only
    // in-jail (EROFS) and writable when the same dir is granted rw.
  });

  it("(b2) files under the plan's ro binds are read-only in-jail, rw when the same dir is a granted root", () => {
    const target = join(roRepo, "hosts"); // user-owned, mode 644 on the host
    expect(fs.existsSync(target)).toBe(true);

    const inside = runFenced([wsA], appendProbe(target), "ro-repo confined");
    expect(DENIED_OR_MISSING).toContain(verdict(inside.out));
    expect(fs.readFileSync(target, "utf-8")).not.toContain("appended");

    // Control plan: same builder, same file -- now an rw root. rw-after-ro
    // mount order must let the bind win; if it flips, the pair catches it.
    const granted = runFenced([roRepo], appendProbe(target), "rw-repo control plan");
    expect(granted.out).toContain("W_OK");
    expect(fs.readFileSync(target, "utf-8")).toContain("appended");
  });

  it("(c) a sibling dir that is ANOTHER plan's rw root is not writable here", () => {
    // The cross-root isolation the mount-order reasoning in exec-plan.ts:70-121
    // exists for. planFor() passes hidden: [] (no .git hiding on the plane),
    // so its ACTUAL defense is the fresh tmpfs root plus exact-directory rw
    // binds: nothing on the host exists inside the jail unless this plan
    // binds it. (The re-assert tmpfs loop covers ancestor-bind resurrection of
    // HIDDEN paths -- the evals shape -- and is inert for plane plans; the
    // rw-after-ro order it shares with the re-assert is pinned by (b2).)
    const target = join(wsB, "keep.txt");
    fs.writeFileSync(target, "orig\n");

    const inside = runFenced([wsA], appendProbe(target), "sibling-root confined");
    expect(DENIED_OR_MISSING).toContain(verdict(inside.out));
    // Host-side untouched: the negative did not slip past the bind list.
    expect(fs.readFileSync(target, "utf-8")).toBe("orig\n");

    // Control: the sibling's OWN real plan (it is a granted root there).
    const elsewhere = runFenced([wsB], appendProbe(target), "sibling-root control plan");
    expect(elsewhere.out).toContain("W_OK");
    expect(fs.readFileSync(target, "utf-8")).toContain("appended");
  });

  it("(e) kill -9 of the host-side victim pid is ESRCH inside; works unconfined", async () => {
    // The sacrificial sleep stands in for the supervisor: what must be pinned
    // is that a jailed process cannot signal ANY host pid, then that the same
    // kill from the same runner does land when unfenced (so the K_FAIL above
    // is the fence, not a broken kill).
    const victim = Bun.spawn(["/bin/sleep", "60"]);
    strays.add(victim.pid);
    try {
      const inside = runFenced([wsA], killProbe(victim.pid, process.pid), "kill confined");
      expect(inside.out).toContain("K_FAIL");
      expect(inside.out).toContain("SUP_ESRCH"); // the spawner itself is unkillable too
      // Inside, the victim's pid is not even visible to the signal path; the
      // proof the kill did not land is host-side:
      expect(processAlive(victim.pid)).toBe(true); // the "supervisor" survived

      const outside = runPlain(killProbe(victim.pid, process.pid), "kill control");
      expect(outside.out).toContain("K_OK"); // same kill, unfenced: lands
      expect(outside.out).toContain("SUP_VISIBLE");
      await waitForExit(victim.pid, 3000);
      expect(processAlive(victim.pid)).toBe(false);
    } finally {
      if (processAlive(victim.pid)) {
        try {
          victim.kill(9);
        } catch (e) {
          console.warn(`[exec-plan-confinement] victim kill failed: ${formatError(e)}`);
        }
      }
    }
  }, 15000);

  it("(f) /proc inside shows only the jail's pids; the spawner is visible unconfined", () => {
    const parse = (s: string) => s.split(/\s+/).filter((t) => /^\d+$/.test(t)).map(Number);
    const inside = runFenced([wsA], PIDS_SCRIPT, "proc confined");
    const pids = parse(inside.out);
    expect(pids).toContain(1); // a real pidns init, not an empty or masked /proc
    expect(pids).not.toContain(process.pid); // the spawner is invisible
    expect(Math.max(...pids)).toBeLessThanOrEqual(10); // only jail processes exist
    expect(pids.length).toBeLessThanOrEqual(6);

    // Control: the same listing unfenced contains this very test process.
    const outside = runPlain(PIDS_SCRIPT, "proc control");
    const hostPids = parse(outside.out);
    expect(hostPids).toContain(process.pid);
    expect(hostPids.length).toBeGreaterThan(pids.length);
  });
});
