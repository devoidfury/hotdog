// launcher.ts — window opening for `hotdog desktop` (Linux first).
//
// Resolution chain, first rung that holds wins, no retries back up:
//   1. A WebKitGTK shim compiled on demand from shims/linux.c (GTK4 +
//      webkitgtk-6.0, else GTK3 + webkit2gtk-4.1; mutually exclusive
//      stacks, probed in order). The
//      binary is cached under the data dir keyed by a hash of (source bytes
//      + pkg-config flags + arch), so a rebuild happens only when what it
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
// chain's default on Linux.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
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

export function shimCachePath(key: string): string {
  return joinDataDir("desktop", `shim-${key}`);
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

export interface ShimPlan {
  sourcePath: string;
  outPath: string;
  cc: string;
  flags: string[];
  cached: boolean;
}

/** What this machine can do, computed from probe answers only. `null` shim
 *  means "no shim path here" (not Linux, no cc, no frameworks, unreadable
 *  source); `null` browser means no Chromium-family binary on PATH. */
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
  }
  let browser: string | null = null;
  for (const candidate of BROWSER_CANDIDATES) {
    if (probe.which(candidate)) {
      browser = candidate;
      break;
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

async function compileShim(plan: ShimPlan): Promise<string | null> {
  await mkdir(join(plan.outPath, ".."), { recursive: true });
  const tmp = `${plan.outPath}.tmp-${randomBytes(4).toString("hex")}`;
  logger.info(
    `[desktop] compiling the webview shim (first run; cc + ${SHIM_SERIES.map((s) => s.pkgConfig).join(" or ")} required)`,
  );
  try {
    const proc = Bun.spawn({
      cmd: compileShimArgs(plan.cc, plan.sourcePath, tmp, plan.flags),
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
    return plan.outPath;
  } catch (err) {
    logger.warn(`[desktop] shim compile could not run: ${formatError(err)}`);
    return null;
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
    ).join(" or ")}; app mode needs a Chromium-family browser)`,
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
