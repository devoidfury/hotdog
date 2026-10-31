// LIVE seatbelt jail tests -- macOS only (`bun test
// tests/utils/exec-plan-seatbelt-live.test.ts` on a real mac; skipped, loudly,
// everywhere else). This is the macOS verifier's file: it proves the probe's
// two legs pass on the host, that writes outside the rw roots and reads of
// ~/.ssh are DENIED while scratch stays writable, and that the HOME/TMPDIR
// env sandwich actually lands.
//
// Anti-vacuity doctrine (same as exec-plan-confinement.test.ts): every
// negative pairs with a positive control of the SAME operation run
// unsandboxed, so a wrong path, a missing file or an inert shim shows up as
// a FAILED CONTROL -- never as a passing negative.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { probeSeatbelt, seatbeltBinary, seatbeltPlan } from "@utils/exec-plan-seatbelt.ts";

const IS_MAC = process.platform === "darwin";
if (!IS_MAC) {
  console.warn(
    "[seatbelt-live] NOT macOS -- SKIPPING every live seatbelt test. " +
      "The darwin fence is pinned by exec-plan-seatbelt.test.ts (generation) and by this file (mediation); " +
      "run this file on a machine with /usr/bin/sandbox-exec to pin the posture.",
  );
}

// Generous per-spawn timeout: bun reports exitCode null on expiry, and the
// assertions below treat null as a failure, so a hung sandbox-exec can never
// pass a negative test.
const TIMEOUT_MS = 15_000;

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function run(argv: string[]): Run {
  const r = Bun.spawnSync(argv, { timeout: TIMEOUT_MS });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

let base: string;
let ws: string;
let scratch: string;
let outside: string; // NOT in any rw root
let sshProbe: string; // a real ~/.ssh file, created for the negative below
let scratchReal: string;

/** The session's jail: one rw root + scratch, sh runs the script. */
function jail(script: string): Run {
  const { prefixArgv } = seatbeltPlan({
    roots: [ws],
    cls: "rw",
    scratch,
    command: "/bin/sh",
    args: ["-c", script],
    execPath: process.execPath,
    repoRoot: join(base, "repo"),
  });
  return run(prefixArgv!);
}

describe.skipIf(!IS_MAC)("seatbelt live jail (macOS)", () => {
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), "hotdog-seatbelt-live-"));
    fs.mkdirSync(join(base, "repo"));
    ws = join(base, "ws");
    fs.mkdirSync(ws);
    scratch = join(base, "scratch");
    fs.mkdirSync(scratch);
    outside = join(base, "outside");
    fs.mkdirSync(outside);
    sshProbe = join(os.homedir(), ".ssh", "hotdog-seatbelt-live-probe.txt");
    fs.mkdirSync(dirname(sshProbe), { recursive: true });
    fs.writeFileSync(sshProbe, "seatbelt-live-ssh-token");
    scratchReal = fs.realpathSync(scratch);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
    try {
      fs.rmSync(sshProbe); // only the probe file; never touch anyone's .ssh dir
    } catch {
      // best-effort; the filename is unique enough that leaving it is inert.
    }
  });
  it("probe: mediation is live and denies bite (two legs)", () => {
    const bin = seatbeltBinary();
    expect(bin).toBe("/usr/bin/sandbox-exec"); // the Apple shim is where Apple puts it
    // The cached two-leg probe: positive read with content AND negative
    // targeted deny. null here means the plane runs pooled-but-unfenced.
    expect(probeSeatbelt(true)).toBe(bin);
  });

  it("a write outside the rw roots is denied", () => {
    const target = join(outside, "written-by-jail");
    const inside = jail(`echo x > '${target}'`);
    expect(inside.code).not.toBeNull(); // timeout is not denial
    expect(inside.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    // Positive control: the identical command unsandboxed works.
    const control = run(["/bin/sh", "-c", `echo x > '${target}'`]);
    expect(control.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("a read of a ~/.ssh path is denied", () => {
    const inside = jail(`cat '${sshProbe}'`);
    expect(inside.code).not.toBeNull();
    expect(inside.code).not.toBe(0);
    expect(inside.out).not.toContain("seatbelt-live-ssh-token");
    // Positive control: same absolute-path read unsandboxed works.
    const control = run(["/bin/sh", "-c", `cat '${sshProbe}'`]);
    expect(control.code).toBe(0);
    expect(control.out).toContain("seatbelt-live-ssh-token");
  });

  it("scratch is writable from inside (HOME points at it)", () => {
    const inside = jail(`echo x > "$HOME/from-jail" && cat "$HOME/from-jail"`);
    expect(inside.err, inside.err).toBe("");
    expect(inside.code).toBe(0);
    expect(inside.out.trim()).toBe("x");
    expect(fs.existsSync(join(scratchReal, "from-jail"))).toBe(true);
  });

  it("HOME and TMPDIR arrive as the realpath'd scratch dir", () => {
    const inside = jail(`printf '%s|%s' "$HOME" "$TMPDIR"`);
    expect(inside.code).toBe(0);
    // If the env sandwich were missing, these would be the inherited host
    // values -- that is the failure this pins, no control needed for a
    // positive-equality assertion.
    expect(inside.out).toBe(`${scratchReal}|${scratchReal}`);
  });
});
