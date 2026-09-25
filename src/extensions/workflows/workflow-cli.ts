/**
 * `hotdog workflow` — thin CLI over the pure artifact module and the engine.
 * Kept pure (takes text in, lines out; live lines via the injected `emit`)
 * so the same validate entry point backs the manager's workflow_validate
 * tool; only index.ts prints.
 *
 * Runs live under `<workflows.path>/runs/<run-id>/`.
 * `status`/`reconcile` read the run log from disk, so they see runs owned by
 * other processes; `cancel` cannot reach across processes in v1 — the owning
 * Ctrl-C / `/workflow cancel` paths are all that stop a foreign live run.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatError } from "@core/error.ts";
import {
  parseWorkflow,
  renderWorkflow,
  type ParseResult,
  type WorkflowLimits,
} from "./workflow.ts";
import {
  isSafeRunId,
  nextRunId,
  readRunOwner,
  readRunSummary,
  reconcileRun,
  RUN_ID_SHAPE_HINT,
  WorkflowRun,
  type EngineTaskPort,
} from "./engine.ts";

export interface CommandOutcome {
  code: number;
  out: string[];
  err: string[];
}

const USAGE = [
  "usage: hotdog workflow validate|render <file.workflow.yaml>",
  "   or: hotdog workflow run <file.workflow.yaml> [--id <run-id>]",
  "   or: hotdog workflow list",
  "   or: hotdog workflow status|reconcile|cancel <run-id>",
].join("\n");

export interface WorkflowCliDeps {
  /** Runs directory (`<workflows.path>/runs`); required by the run-facing verbs. */
  runsRoot?: string;
  /** Limits from resolved config (soft node cap, default runtime). */
  limits?: Partial<WorkflowLimits>;
  /** Session-capable host for `run`; null when the config cannot drive agents. */
  runHost?: () => { tasks: EngineTaskPort } | null;
  /** Stream a line as it happens (live `run` progress). */
  emit?: (line: string) => void;
}

function invalidWorkflowOutcome(file: string, result: ParseResult): CommandOutcome {
  return {
    code: 1,
    out: result.warnings.map((w) => `warning: ${w}`),
    err: [`invalid workflow: ${file}`, ...result.errors.map((e) => `  - ${e}`)],
  };
}

/** Pure half: run validate|render over a loaded file's text. */
export function runWorkflowCommandOnText(
  verb: string,
  file: string,
  text: string,
  limits?: Partial<WorkflowLimits>,
): CommandOutcome {
  const result = parseWorkflow(text, { limits });
  const warnings = result.warnings.map((w) => `warning: ${w}`);

  if (!result.workflow) return invalidWorkflowOutcome(file, result);

  if (verb === "render") {
    return { code: 0, out: [renderWorkflow(result.workflow).replace(/\n$/, ""), ...warnings], err: [] };
  }

  const wf = result.workflow;
  return {
    code: 0,
    out: [`valid: ${wf.name} (${wf.nodes.length} node${wf.nodes.length === 1 ? "" : "s"})`, ...warnings],
    err: [],
  };
}

async function readWorkflowFile(file: string): Promise<{ outcome?: CommandOutcome; text?: string }> {
  try {
    return { text: await Bun.file(file).text() };
  } catch (e) {
    return {
      outcome: {
        code: 1,
        out: [],
        err: [`cannot read '${file}': ${e instanceof Error ? e.message : String(e)}`],
      },
    };
  }
}

function needRunsRoot(deps: WorkflowCliDeps): CommandOutcome | null {
  if (deps.runsRoot) return null;
  return { code: 1, out: [], err: ["no runs directory configured (workflows.path)"] };
}

async function cmdRun(args: string[], deps: WorkflowCliDeps): Promise<CommandOutcome> {
  const rest = [...args];
  let forcedId: string | null = null;
  const idAt = rest.indexOf("--id");
  if (idAt !== -1) {
    forcedId = rest[idAt + 1] ?? null;
    if (!forcedId) return { code: 1, out: [], err: ["--id requires a run id"] };
    if (!isSafeRunId(forcedId)) {
      return { code: 1, out: [], err: [`invalid run id '${forcedId}' (${RUN_ID_SHAPE_HINT})`] };
    }
    rest.splice(idAt, 2);
  }
  const file = rest[0];
  if (!file) return { code: 1, out: [], err: [USAGE] };
  if (rest.length > 1) return { code: 1, out: [], err: [USAGE] };

  const rootProblem = needRunsRoot(deps);
  if (rootProblem) return rootProblem;
  const host = deps.runHost?.() ?? null;
  if (!host) {
    return { code: 1, out: [], err: ["run requires a session-capable config (no TaskManager)"] };
  }

  const { outcome, text } = await readWorkflowFile(file);
  if (outcome) return outcome;
  const result = parseWorkflow(text!, { limits: deps.limits });
  if (!result.workflow) return invalidWorkflowOutcome(file, result);
  const workflow = result.workflow;

  const runsRoot = deps.runsRoot!;
  const runId = forcedId ?? (await nextRunId(runsRoot, workflow.name));
  const runDir = join(runsRoot, runId);
  const run = new WorkflowRun({ workflow, runId, runDir, tasks: host.tasks, limits: deps.limits });

  const emit = deps.emit ?? (() => {});
  emit(`run ${runId} (${workflow.name}) in ${runDir}`);

  // Ctrl-C = graceful cancel; cross-process cancel is a v1 non-goal.
  // A second Ctrl-C exits hard, same as any other CLI.
  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (sigints > 1) process.exit(130);
    emit("cancelling (Ctrl-C again to exit hard)");
    run.cancel();
  };
  process.on("SIGINT", onSigint);

  // Live progress: transitions observed in engine status snapshots, one line each.
  const seen = new Map<string, string>();
  const poll = setInterval(() => {
    for (const s of run.status()) {
      const tag = `${s.state}|${s.attempt}`;
      if (seen.get(s.id) === tag) continue;
      if (!seen.has(s.id) && s.state === "pending") {
        seen.set(s.id, tag);
        continue;
      }
      seen.set(s.id, tag);
      emit(`  ${s.id}: ${s.state}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}`);
    }
  }, 1000);

  try {
    const summary = await run.run();
    const out = [`run ${runId}: ${summary.outcome}`];
    for (const [id, state] of Object.entries(summary.states)) {
      if (state !== "succeeded") out.push(`  ${id}: ${state}`);
    }
    return { code: summary.outcome === "succeeded" ? 0 : 1, out, err: [] };
  } catch (e: unknown) {
    // Resume guards (foreign workflow / different node graph in --id's run
    // dir) and any pre-scheduling engine throw: a clean CLI error line, not
    // an unhandled rejection.
    return { code: 1, out: [], err: [`run ${runId} failed: ${formatError(e)}`] };
  } finally {
    clearInterval(poll);
    process.off("SIGINT", onSigint);
  }
}

async function cmdList(runsRoot: string): Promise<CommandOutcome> {
  let names: string[];
  try {
    names = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { code: 0, out: ["no runs"], err: [] };
  }
  names.sort();
  const out: string[] = [];
  for (const name of names) {
    const s = await readRunSummary(join(runsRoot, name));
    if (!s) continue; // not a run dir (no usable run.jsonl)
    out.push(`${s.runId}  ${s.workflow}  ${s.outcome ?? "unfinished"}`);
  }
  return { code: 0, out: out.length ? out : ["no runs"], err: [] };
}

async function cmdStatus(runsRoot: string, runId: string): Promise<CommandOutcome> {
  const s = await readRunSummary(join(runsRoot, runId));
  if (!s) return { code: 1, out: [], err: [`no run.jsonl for '${runId}' under ${runsRoot}`] };
  const out = [`run ${s.runId} (${s.workflow}): ${s.outcome ?? "unfinished"}`];
  for (const n of s.nodes) out.push(`  ${n.id}: ${n.state}`);
  return { code: 0, out, err: [] };
}

async function cmdReconcile(runsRoot: string, runId: string): Promise<CommandOutcome> {
  try {
    const r = await reconcileRun(join(runsRoot, runId));
    return {
      code: 0,
      out: [
        `run ${r.runId} (${r.workflow})`,
        `  valid: ${r.valid.length ? r.valid.join(", ") : "(none)"}`,
        `  invalid: ${r.invalid.length ? r.invalid.join(", ") : "(none)"}`,
        `  incomplete: ${r.incomplete.length ? r.incomplete.join(", ") : "(none)"}`,
        "",
        `to resume: re-run the workflow file with --id ${r.runId} (valid claims are reused)`,
      ],
      err: [],
    };
  } catch (e) {
    return { code: 1, out: [], err: [e instanceof Error ? e.message : String(e)] };
  }
}

async function cmdCancel(runsRoot: string, runId: string): Promise<CommandOutcome> {
  const s = await readRunSummary(join(runsRoot, runId));
  if (!s) return { code: 1, out: [], err: [`no run.jsonl for '${runId}' under ${runsRoot}`] };
  if (s.outcome) return { code: 0, out: [`run ${runId}: already ${s.outcome}`], err: [] };
  const owner = await readRunOwner(join(runsRoot, runId));
  return {
    code: 1,
    out: [],
    err: [
      `run ${runId} is unfinished, but this process does not own it (cancel only reaches in-process runs).` +
        (owner ? ` Owner: pid ${owner.pid} on '${owner.host}' (claimed ${owner.claimedAt}).` : ""),
      "Ctrl-C the owning 'hotdog workflow run', or use '/workflow cancel' in the session that dispatched it.",
    ],
  };
}

export async function runWorkflowCommand(
  args: string[],
  deps: WorkflowCliDeps = {},
): Promise<CommandOutcome> {
  const [verb, ...rest] = args;
  if (!verb || verb === "help") {
    return { code: 1, out: [], err: [USAGE] };
  }

  switch (verb) {
    case "validate":
    case "render": {
      const file = rest[0];
      if (!file) return { code: 1, out: [], err: [USAGE] };
      const { outcome, text } = await readWorkflowFile(file);
      if (outcome) return outcome;
      return runWorkflowCommandOnText(verb, file, text!, deps.limits);
    }
    case "run":
      return cmdRun(rest, deps);
    case "list": {
      const rootProblem = needRunsRoot(deps);
      if (rootProblem) return rootProblem;
      return cmdList(deps.runsRoot!);
    }
    case "status":
    case "reconcile":
    case "cancel": {
      const rootProblem = needRunsRoot(deps);
      if (rootProblem) return rootProblem;
      const runId = rest[0];
      if (!runId) return { code: 1, out: [], err: [USAGE] };
      if (!isSafeRunId(runId)) {
        return { code: 1, out: [], err: [`invalid run id '${runId}' (${RUN_ID_SHAPE_HINT})`] };
      }
      if (verb === "status") return cmdStatus(deps.runsRoot!, runId);
      if (verb === "reconcile") return cmdReconcile(deps.runsRoot!, runId);
      return cmdCancel(deps.runsRoot!, runId);
    }
    default:
      return { code: 1, out: [], err: [`unknown verb '${verb}'`, USAGE] };
  }
}
