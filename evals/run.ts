// hotdog eval runner. Usage:
//   bun evals/run.ts --series series/kielbasa-1 --harness <id> --model <id> [--task <id>]
//                    [--judge-harness <id> --judge-model <id>]
//                    [--repeat n] [--concurrency n] [--dry-run] [--keep-workspace]
// Real model calls happen only when NOT --dry-run.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandArgv, loadHarnessSpec, runHarness } from "./lib/harness.ts";
import { startServe } from "./lib/serve.ts";
import { bwrapArgv, bwrapBinary, baseRoBinds, hiddenRepoPaths, type BwrapPlan } from "./lib/bwrap.ts";
import { formatJudgePrompt, parseVerdict, runCheck, tail, VERDICT_SCHEMA } from "./lib/score.ts";
import { buildMatrix, loadSeries } from "./lib/series.ts";
import { fmtErr, formatDryRun, formatSummary, resultsDirName } from "./lib/format.ts";
import type { CheckResult, HarnessSpec, MatrixCell, RunRecord } from "./lib/types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HARNESS_DIR = join(REPO_ROOT, "evals", "harnesses");
const JUDGE_TIMEOUT_SECS = 300;
const STDOUT_TAIL = 2000;

interface Options {
  series: string;
  tasks: string[];
  harnesses: string[];
  models: string[];
  judgeHarness?: string;
  judgeModel?: string;
  repeat?: number;
  concurrency?: number;
  dryRun: boolean;
  keepWorkspace: boolean;
}

// Flag numbers get the same >= 1 validation as series.json: a NaN/0 repeat or
// concurrency silently plans zero runs, and a zero-run matrix would otherwise
// report green (every() on an empty array is true).
function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} requires an integer >= 1 (got "${raw}")`);
  return n;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { series: "", tasks: [], harnesses: [], models: [], dryRun: false, keepWorkspace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--series": opts.series = next(); break;
      case "--task": opts.tasks.push(next()); break;
      case "--harness": opts.harnesses.push(next()); break;
      case "--model": opts.models.push(next()); break;
      case "--judge-harness": opts.judgeHarness = next(); break;
      case "--judge-model": opts.judgeModel = next(); break;
      case "--repeat": opts.repeat = positiveInt(next(), arg); break;
      case "--concurrency": opts.concurrency = positiveInt(next(), arg); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--keep-workspace": opts.keepWorkspace = true; break;
      default: throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (!opts.series) throw new Error("--series <dir> is required");
  if (!opts.harnesses.length) throw new Error("at least one --harness <id> is required");
  if (!opts.models.length) throw new Error("at least one --model <id> is required");
  if ((opts.judgeHarness === undefined) !== (opts.judgeModel === undefined)) {
    throw new Error("--judge-harness and --judge-model must be given together");
  }
  return opts;
}

function loadHarness(id: string): HarnessSpec {
  return loadHarnessSpec(join(HARNESS_DIR, `${id}.json`));
}

interface RunOpts {
  seriesName: string;
  timeoutSecs: number;
  judge: { harness: HarnessSpec; model: string } | null;
  schemaFile: string;
  tasksDir: string;
  keepWorkspaceFlag: boolean;
  sandbox: SandboxBase | null;
  sessionsRoot: string;
}

interface SandboxBase {
  binary: string;
  roBinds: string[];
  hidden: string[];
}

function cellPlan(base: SandboxBase, opts: RunOpts, workspace: string, sessionDir: string): BwrapPlan {
  return {
    roBinds: base.roBinds,
    hidden: base.hidden,
    // Re-bind the pieces the run needs that live under the hidden results dir.
    roBindsAfterHidden: [opts.schemaFile],
    rwBinds: [workspace, sessionDir],
  };
}

/** bwrap-wrap an expanded spec+argv per the plan. */
function applySandbox(base: SandboxBase, spec: HarnessSpec, argv: string[], plan: BwrapPlan): { spec: HarnessSpec; argv: string[] } {
  const wrapped = bwrapArgv({ binary: base.binary, command: spec.command, args: argv, plan });
  return { spec: { ...spec, command: wrapped[0]!, args: wrapped.slice(1) }, argv: wrapped.slice(1) };
}

async function executeCell(cell: MatrixCell, opts: RunOpts): Promise<RunRecord> {
  const startedAt = new Date();
  const workspace = mkdtempSync(join(tmpdir(), "hotdog-eval-"));
  const harness = loadHarness(cell.harnessId);
  const record = (partial: Partial<RunRecord>): RunRecord => ({
    run_id: cell.runId,
    series: opts.seriesName,
    task: cell.task.id,
    harness: cell.harnessId,
    model: cell.model,
    repeat: cell.repeatIdx,
    started_at: startedAt.toISOString(),
    duration_ms: 0,
    exit_code: null,
    timed_out: false,
    stdout_tail: "",
    stderr_tail: "",
    checks: [],
    pass: false,
    sandboxed: opts.sandbox !== null,
    ...partial,
  });
  try {
    if (cell.task.fixtures) {
      cpSync(join(opts.tasksDir, cell.task.fixtures), workspace, { recursive: true });
    }
    const argv = expandArgv(harness, {
      prompt: cell.task.prompt,
      model: cell.model,
      repo: REPO_ROOT,
      schema_file: opts.schemaFile,
    });
    const sessionDir = join(opts.sessionsRoot, cell.runId);
    mkdirSync(sessionDir, { recursive: true }); // bwrap bind sources must exist host-side
    const spawn = opts.sandbox
      ? applySandbox(opts.sandbox, harness, argv, cellPlan(opts.sandbox, opts, workspace, sessionDir))
      : { spec: harness, argv };
    // Per-task env (e.g. HOTDOG_FETCH_ALLOW_PRIVATE_HOSTS) merged over the
    // harness spec's env but under the forced per-run values.
    const spec = cell.task.env ? { ...spawn.spec, env: { ...(spawn.spec.env ?? {}), ...cell.task.env } } : spawn.spec;
    // serve runs on the host (grading apparatus, not the agent); the sandbox
    // shares the network namespace, so the agent can still reach it.
    let serveHandle: { stop(): void } | null = null;
    if (cell.task.serve) {
      try {
        serveHandle = await startServe(cell.task.serve, workspace, sessionDir);
      } catch (e) {
        return record({ checks: [{ name: "serve", pass: false, detail: fmtErr(e) }] });
      }
    }
    let run: Awaited<ReturnType<typeof runHarness>>;
    try {
      run = await runHarness({
        spec,
        argv: spawn.argv,
        cwd: workspace,
        prompt: cell.task.prompt,
        timeoutSecs: cell.task.timeout_secs ?? opts.timeoutSecs,
        env: { HOTDOG_SESSIONS_DIR: sessionDir },
      });
    } finally {
      serveHandle?.stop();
    }
    const checks: CheckResult[] = [];
    for (const [i, check] of cell.task.checks.entries()) {
      checks.push(await runCheck(check, i, {
        cwd: workspace,
        outcome: { exitCode: run.exitCode, stdout: run.stdout, timedOut: run.timedOut },
      }));
    }
    if (cell.task.judge) {
      checks.push(await runJudge(cell, workspace, run.stdout, opts));
    }
    const pass = !run.timedOut && checks.length > 0 && checks.every((c) => c.pass);
    return record({
      duration_ms: run.durationMs,
      exit_code: run.exitCode,
      timed_out: run.timedOut,
      stdout_tail: tail(run.stdout, STDOUT_TAIL),
      stderr_tail: tail(run.stderr, STDOUT_TAIL),
      checks,
      pass,
    });
  } catch (e) {
    return record({ stderr_tail: fmtErr(e), checks: [{ name: "runner", pass: false, detail: fmtErr(e) }] });
  } finally {
    if (!opts.keepWorkspaceFlag) rmSync(workspace, { recursive: true, force: true });
  }
}

async function runJudge(
  cell: MatrixCell,
  workspace: string,
  stdout: string,
  opts: RunOpts,
): Promise<CheckResult> {
  const name = "judge";
  if (!opts.judge) {
    return { name, pass: false, detail: "task has a judge but no judge harness was configured" };
  }
  try {
    const argv = expandArgv(opts.judge.harness, {
      prompt: formatJudgePrompt(cell.task, cell.task.judge!.rubric, stdout),
      model: opts.judge.model,
      repo: REPO_ROOT,
      schema_file: opts.schemaFile,
    });
    const sessionDir = join(opts.sessionsRoot, `${cell.runId}-judge`);
    mkdirSync(sessionDir, { recursive: true });
    const spawn = opts.sandbox
      ? applySandbox(opts.sandbox, opts.judge.harness, argv, cellPlan(opts.sandbox, opts, workspace, sessionDir))
      : { spec: opts.judge.harness, argv };
    const res = await runHarness({
      spec: spawn.spec,
      argv: spawn.argv,
      cwd: workspace,
      prompt: "",
      timeoutSecs: JUDGE_TIMEOUT_SECS,
      env: { HOTDOG_SESSIONS_DIR: sessionDir },
    });
    // Always persist the judge's raw output next to its session log, so verdicts
    // (and stdout contamination) are inspectable after the fact.
    writeFileSync(join(sessionDir, "judge-stdout.txt"), Buffer.from(res.stdout, "utf-8"));
    writeFileSync(join(sessionDir, "judge-stderr.txt"), Buffer.from(res.stderr, "utf-8"));
    if (res.timedOut) return { name, pass: false, detail: "judge timed out (see judge-stdout.txt / judge-stderr.txt in the judge session dir)" };
    let verdict: { pass: boolean; reason: string };
    try {
      verdict = parseVerdict(res.stdout);
    } catch (e) {
      // Parse errors on invisible characters are unreadable in terminal output;
      // point at the raw dump instead of quoting bytes.
      throw new Error(`${fmtErr(e)} [exit=${String(res.exitCode)} stdout=${res.stdout.length} bytes; raw judge output: ${join(sessionDir, "judge-stdout.txt")}]`);
    }
    return { name, pass: verdict.pass, detail: verdict.reason };
  } catch (e) {
    return { name, pass: false, detail: fmtErr(e) };
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function resolveSeriesDir(seriesArg: string): string {
  const candidates = [
    resolve(process.cwd(), seriesArg),
    resolve(REPO_ROOT, "evals", seriesArg),
    resolve(REPO_ROOT, "evals", "series", seriesArg),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "series.json"))) return dir;
  }
  throw new Error(`no series.json found for "${seriesArg}" (tried: ${candidates.join(", ")})`);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const loaded = loadSeries(resolveSeriesDir(opts.series));
  const cells = buildMatrix(loaded, {
    harnesses: opts.harnesses,
    models: opts.models,
    tasks: opts.tasks,
    repeat: opts.repeat,
  });
  if (cells.length === 0) throw new Error("no runs planned (check --repeat and the task/harness/model filters)");

  const usesJudge = cells.some((c) => c.task.judge);
  if (usesJudge && !opts.judgeHarness) {
    throw new Error('selected tasks use a judge: --judge-harness <id> --judge-model <id> are required');
  }
  // Loaded up front (also for --dry-run) so a bad judge spec fails before any real calls.
  const judge = opts.judgeHarness
    ? { harness: loadHarness(opts.judgeHarness), model: opts.judgeModel! }
    : null;
  if (judge) {
    // A judge harness must pass {schema_file} (i.e. run the subject with structured
    // output); otherwise stdout is freeform CLI text and every judge check dies on
    // a JSON parse error. Catches e.g. --judge-harness hotdog (subject spec) typo.
    const threadsSchema = judge.harness.args.some((a) => a.includes("{schema_file}"));
    if (!threadsSchema) {
      throw new Error(
        `judge harness "${judge.harness.id}" does not pass {schema_file} in its args, ` +
          "so it cannot produce a structured verdict (use a judge spec like hotdog-judge)",
      );
    }
  }

  if (opts.dryRun) {
    console.log(formatDryRun(cells));
    for (const cell of cells) {
      const harness = loadHarness(cell.harnessId);
      const argv = expandArgv(harness, { prompt: "<prompt>", model: cell.model, repo: REPO_ROOT, schema_file: "<schema>" });
      console.log(`  ${cell.runId}: ${harness.command} ${argv.map((a) => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);
      if (cell.task.serve) console.log(`    serve: ${cell.task.serve.cmd} (ready ${cell.task.serve.ready_url})`);
    }
    return 0;
  }

  const now = new Date();
  const resultsDir = join(REPO_ROOT, "evals", "results", resultsDirName(loaded.series.name, now));
  mkdirSync(resultsDir, { recursive: true });
  const runsFile = join(resultsDir, "runs.jsonl");
  const schemaFile = join(resultsDir, "verdict.schema.json");
  writeFileSync(schemaFile, JSON.stringify(VERDICT_SCHEMA));

  console.log(`series "${loaded.series.name}": ${cells.length} runs -> ${resultsDir}`);
  const binary = bwrapBinary();
  const sandbox: SandboxBase | null = binary
    ? {
        binary,
        roBinds: baseRoBinds({ execPath: process.execPath, repoRoot: REPO_ROOT, home: process.env.HOME }),
        hidden: hiddenRepoPaths(REPO_ROOT),
      }
    : null;
  console.log(`sandbox: ${sandbox ? "bwrap (allowlist ro; only workspace + session dirs rw)" : "OFF (bwrap missing or sandbox probe failed)"}`);
  const records: RunRecord[] = [];
  await pool(cells, opts.concurrency ?? loaded.series.concurrency, async (cell) => {
    const record = await executeCell(cell, {
      seriesName: loaded.series.name,
      timeoutSecs: loaded.series.timeout_secs,
      judge,
      schemaFile,
      tasksDir: loaded.tasksDir,
      keepWorkspaceFlag: opts.keepWorkspace,
      sandbox,
      sessionsRoot: join(resultsDir, "sessions"),
    });
    records.push(record);
    appendFileSync(runsFile, JSON.stringify(record) + "\n");
    const status = record.pass ? "PASS" : "FAIL";
    const why = record.pass ? "" : ` -> ${record.checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}`;
    console.log(`[${status}] ${record.run_id} (${(record.duration_ms / 1000).toFixed(1)}s)${why}`);
  });

  const summary = formatSummary(loaded.series.name, resultsDir, records);
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify({ series: loaded.series.name, created_at: now.toISOString(), rows: records.length, passed: records.filter((r) => r.pass).length, records }, null, 2));
  console.log("\n" + summary);
  return records.every((r) => r.pass) ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`eval runner failed: ${fmtErr(e)}`);
  process.exit(1);
});
