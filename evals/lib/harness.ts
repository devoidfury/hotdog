import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessRunResult, HarnessSpec } from "./types.ts";

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN_PLACEHOLDERS = new Set(["prompt", "model", "repo", "schema_file"]);

export function loadHarnessSpec(path: string): HarnessSpec {
  return parseHarnessSpec(path, readFileSync(path, "utf8"));
}

export function parseHarnessSpec(path: string, text: string): HarnessSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["id", "command", "args", "env", "prompt_via"].includes(key)) {
      throw new Error(`${path}: unknown key "${key}"`);
    }
  }
  const id = obj.id;
  const command = obj.command;
  const args = obj.args;
  if (typeof id !== "string" || !id) throw new Error(`${path}: "id" must be a non-empty string`);
  if (typeof command !== "string" || !command) throw new Error(`${path}: "command" must be a non-empty string`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new Error(`${path}: "args" must be an array of strings`);
  }
  const promptVia = obj.prompt_via;
  if (promptVia !== undefined && promptVia !== "arg" && promptVia !== "stdin") {
    throw new Error(`${path}: "prompt_via" must be "arg" or "stdin"`);
  }
  const env = obj.env;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new Error(`${path}: "env" must be an object`);
    }
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== "string") throw new Error(`${path}: env["${k}"] must be a string`);
    }
  }
  return { id, command, args: args as string[], ...(env !== undefined ? { env: env as Record<string, string> } : {}), ...(promptVia !== undefined ? { prompt_via: promptVia } : {}) };
}

/** Expand the argv template. Throws on unknown placeholders or a missing required value. */
export function expandArgv(spec: HarnessSpec, vars: Record<string, string>): string[] {
  const via = spec.prompt_via ?? "arg";
  const hasPrompt = spec.args.some((a) => a.includes("{prompt}"));
  if (via === "arg" && !hasPrompt) {
    throw new Error(`harness "${spec.id}": prompt_via "arg" requires a {prompt} placeholder in args`);
  }
  if (via === "stdin" && hasPrompt) {
    throw new Error(`harness "${spec.id}": prompt_via "stdin" must not contain {prompt}`);
  }
  const needsModel = spec.args.some((a) => a.includes("{model}"));
  if (needsModel && !(vars.model ?? "").trim()) {
    throw new Error(`harness "${spec.id}": args use {model} but the model is empty`);
  }
  return spec.args.map((arg) =>
    arg.replace(PLACEHOLDER, (whole, name: string) => {
      if (!KNOWN_PLACEHOLDERS.has(name)) {
        throw new Error(`harness "${spec.id}": unknown placeholder "${whole}"`);
      }
      const value = vars[name];
      if (value === undefined) {
        throw new Error(`harness "${spec.id}": no value provided for "{${name}}"`);
      }
      return value;
    }),
  );
}

export async function runHarness(opts: {
  spec: HarnessSpec;
  argv: string[];
  cwd: string;
  prompt: string;
  timeoutSecs: number;
  /** Merged last, over spec.env (per-run overrides like HOTDOG_SESSIONS_DIR). */
  env?: Record<string, string>;
}): Promise<HarnessRunResult> {
  const started = Date.now();
  const via = opts.spec.prompt_via ?? "arg";
  const proc = Bun.spawn([opts.spec.command, ...opts.argv], {
    cwd: opts.cwd,
    // NO_COLOR/TERM forced last: captured output must be plain and
    // deterministic no matter what the runner's env or a spec says.
    env: { ...process.env, ...(opts.spec.env ?? {}), ...(opts.env ?? {}), NO_COLOR: "1", TERM: "dumb" },
    stdin: via === "stdin" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group so a timeout kill reaches grandchildren, which
    // otherwise hold the stdout/stderr pipes open and stall the reads.
    detached: process.platform !== "win32",
  });
  if (via === "stdin") {
    proc.stdin?.write(opts.prompt);
    proc.stdin?.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      // Shell builtin kill (direct /bin/kill argv did not deliver group kills here).
      Bun.spawnSync(["/bin/bash", "-c", `kill -9 -${proc.pid}`]);
    } catch {
      // pgid kill unavailable; fall back to the direct child
    }
    try {
      proc.kill(9);
    } catch {
      // already exited
    }
  }, opts.timeoutSecs * 1000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = null;
  } finally {
    clearTimeout(timer);
  }
  return {
    exitCode: timedOut ? null : exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - started,
  };
}

/** Run a scoring shell command in the run workspace (bash -lc). */
export async function runShell(
  cmd: string,
  cwd: string,
  timeoutSecs: number,
): Promise<HarnessRunResult> {
  return runHarness({
    spec: { id: "shell", command: "bash", args: ["-lc", cmd] },
    argv: ["-lc", cmd],
    cwd,
    prompt: "",
    timeoutSecs,
  });
}

/** Guard check paths: relative, no escape out of the workspace. */
export function safeWorkspacePath(cwd: string, rel: string): string {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) {
    throw new Error(`unsafe path "${rel}": must be relative to the workspace`);
  }
  const abs = resolve(join(cwd, rel));
  if (abs !== cwd && !abs.startsWith(cwd + "/")) {
    throw new Error(`unsafe path "${rel}": escapes the workspace`);
  }
  return abs;
}
