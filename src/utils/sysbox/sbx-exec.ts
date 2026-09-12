// sbx-exec: the sysbox sandbox helper. Spawned per command by
// sysbox/index.ts (NEVER imported by the main hotdog process -- it is the
// only place bun:ffi cc() runs, and cc failures take down exactly one
// sandbox spawn, not the session).
//
// Contract: fd 3 carries a JSON config to EOF:
//   { exe: string, argv: string[], env: Record<string,string>,
//     cwd: string|null, deny: number[],
//     fence?: { rw: string[], ro: string[] } | null,
//     cgroup?: string | null }
// With cgroup set (host delegates a writable cgroup v2 subtree): the FIRST
// act after parsing is writing our own pid into <cgroup>/cgroup.procs --
// before chdir, before cc(), so nothing this process or its exec'd command
// ever does runs outside the pids.max/memory.max cage the parent built
// (fork/zip-bomb containment, docs/sysbox-sandbox.md "cgroups"). Join
// failure is a setup failure (126): a spawn announced as limited must not
// silently run unlimited.
// Installs the seccomp deny filter on itself (NO_NEW_PRIVS +
// SECCOMP_SET_MODE_FILTER|TSYNC) and execve's { exe, argv } with { env }.
// With fence set: Landlock ruleset first (rw paths get the full fs-rights
// mask, ro paths EXECUTE|READ, and every net right the ABI knows -- TCP bind/
// connect from v4, UDP bind/send from v10 -- handled with no allow rules)
// -- landlock syscalls are not in the seccomp deny set, so the order
// fence-then-seccomp keeps nothing new attackable.
// There is no fork anywhere: installing on self-then-exec sidesteps
// fork-from-multithreaded-JSC entirely (see docs/sysbox-sandbox.md).
//
// argv[2] === "--probe-fence": print the Landlock ABI (side-effect-free
//   query + ruleset create) on stdout and exit 0, or exit 3.
//
// Exit codes (observable by the bash tool through the normal close event;
// both are sandbox setup failures -- the command DID NOT run):
//   126  config/validate/chdir/cc/seccomp-install failure
//   127  execve failure
// Setup diagnostics go to stderr, which is the tool's stderr pipe.

import { cc } from "bun:ffi";
import { readSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packTlv } from "./tlv.ts";
import { MAX_DENY_SYSCALLS } from "./denied-syscalls.ts";

const EXIT_SETUP = 126;
const EXIT_EXEC = 127;

interface SbxConfig {
  exe: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string | null;
  deny: number[];
  fence: FenceConfig | null;
  cgroup: string | null;
}

interface FenceConfig {
  rw: string[];
  ro: string[];
}

function die(code: number, msg: string): never {
  process.stderr.write(`sbx-exec: ${msg}\n`);
  process.exit(code);
}

function readConfigFd3(): SbxConfig {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const b = new Uint8Array(65536);
    let n: number;
    try {
      n = readSync(3, b, 0, b.length, null);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(1);
        continue;
      }
      die(EXIT_SETUP, `fd 3 read failed: ${e}`);
    }
    if (n === 0) break;
    chunks.push(b.slice(0, n));
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(new TextDecoder().decode(concat(chunks)));
  } catch (e) {
    die(EXIT_SETUP, `config parse failed: ${e}`);
  }
  return validateConfig(cfg);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function validateConfig(cfg: unknown): SbxConfig {
  const c = cfg as SbxConfig;
  if (!c || typeof c !== "object") die(EXIT_SETUP, "config is not an object");
  if (typeof c.exe !== "string" || !c.exe.startsWith("/")) die(EXIT_SETUP, "config.exe must be an absolute path");
  if (!Array.isArray(c.argv) || c.argv.length < 1 || c.argv.length > 15) die(EXIT_SETUP, "config.argv must be 1..15 items");
  if (c.argv.some((a) => typeof a !== "string")) die(EXIT_SETUP, "config.argv must be strings");
  if (!c.env || typeof c.env !== "object" || Array.isArray(c.env)) die(EXIT_SETUP, "config.env must be an object");
  const envKeys = Object.keys(c.env);
  if (envKeys.length > 256) die(EXIT_SETUP, "config.env exceeds 256 entries");
  if (envKeys.some((k) => typeof c.env[k] !== "string")) die(EXIT_SETUP, "config.env values must be strings");
  if (c.cwd !== null && typeof c.cwd !== "string") die(EXIT_SETUP, "config.cwd must be string or null");
  if (!Array.isArray(c.deny) || c.deny.length > MAX_DENY_SYSCALLS) die(EXIT_SETUP, `config.deny must be an array of at most ${MAX_DENY_SYSCALLS} numbers`);
  if (c.deny.some((n) => !Number.isInteger(n) || n < 0 || n > 1024)) die(EXIT_SETUP, "config.deny entries must be syscall numbers 0..1024");
  if (c.fence === undefined) c.fence = null;
  if (c.fence !== null) validateFence(c.fence);
  if (c.cgroup === undefined) c.cgroup = null;
  if (c.cgroup !== null && (typeof c.cgroup !== "string" || !c.cgroup.startsWith("/") || c.cgroup.includes("\0"))) {
    die(EXIT_SETUP, "config.cgroup must be an absolute path or null");
  }
  return c;
}

const MAX_FENCE_PATHS = 64;

function validateFence(f: FenceConfig): void {
  if (!f || typeof f !== "object" || Array.isArray(f)) die(EXIT_SETUP, "config.fence must be an object or null");
  for (const key of ["rw", "ro"] as const) {
    const list = f[key];
    if (!Array.isArray(list) || list.length > MAX_FENCE_PATHS) {
      die(EXIT_SETUP, `config.fence.${key} must be an array of at most ${MAX_FENCE_PATHS} paths`);
    }
    if (key === "rw" && list.length < 1) die(EXIT_SETUP, "config.fence.rw must have at least one path");
    if (list.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes("\0"))) {
      die(EXIT_SETUP, `config.fence.${key} entries must be absolute paths without NUL`);
    }
  }
}

function main(): never {
  if (process.argv[2] === "--probe-fence") probeFence();
  const cfg = readConfigFd3();

  // Join the DoS cgroup FIRST (before chdir, before cc): every byte of
  // memory and every task this process or its exec'd command ever produces
  // is inside the parent-built limits from here on.
  if (cfg.cgroup !== null) {
    try {
      writeFileSync(join(cfg.cgroup, "cgroup.procs"), String(process.pid));
    } catch (e) {
      die(EXIT_SETUP, `cgroup join ("${cfg.cgroup}") failed: ${e}; refusing to run unlimited`);
    }
  }

  if (cfg.cwd !== null) {
    try {
      process.chdir(cfg.cwd);
    } catch (e) {
      die(EXIT_SETUP, `chdir("${cfg.cwd}") failed: ${e}`);
    }
  }

  const launcherC = join(dirname(fileURLToPath(import.meta.url)), "launcher.c");
  let sbx: LauncherSymbols;
  try {
    sbx = compileLauncher(launcherC);
  } catch (e) {
    die(EXIT_SETUP, `cc() compile/link failed (${e}); refusing to run unsandboxed`);
  }

  const deny = new Int32Array(cfg.deny);
  // Order (docs/sysbox-sandbox.md): landlock fence first, seccomp last, so no
  // window exists where the command could drop or dodge either layer.
  if (cfg.fence !== null) installFence(sbx, cfg.fence);
  const installRc = sbx.sbx_install(deny, cfg.deny.length);
  if (installRc !== 0) {
    die(EXIT_SETUP, `seccomp install failed (-${-installRc}); refusing to run unsandboxed`);
  }

  const argvPack = packTlv([cfg.exe, ...cfg.argv]);
  const envPack = packTlv(Object.keys(cfg.env).map((k) => `${k}=${cfg.env[k]}`));
  const execRc = sbx.sbx_exec(argvPack, argvPack.byteLength, envPack, envPack.byteLength);
  die(EXIT_EXEC, `execve("${cfg.exe}") failed: -${-execRc}`);
}

interface LauncherSymbols {
  sbx_install: (deny: Int32Array, n: number) => number;
  sbx_exec: (argv: Uint8Array, argvLen: number, env: Uint8Array, envLen: number) => number;
  sbx_fence_install: (rw: Uint8Array, rwLen: number, ro: Uint8Array, roLen: number) => number;
}

function installFence(sbx: LauncherSymbols, fence: FenceConfig): void {
  const rwPack = packTlv(fence.rw);
  const roPack = packTlv(fence.ro);
  const rc = sbx.sbx_fence_install(rwPack, rwPack.byteLength, roPack, roPack.byteLength);
  if (rc !== 0) {
    die(EXIT_SETUP, `landlock fence install failed (-${-rc}); refusing to run unsandboxed`);
  }
}

function compileLauncher(launcherC: string): LauncherSymbols {
  const { symbols } = cc({
    source: launcherC,
    symbols: {
      sbx_install: { args: ["ptr", "i32"], returns: "i32" },
      sbx_exec: { args: ["ptr", "i64", "ptr", "i64"], returns: "i32" },
      sbx_fence_install: { args: ["ptr", "i64", "ptr", "i64"], returns: "i32" },
    },
  });
  return symbols as unknown as LauncherSymbols;
}

// Fence capability probe: sbx_fence_probe is side-effect-free (ABI query +
// a ruleset create/close that never restricts this process), so a normal
// exit is safe here. On success prints the ABI version on stdout and exits
// 0; exit 3 = unavailable (nonzero return detail on stderr).
function probeFence(): never {
  const launcherC = join(dirname(fileURLToPath(import.meta.url)), "launcher.c");
  let probe: () => number;
  try {
    const { symbols } = cc({
      source: launcherC,
      symbols: { sbx_fence_probe: { args: [], returns: "i32" } },
    });
    probe = symbols.sbx_fence_probe as unknown as () => number;
  } catch (e) {
    process.stderr.write(`probe: cc failed: ${e}\n`);
    process.exit(3);
  }
  const rc = probe();
  if (rc > 0) {
    process.stdout.write(String(rc));
    process.exit(0);
  }
  process.stderr.write(`probe: landlock returned -${-rc}\n`);
  process.exit(3);
}

main();
