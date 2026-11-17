// desktop (experimental): the macOS shim's compile smoke, gated the house
// way (cf. agent-browser-smoke.test.ts) on BOTH darwin and a working clang
// -- in this Linux dev sandbox it always skips, and the skip reason rides
// in the describe title. What it pins once a Mac runs it:
//   1. shims/macos.m compiles with the exact launcher flags (the delegate
//      signatures match the installed SDK headers -- the lesson linux.c
//      learned from a SIGABRT), and compileShim embeds the ATS plist
//      (otool must see __info_plist) plus ad-hoc codesigns the binary
//      (codesign --verify must pass; arm64 WKWebProcess demands it).
//   2. The pre-GUI stdin contract: no URL / empty URL / non-http URL each
//      exit 1 with a reason, before any NSApplication exists -- so a hung
//      window is never what a bad handoff looks like.
// Window behavior itself (focus policy, TOFU prompt, downloads) stays
// manual: there is no window server to talk to in CI.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileShim,
  MACOS_ATS_PLIST,
  MACOS_SHIM_FLAGS,
  type ShimPlan,
} from "@experimental/desktop/launcher.ts";

const SHIM_SOURCE = join(import.meta.dir, "../../src/experimental/desktop/shims/macos.m");

const clangWorks = (() => {
  try {
    return Bun.spawnSync({ cmd: ["clang", "--version"] }).exitCode === 0;
  } catch {
    return false;
  }
})();
const HAVE_TOOLCHAIN = process.platform === "darwin" && clangWorks;
const SKIP_NOTE = HAVE_TOOLCHAIN
  ? ""
  : ` -- SKIPPED: needs macOS with clang (host is ${process.platform}, clang ${clangWorks ? "found" : "missing"}); real-window behavior stays manual`;

const suite = HAVE_TOOLCHAIN ? describe : describe.skip;
// Only touch the filesystem when we will actually compile.
const workDir = HAVE_TOOLCHAIN ? mkdtempSync(join(tmpdir(), "hotdog-macos-shim-smoke-")) : "";

suite(`macos shim compile smoke (flags + ATS sectcreate + ad-hoc codesign + stdin contract)${SKIP_NOTE}`, () => {
  afterAll(() => {
    if (HAVE_TOOLCHAIN) rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "compileShim builds shims/macos.m, embeds __info_plist, and verifies the ad-hoc signature",
    async () => {
      const plan: ShimPlan = {
        sourcePath: SHIM_SOURCE,
        outPath: join(workDir, "shim-macos-smoke"),
        cc: "clang",
        flags: [...MACOS_SHIM_FLAGS],
        cached: false,
        atsPlist: MACOS_ATS_PLIST,
        codesign: true,
      };
      const bin = await compileShim(plan);
      expect(bin).not.toBeNull();
      expect((await stat(bin!)).size).toBeGreaterThan(0);

      // The ATS exception really landed in __TEXT,__info_plist (the local-
      // mode http posture rides on this; a silently dropped sectcreate
      // would mean "https works, localhost never does").
      const otool = Bun.spawnSync({ cmd: ["otool", "-l", bin!] });
      expect(otool.exitCode).toBe(0);
      expect(new TextDecoder().decode(otool.stdout)).toContain("__info_plist");

      // Ad-hoc signature verifies (arm64: an unsigned main binary means
      // WKWebProcess refuses to launch -- the signing step is load-
      // bearing, and a broken one must fail HERE not in someone's window).
      const cs = Bun.spawnSync({ cmd: ["codesign", "--verify", bin!] });
      expect(cs.exitCode).toBe(0);
    },
    120_000,
  );

  it(
    "stdin contract before any GUI: no URL, empty URL, and non-http URL each exit 1",
    async () => {
      // Reuse the compiled binary from test 1 (order is sequential in bun).
      const bin = join(workDir, "shim-macos-smoke");
      if ((await stat(bin).catch(() => null)) === null) return; // compile failed; test 1 already said so

      for (const stdin of ["", "\n", "not a url\n", "ftp://example.com\n"]) {
        const proc = Bun.spawn({
          cmd: [bin],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (stdin) proc.stdin.write(stdin);
        proc.stdin.end();
        const code = await Promise.race([
          proc.exited,
          new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
        ]);
        expect(code, `stdin=${JSON.stringify(stdin)}`).toBe(1);
      }
    },
    30_000,
  );
});
