// launcher.ts — window opening for `hotdog desktop` (Linux and macOS).
//
// Resolution chain, first rung that holds wins, no retries back up:
//   1. A webview shim compiled on demand: on Linux from shims/linux.c
//      (GTK4 + webkitgtk-6.0, else GTK3 + webkit2gtk-4.1; mutually
//      exclusive stacks, probed in order), on macOS from shims/macos.m
//      (clang + Cocoa/WebKit; no pkg-config on macOS, and the binary gets
//      an ad-hoc codesign because Apple Silicon refuses to launch
//      WKWebProcess against an unsigned main binary). The
//      binary is cached under the data dir keyed by a hash of (source bytes
//      + flags + arch), so a rebuild happens only when what it
//      compiles against actually changed.
//   2. Any Chromium-family browser in app mode on a dedicated profile dir —
//      a real app window (no address bar, own taskbar entry) and the browser
//      process's lifetime is the window's, which is what the parent's
//      drain-on-exit wiring needs.
//   3. Print the URL; the process stays up until SIGINT/SIGTERM.
//
// A shim that spawned fine but EXITED nonzero is reported, never chained —
// relaunching a browser because the first window hit a runtime problem would
// open a second window on the same session. Only probe/compile/spawn
// failures fall through.
//
// The token handoff (local mode) rides the URL: the shim gets it on stdin
// (argv is world-readable through /proc), and the window scrubs the #tok=
// fragment from history on boot. The browser fallback necessarily passes the
// URL in argv — visible to same-uid processes, and to that profile's own
// storage. That is the documented cost of the fallback rung; the shim is the
// chain's default on Linux and macOS.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { arch as osArch } from "node:os";

import { formatError } from "@core/error.ts";
import { joinDataDir } from "@core/session/session-log.ts";
import { logger } from "@utils/logger.ts";

export type LauncherKind = "shim" | "browser" | "print";

export interface WindowHandle {
  kind: LauncherKind;
  /** Resolves with the child's exit code when the window goes away. The
   *  "print" handle never resolves — that window lives until a signal. */
  exited: Promise<number>;
  /** Best-effort terminate (SIGTERM the child when there is one). */
  close(): void;
}

export interface WindowLauncher {
  open(url: string): Promise<WindowHandle>;
}

/** Everything environment-dependent, so tests can fake the machine. */
export interface LauncherProbe {
  platform: string;
  arch: string;
  which(name: string): string | null;
  exec(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * WebKitGTK module candidates, best series first. These are MUTUALLY
 * EXCLUSIVE stacks, never a mix: webkitgtk-6.0 requires GTK4 (umbrella
 * <webkit/webkit.h>), webkit2gtk-4.1 requires GTK3 (<webkit2/webkit2.h>).
 * Asking pkg-config for `gtk4 webkit2gtk-4.1` "succeeds" wherever both
 * happen to be installed and hands the compiler a poisoned include path --
 * that is the trap this ordering replaces. Each candidate is asked ALONE;
 * its own Requires drags the correct GTK in transitively, and the shim's
 * GTK_CHECK_VERSION branch follows whatever landed on the include path.
 */
export const SHIM_SERIES = [
  { pkgConfig: "webkitgtk-6.0", label: "GTK4/webkitgtk-6.0" },
  { pkgConfig: "webkit2gtk-4.1", label: "GTK3/webkit2gtk-4.1" },
] as const;
export const BROWSER_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "brave-browser",
];

// darwin: Bun.which never resolves inside .app bundles, so the fallback
// browsers are probed by absolute executable path (exists() seam). Safari
// has no app mode, so it is not a candidate.
export const BROWSER_CANDIDATES_MACOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

// darwin shim: no pkg-config on macOS, so the flags are fixed. The
// sectcreate flag embeds the ATS plist at link time (its path argument is
// filled in by the compile step, which writes the plist next to the build
// tmp); the cache key hashes the flag list WITHOUT the volatile path, so a
// rebuild rides only on real source/flags/arch changes.
export const MACOS_SHIM_SOURCE = "macos.m";
export const MACOS_SHIM_FLAGS = [
  "-fobjc-arc",
  // 11.3, not 11.0: the entire WKDownload class is macos(11.3) (header-
  // verified WK_CLASS_AVAILABLE), and the download policy enums too. A
  // lower min turns those delegate signatures into availability errors.
  "-mmacosx-version-min=11.3",
  "-framework",
  "Cocoa",
  "-framework",
  "WebKit",
  // SecTrust*/SecCertificate symbols (the TOFU fingerprint path) live here;
  // ld64 will not pull them transitively through WebKit's .tbd.
  "-framework",
  "Security",
];

/** Minimal ATS plist: http on loopback only (NSAllowsLocalNetworking) —
 *  local mode's http://127.0.0.1:<port> and ssh -L tunnels. Every other
 *  load keeps Apple's full ATS posture; there is no NSAllowsArbitraryLoads
 *  here and there must never be one. */
export const MACOS_ATS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSAppTransportSecurity</key>
\t<dict>
\t\t<key>NSAllowsLocalNetworking</key>
\t\t<true/>
\t</dict>
</dict>
</plist>
`;

// ── Pure pieces ─────────────────────────────────────────────────────────────

export function shimCacheKey(source: Uint8Array, pkgConfigFlags: string, archName: string): string {
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(pkgConfigFlags)
    .update("\0")
    .update(archName)
    .digest("hex")
    .slice(0, 20);
}

export function shimCachePath(key: string, name = "shim"): string {
  return joinDataDir("desktop", `${name}-${key}`);
}

export function browserProfileDir(): string {
  return joinDataDir("desktop", "browser-profile");
}

export function browserLaunchArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export function compileShimArgs(
  cc: string,
  sourcePath: string,
  outPath: string,
  flags: string[],
): string[] {
  return [cc, "-O2", "-o", outPath, sourcePath, ...flags];
}

/** Split `pkg-config --cflags --libs` output into argv tokens. Quoted-flag
 *  ceiling: gtk/webkit flags are quote-free in practice; a quoted path would
 *  land as two tokens and fail the compile into the browser fallback. */
export function splitPkgConfigFlags(stdout: string): string[] {
  return stdout.split(/\s+/).filter(Boolean);
}

/** ATS exception embedding: ld64's -sectcreate splices the plist file into
 *  __TEXT,__info_plist, which is how a bundleless binary gets an ATS
 *  posture. Exposed (path-parameterized) so compileShim and the gated
 *  compile smoke build the identical invocation. Ceiling: a comma in the
 *  plist path would split the -Wl, argument -- the path lives under the
 *  hotdog data dir, which we control. */
export function macosSectcreateFlag(plistPath: string): string {
  return `-Wl,-sectcreate,__TEXT,__info_plist,${plistPath}`;
}

export interface ShimPlan {
  sourcePath: string;
  outPath: string;
  cc: string;
  flags: string[];
  cached: boolean;
  /** darwin only: plist content the compile step writes next to the build
   *  tmp and passes via -Wl,-sectcreate (ATS local-networking exception). */
  atsPlist?: string;
  /** darwin only: set when `codesign` answered to probe.which. The compile
   *  step ad-hoc-signs (--force --sign -) after a successful build; absence
   *  or failure is a warning, not a fall-through. */
  codesign?: boolean;
}

/** The darwin shim plan: fixed flags (no pkg-config), cache name
 *  `shim-macos-<hash>`, ATS plist carried for the compile step. `clang`
 *  probed via which (Command Line Tools put it on PATH; a machine without
 *  it falls to the browser/print rungs like any missing toolchain). */
export async function planMacosShim(
  probe: LauncherProbe,
  shimSourcePath: string,
): Promise<ShimPlan | null> {
  const cc = "clang";
  if (!probe.which(cc)) return null;
  const source = await probe.readFile(shimSourcePath).catch(() => null);
  if (!source) return null; // vendored source missing: no compile possible
  const outPath = shimCachePath(shimCacheKey(source, MACOS_SHIM_FLAGS.join(" "), probe.arch), "shim-macos");
  return {
    sourcePath: shimSourcePath,
    outPath,
    cc,
    flags: [...MACOS_SHIM_FLAGS],
    cached: await probe.exists(outPath),
    atsPlist: MACOS_ATS_PLIST,
    codesign: probe.which("codesign") !== null,
  };
}

/** What this machine can do, computed from probe answers only. `null` shim
 *  means "no shim path here" (unsupported platform, no compiler, missing
 *  frameworks, unreadable source); `null` browser means no Chromium-family
 *  binary was found. */
export interface LauncherPlan {
  shim: ShimPlan | null;
  browser: string | null;
}

export function launcherOrder(plan: LauncherPlan): LauncherKind[] {
  const order: LauncherKind[] = [];
  if (plan.shim) order.push("shim");
  if (plan.browser) order.push("browser");
  order.push("print");
  return order;
}

export async function planLauncher(
  probe: LauncherProbe,
  shimSourcePath: string,
): Promise<LauncherPlan> {
  let shim: ShimPlan | null = null;
  if (probe.platform === "linux") {
    const cc = process.env.CC || "cc";
    if (probe.which(cc)) {
      for (const series of SHIM_SERIES) {
        const pkg = await probe
          .exec(["pkg-config", "--cflags", "--libs", series.pkgConfig])
          .catch(() => null);
        if (!pkg || pkg.code !== 0) continue;
        const source = await probe.readFile(shimSourcePath).catch(() => null);
        if (!source) break; // vendored source missing: no series can help
        const flags = splitPkgConfigFlags(pkg.stdout);
        const outPath = shimCachePath(shimCacheKey(source, flags.join(" "), probe.arch));
        shim = {
          sourcePath: shimSourcePath,
          outPath,
          cc,
          flags,
          cached: await probe.exists(outPath),
        };
        break; // first series that answers wins; a COMPILE failure falls
        // through the rungs at launch time, it does not retry the next
        // series (two series can coexist where only one toolchain agrees)
      }
    }
  } else if (probe.platform === "darwin") {
    // The macOS shim lives next to the Linux one; the chain's single
    // shimSourcePath argument derives it (dirname + macos.m) so the
    // launcher's shape never changed for the second platform.
    shim = await planMacosShim(probe, join(dirname(shimSourcePath), MACOS_SHIM_SOURCE));
  }
  let browser: string | null = null;
  if (probe.platform === "darwin") {
    // Absolute bundle paths: Bun.which sees PATH only, and browsers on
    // macOS live in .app bundles. exists() is the seam that answers for a
    // real file.
    for (const candidate of BROWSER_CANDIDATES_MACOS) {
      if (await probe.exists(candidate)) {
        browser = candidate;
        break;
      }
    }
  } else {
    for (const candidate of BROWSER_CANDIDATES) {
      if (probe.which(candidate)) {
        browser = candidate;
        break;
      }
    }
  }
  return { shim, browser };
}

// ── The real launcher ───────────────────────────────────────────────────────

const realProbe: LauncherProbe = {
  platform: process.platform,
  arch: osArch(),
  which: (name) => Bun.which(name),
  exec: async (cmd) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = [
      await new Response(proc.stdout).text(),
      await new Response(proc.stderr).text(),
      await proc.exited,
    ];
    return { code, stdout, stderr };
  },
  exists: async (path) => (await stat(path).catch(() => null)) !== null,
  readFile: (path) => readFile(path),
};

function childHandle(kind: LauncherKind, child: ReturnType<typeof Bun.spawn>): WindowHandle {
  return {
    kind,
    exited: child.exited.then((code) => (typeof code === "number" ? code : 0)),
    close: () => {
      try {
        child.kill(15);
      } catch {
        // already gone
      }
    },
  };
}

async function spawnShim(plan: ShimPlan, url: string): Promise<WindowHandle | null> {
  let bin = plan.cached ? plan.outPath : null;
  if (!bin) {
    bin = await compileShim(plan);
    if (!bin) return null;
  }
  const child = Bun.spawn({
    cmd: [bin],
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  // URL on stdin, first line: argv is world-readable through /proc, and in
  // local mode the URL carries the session token. The shim reads one line.
  child.stdin.write(`${url}\n`);
  child.stdin.end();
  return childHandle("shim", child);
}

/** Compiled on demand by the launcher chain; exported for the gated
 *  compile smoke test (tests/extensions/desktop-shim-macos-smoke.test.ts). */
export async function compileShim(plan: ShimPlan): Promise<string | null> {
  await mkdir(join(plan.outPath, ".."), { recursive: true });
  const tmp = `${plan.outPath}.tmp-${randomBytes(4).toString("hex")}`;
  logger.info(`[desktop] compiling the webview shim (first run; ${plan.cc}, one-off)`);
  let plistPath: string | null = null;
  try {
    const flags = [...plan.flags];
    if (plan.atsPlist !== undefined) {
      // -Wl,-sectcreate embeds the plist as the binary's __info_plist
      // section: a bare CLI binary has no .app bundle to carry an ATS
      // exception, and without it WKWebView refuses http on loopback
      // (local mode and ssh -L tunnels would never load). The plist rides
      // next to the build tmp and dies with it.
      plistPath = `${tmp}.info.plist`;
      await writeFile(plistPath, plan.atsPlist);
      flags.push(macosSectcreateFlag(plistPath));
    }
    const proc = Bun.spawn({
      cmd: compileShimArgs(plan.cc, plan.sourcePath, tmp, flags),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      logger.warn(
        `[desktop] shim compile failed (${plan.cc} exit ${code}); falling back. ` +
          `compiler said: ${stderr.trim().slice(0, 400) || "(no output)"}`,
      );
      return null;
    }
    await rename(tmp, plan.outPath);
    if (plan.codesign) await adhocSign(plan.outPath);
    return plan.outPath;
  } catch (err) {
    logger.warn(`[desktop] shim compile could not run: ${formatError(err)}`);
    return null;
  } finally {
    if (plistPath) await unlink(plistPath).catch(() => {});
  }
}

/** Ad-hoc codesign (Apple Silicon: WKWebProcess refuses to launch against
 *  an unsigned main binary). Non-fatal by design: Intel Macs run unsigned
 *  fine, a missing/failing codesign downgrades to "shim may not spawn",
 *  and the spawn failure still falls through the chain — the warning says
 *  what to do. */
async function adhocSign(binPath: string): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: ["codesign", "--force", "--sign", "-", binPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) {
      logger.warn(
        `[desktop] ad-hoc codesign of the shim failed (exit nonzero): ${stderr.trim().slice(0, 200) || "(no output)"} ` +
          `-- on Apple Silicon the webview process may refuse to start.`,
      );
    }
  } catch (err) {
    logger.warn(`[desktop] ad-hoc codesign could not run: ${formatError(err)}`);
  }
}

async function spawnBrowser(binary: string, url: string): Promise<WindowHandle | null> {
  try {
    const child = Bun.spawn({
      cmd: [binary, ...browserLaunchArgs(url, browserProfileDir())],
      stdout: "inherit",
      stderr: "inherit",
    });
    return childHandle("browser", child);
  } catch (err) {
    logger.warn(`[desktop] ${binary} could not start: ${formatError(err)}`);
    return null;
  }
}

function printHandle(url: string): WindowHandle {
  // console.log, NOT logger: on a warn-level log config the logger swallows
  // info lines, and this URL is the only output the fallback path has -- a
  // silent wait would be indistinguishable from a hang (field-confirmed).
  // Program output, not diagnostics: stderr for the warning, stdout for the
  // thing the user has to act on.
  console.warn(
    `[desktop] no window launcher available (the shim needs cc + ${SHIM_SERIES.map(
      (s) => s.pkgConfig,
    ).join(" or ")} on Linux or clang + CLT on macOS; app mode needs a Chromium-family browser)`,
  );
  console.log(`Open this URL directly:\n  ${url}`);
  return { kind: "print", exited: new Promise<number>(() => {}), close: () => {} };
}

export function createLauncher(
  opts: { probe?: LauncherProbe; shimSourcePath?: string } = {},
): WindowLauncher {
  const probe = opts.probe ?? realProbe;
  const shimSourcePath = opts.shimSourcePath ?? join(import.meta.dir, "shims/linux.c");
  return {
    async open(url: string): Promise<WindowHandle> {
      const plan = await planLauncher(probe, shimSourcePath);
      if (plan.shim) {
        const handle = await spawnShim(plan.shim, url).catch((err) => {
          logger.warn(`[desktop] shim could not start: ${formatError(err)}`);
          return null;
        });
        if (handle) return handle;
      }
      if (plan.browser) {
        const handle = await spawnBrowser(plan.browser, url);
        if (handle) return handle;
      }
      return printHandle(url);
    },
  };
}
