// Runtime half of the desktop launcher tests (the pure planning/lock/URL
// shapes live in desktop-launcher.test.ts). This file drives the code that
// touches the machine -- compileShim, the shim spawn rung, the browser
// refusal, the print fallback, ad-hoc codesign, and realProbe's fallback
// walk -- using fake toolchain executables written to disk (no mock.module;
// cc/browser are spawn seams by construction).
//
// Host doctrine: bun resolves spawn names and child environments from the
// PROCESS-STARTUP snapshot, so mutating process.env.PATH at test time does
// not steer Bun.spawn/Bun.which, and env flags do not cross to children.
// Every fake therefore carries its duty in its own body and its evidence
// paths inline; nothing here depends on what the host happens to have.

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_CANDIDATES,
  BROWSER_CANDIDATES_MACOS,
  compileShim,
  createLauncher,
  shimCacheKey,
  shimCachePath,
  type LauncherProbe,
  type ShimPlan,
  MACOS_ATS_PLIST,
  MACOS_SHIM_FLAGS,
} from "@experimental/desktop/launcher.ts";

const BIN_DIR = mkdtempSync(join(tmpdir(), "hotdog-desktop-bins-"));

/** Write an executable script and return its path. */
function fakeBin(name: string, body: string): string {
  const p = join(BIN_DIR, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// A fake compiler proof-of-argv, not a stubbed call: it reads the argv the
// real compileShim assembles. -o <out> gets an executable stub that logs
// its stdin line (the shim's URL protocol). With PlistCheck set, the
// -sectcreate plist path must exist AT COMPILE TIME and its bytes are
// copied to the evidence file inline (no env signaling to the child).
function fakeCompiler(opts: { fail?: boolean; plistEvidence?: string; stubLogPath?: string } = {}): string {
  const name = `fake-cc-${Math.random().toString(36).slice(2, 8)}.sh`;
  return fakeBin(
    name,
    `
out=""
prev=""
plist=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in -Wl,-sectcreate,*) plist="\${a##*,}";; esac
  prev="$a"
done
${opts.fail ? 'echo "fake compiler boom" >&2\nexit 1' : ""}
if [ -z "$out" ]; then echo "no -o target" >&2; exit 3; fi
${
  opts.plistEvidence
    ? `if [ -z "$plist" ]; then echo "no -sectcreate flag" >&2; exit 5; fi
if [ ! -f "$plist" ]; then echo "plist gone at compile time" >&2; exit 4; fi
cp "$plist" ${JSON.stringify(opts.plistEvidence)}`
    : ""
}
${
  opts.stubLogPath
    ? `printf '#!/bin/bash\\ncat > ${JSON.stringify(opts.stubLogPath)}\\nexit 0\\n' > "$out"
chmod +x "$out"`
    : `printf '#!/bin/bash\\nexit 0\\n' > "$out"
chmod +x "$out"`
}
exit 0
`,
  );
}

function probeOver(over: Partial<LauncherProbe>): LauncherProbe {
  return {
    platform: "linux",
    arch: "x64",
    which: () => null,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    exists: async () => false,
    readFile: async () => new TextEncoder().encode("SHIM-SOURCE"),
    ...over,
  };
}

async function scratch(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `hotdog-desktop-rt-${label}-`));
}

// planLauncher's linux cache path, recomputed exactly as the planner does
// for this fake machine (source bytes "SHIM-SOURCE", flags "-lgtk", x64).
const linuxCachePath = () =>
  shimCachePath(shimCacheKey(new TextEncoder().encode("SHIM-SOURCE"), "-lgtk", "x64"));

function stubAt(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("compileShim runtime (fake cc)", () => {
  it("success: creates the out binary, mkdir -p's a cold cache dir, removes the ATS plist after linking", async () => {
    const dir = await scratch("ok");
    const source = join(dir, "macos.m");
    await writeFile(source, "SOURCE");
    const evidence = join(dir, "plist-evidence");
    const cc = fakeCompiler({ plistEvidence: evidence });
    const outPath = join(dir, "nested", "cold", "shim-macos-x"); // parent missing: mkdir -p path
    const plan: ShimPlan = {
      sourcePath: source,
      outPath,
      cc,
      flags: [...MACOS_SHIM_FLAGS],
      cached: false,
      atsPlist: MACOS_ATS_PLIST,
      codesign: false, // codesign's own case below
    };
    const bin = await compileShim(plan);
    expect(bin).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    // The sectcreate flag pointed at a plist that really existed during the
    // compile (the fake cc refuses otherwise), and its bytes are the ATS doc.
    expect(await readFile(evidence, "utf8")).toBe(MACOS_ATS_PLIST);
    // The plist lived next to the build tmp and died with it (finally unlink).
    expect(readdirSync(join(dir, "nested", "cold")).filter((f) => f.endsWith(".info.plist"))).toEqual([]);
  });

  it("compiler exit nonzero -> null, no binary renamed into place", async () => {
    const dir = await scratch("ccfail");
    const source = join(dir, "linux.c");
    await writeFile(source, "SOURCE");
    const outPath = join(dir, "shim");
    const bin = await compileShim({
      sourcePath: source,
      outPath,
      cc: fakeCompiler({ fail: true }),
      flags: [],
      cached: false,
    });
    expect(bin).toBeNull();
    expect(existsSync(outPath)).toBe(false);
  });

  it("unspawnable cc -> null through the catch, not a throw", async () => {
    // The out dir lives in scratch: the failure under test is the cc spawn,
    // not / write access (a /nonexistent outPath littered the root on hosts
    // where it was writable and threw before the catch on hosts where it
    // was not).
    const dir = await scratch("nocc");
    const bin = await compileShim({
      sourcePath: join(dir, "whatever.c"),
      outPath: join(dir, "nested", "shim"),
      cc: join(BIN_DIR, "no-such-compiler"),
      flags: [],
      cached: false,
    });
    expect(bin).toBeNull();
  });

  if (process.platform !== "win32") {
    it("unwritable out dir -> null through the catch, not a throw", async () => {
      const dir = await scratch("roout");
      const roDir = join(dir, "ro");
      mkdirSync(roDir);
      chmodSync(roDir, 0o500);
      try {
        const bin = await compileShim({
          sourcePath: join(dir, "whatever.c"),
          outPath: join(roDir, "nested", "shim"),
          cc: join(BIN_DIR, "no-such-compiler"),
          flags: [],
          cached: false,
        });
        expect(bin).toBeNull();
      } finally {
        chmodSync(roDir, 0o700);
      }
    });
  }

  it("codesign=true on a host without codesign: the signing attempt fails soft, the binary still rides", async () => {
    // On Linux there is no codesign binary: adhocSign's spawn throws, and
    // that warning path must NOT veto the just-built binary (the same soft
    // posture as a nonzero signature; the macOS rung signs for real).
    const dir = await scratch("sign");
    const source = join(dir, "linux.c");
    await writeFile(source, "SOURCE");
    const outPath = join(dir, "shim-a");
    const bin = await compileShim({
      sourcePath: source,
      outPath,
      cc: fakeCompiler(),
      flags: [],
      cached: false,
      codesign: true,
    });
    expect(bin).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("createLauncher rungs (fake probe + fake binaries)", () => {
  const savedCc = process.env.CC;

  afterAll(() => {
    if (savedCc === undefined) delete process.env.CC;
    else process.env.CC = savedCc;
  });

  it("shim rung: plans linux, compiles with the fake cc, hands the URL on stdin's first line", async () => {
    const dir = await scratch("shimrung");
    const stdinLog = join(dir, "stdin.txt");
    const cc = fakeCompiler({ stubLogPath: stdinLog });
    process.env.CC = cc; // planLauncher reads CC from the live JS env (same process)
    const launcher = createLauncher({
      shimSourcePath: join(dir, "linux.c"),
      probe: probeOver({
        which: (n) => (n === cc ? n : null),
        exec: async () => ({ code: 0, stdout: "-lgtk", stderr: "" }),
      }),
    });
    const handle = await launcher.open("http://127.0.0.1:9/#tok=x");
    expect(handle.kind).toBe("shim");
    expect(await handle.exited).toBe(0);
    expect(await readFile(stdinLog, "utf8")).toBe("http://127.0.0.1:9/#tok=x\n");
  });

  it("shim rung, cached binary: no compile -- the cached file is spawned directly", async () => {
    const dir = await scratch("cached");
    const stdinLog = join(dir, "stdin.txt");
    stubAt(linuxCachePath(), `#!/bin/bash\ncat > ${JSON.stringify(stdinLog)}\nexit 0\n`);
    const cc = fakeCompiler(); // must NOT run here; its absence from the log is the proof
    process.env.CC = cc;
    const launcher = createLauncher({
      shimSourcePath: join(dir, "linux.c"),
      probe: probeOver({
        which: (n) => (n === cc ? n : null),
        exec: async () => ({ code: 0, stdout: "-lgtk", stderr: "" }),
        exists: async () => true, // the recomputed cache path exists: spawn it
      }),
    });
    const handle = await launcher.open("http://127.0.0.1:1/#tok=c");
    expect(handle.kind).toBe("shim");
    expect(await handle.exited).toBe(0);
    expect(await readFile(stdinLog, "utf8")).toContain("tok=c");
  });

  it("a planned shim whose binary cannot spawn falls through to print (warn, not throw)", async () => {
    const dir = await scratch("spawnfail");
    rmSync(linuxCachePath(), { force: true }); // the "cached" flag lies: the path holds nothing
    const cc = fakeCompiler();
    process.env.CC = cc;
    const launcher = createLauncher({
      shimSourcePath: join(dir, "linux.c"),
      probe: probeOver({
        which: (n) => (n === cc ? n : null),
        exec: async () => ({ code: 0, stdout: "-lgtk", stderr: "" }),
        exists: async () => true,
      }),
    });
    const handle = await launcher.open("http://127.0.0.1:2/");
    expect(handle.kind).toBe("print");
    handle.close(); // print close is a no-op
  });

  it("close() on a live shim SIGTERMs it and exited resolves (signal convention included)", async () => {
    const dir = await scratch("close");
    // The cached stub is our own sleeper (a live child that must be ended
    // by close()): consume the URL line, then hang.
    stubAt(linuxCachePath(), "#!/bin/bash\nread -r _\nsleep 30\n");
    const cc = fakeCompiler();
    process.env.CC = cc;
    const launcher = createLauncher({
      shimSourcePath: join(dir, "linux.c"),
      probe: probeOver({
        which: (n) => (n === cc ? n : null),
        exec: async () => ({ code: 0, stdout: "-lgtk", stderr: "" }),
        exists: async () => true,
      }),
    });
    const handle = await launcher.open("http://127.0.0.1:3/");
    expect(handle.kind).toBe("shim");
    // Give the stub a beat to consume stdin and enter sleep, then close.
    await new Promise((r) => setTimeout(r, 100));
    handle.close();
    // 143 = 128+SIGTERM as bun reports it; childHandle maps the null shape
    // of a signal death to 0. Either spelling means "close() ended it".
    expect([0, 143]).toContain(await handle.exited);
    handle.close(); // idempotent: the second kill lands on an already-gone child
  });

  // The fake answers exists() only -- the launcher SPAWNS the absolute
  // candidate path, so a host that ships Chrome at candidate[0] (GitHub
  // macOS runners do) really launches it and answers "browser": the
  // refusal under test cannot exist there, and the honest answer is the
  // skip. Linux/dev hosts (no /Applications) run it every push.
  const hostChromeAt0 =
    BROWSER_CANDIDATES_MACOS[0] !== undefined && existsSync(BROWSER_CANDIDATES_MACOS[0]);
  it.skipIf(hostChromeAt0)(
    "browser rung refused by the machine: a macOS candidate path that cannot spawn falls to print" +
      (hostChromeAt0 ? " [SKIPPED: this host has a browser at the candidate path]" : ""),
    async () => {
      process.env.CC = "";
      const launcher = createLauncher({
        probe: probeOver({
          platform: "darwin",
          exists: async (p) => p === BROWSER_CANDIDATES_MACOS[0],
        }),
      });
      const handle = await launcher.open("http://127.0.0.1:5/");
      expect(handle.kind).toBe("print");
    },
  );

  it("print rung: no shim, no browser -> the URL is the output, exited never settles", async () => {
    process.env.CC = "";
    const launcher = createLauncher({ probe: probeOver({}) });
    const handle = await launcher.open("http://127.0.0.1:6/");
    expect(handle.kind).toBe("print");
    const settled = await Promise.race([
      handle.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 30)),
    ]);
    expect(settled).toBe(false);
  });
});

describe("realProbe fallback (default createLauncher, no fake machine)", () => {
  // A host that HAS a Chromium-family browser would really launch one; skip
  // there. Darwin plans on the ABSOLUTE .app candidates (which() sees PATH
  // only), and GitHub macOS runners ship Chrome in /Applications -- the
  // which()-only guard let the 2026-11-24 CI run launch a real browser.
  const hostHasBrowser =
    process.platform === "darwin"
      ? BROWSER_CANDIDATES_MACOS.some((c) => existsSync(c))
      : BROWSER_CANDIDATES.some((c) => Bun.which(c));

  it.skipIf(hostHasBrowser)(
    "doomed CC, no frameworks, no browser on PATH -> plan nothing, fall to print without throwing",
    async () => {
      // Exercises realProbe's which/exec closures: an absolute doomed cc
      // passes which(), then pkg-config (present or not -- both answers are
      // handled) refuses the shim, and no browser candidate resolves.
      const savedCc = process.env.CC;
      process.env.CC = "/usr/bin/false";
      try {
        const launcher = createLauncher({ shimSourcePath: "/nonexistent/hotdog-shim.c" });
        const handle = await launcher.open("http://127.0.0.1:7/");
        expect(handle.kind).toBe("print");
      } finally {
        process.env.CC = savedCc;
      }
    },
  );
});
