/**
 * Manager-only workflow tools (subagents precedent: managerOnly metadata +
 * lazy TaskManager lookup via the "taskManager" service, since sessions are
 * created after extensions load).
 *
 * The repair loop for manager-designed graphs IS the tool error:
 * workflow_validate runs the exact same parseWorkflow as hand-authored
 * config/workflows files. Orchestrator profile: these three plus the
 * delegation tools, no bash/edit/file-write (profile tool allowlists
 * enforce; hermes anti-temptation pattern).
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  toolDef,
  param,
  parseToolInput,
  ToolResult,
  defaultCallDisplay,
} from "@core/extensions/tool-utils.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { ToolContext } from "@core/extensions/types.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { parseWorkflow, type WorkflowLimits } from "./workflow.ts";
import {
  claimRunDir,
  isSafeRunId,
  nextRunId,
  readRunSummary,
  RUN_ID_SHAPE_HINT,
  WorkflowRun,
  type RunSummary,
} from "./engine.ts";
import { runWorkflowCommandOnText } from "./workflow-cli.ts";

// ---------------------------------------------------------------------------
// in-process run registry (dispatched runs; /workflow + /followup use it too)
// ---------------------------------------------------------------------------

export interface ManagedRun {
  runId: string;
  workflow: string;
  runDir: string;
  startedAt: number;
  run: WorkflowRun;
  finished: RunSummary | null;
  error: string | null;
}

export class RunRegistry {
  #runs = new Map<string, ManagedRun>();

  add(mr: ManagedRun): void {
    this.#runs.set(mr.runId, mr);
  }

  get(runId: string): ManagedRun | null {
    return this.#runs.get(runId) ?? null;
  }

  all(): ManagedRun[] {
    return [...this.#runs.values()];
  }

  active(): ManagedRun[] {
    return this.all().filter((r) => !r.finished && !r.error);
  }
}

export function managedRunLines(m: ManagedRun): string[] {
  const head = m.finished
    ? `run ${m.runId} (${m.workflow}): ${m.finished.outcome}`
    : m.error
      ? `run ${m.runId} (${m.workflow}): crashed (${m.error})`
      : `run ${m.runId} (${m.workflow}): active`;
  if (m.error && !m.finished) return [head];
  return [
    head,
    ...m.run.status().map((v) => {
      const attempt = v.attempt > 1 ? ` (attempt ${v.attempt})` : "";
      const detail = v.detail ? ` — ${v.detail.slice(0, 160)}` : "";
      return `  ${v.id}: ${v.state}${attempt}${detail}`;
    }),
  ];
}

/** Pointer-only completion text for the manager's bus (never node payloads). */
export function formatRunCompletion(s: RunSummary, runDir: string): string {
  const bad = Object.entries(s.states).filter(([, st]) => st !== "succeeded");
  return [
    `Workflow run ${s.runId}: ${s.outcome} (${Object.keys(s.states).length} nodes)`,
    ...bad.map(([id, st]) => `  ${id}: ${st}`),
    `run dir: ${runDir}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// availability listing (skills-style: name + description for the manager)
// ---------------------------------------------------------------------------

export interface WorkflowListing {
  name: string;
  description: string;
  file: string;
}

/** Parse every *.workflow.yaml in `dir` for name+description; invalid files are skipped with a warning. */
export async function listWorkflows(
  dir: string,
  limits?: Partial<WorkflowLimits>,
): Promise<WorkflowListing[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    return [];
  }
  names.sort();
  const out: WorkflowListing[] = [];
  for (const f of names) {
    const entry = await loadListing(join(dir, f), f, limits);
    if (entry) out.push(entry);
  }
  return out;
}

async function loadListing(
  file: string,
  name: string,
  limits?: Partial<WorkflowLimits>,
): Promise<WorkflowListing | null> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (e: unknown) {
    logger.warn(`[workflows] cannot read '${name}': ${formatError(e)}`);
    return null;
  }
  const r = parseWorkflow(text, { limits });
  if (!r.workflow) {
    logger.warn(`[workflows] skipping invalid '${name}': ${r.errors[0] ?? "parse error"}`);
    return null;
  }
  return { name: r.workflow.name, description: r.workflow.description, file };
}

/**
 * Live availability listing: rescans `dir` on every call so graphs saved
 * mid-session show up in manager prompts without a restart. Cheap by design
 * -- readdir + stat per file, YAML is re-parsed only for new/changed files
 * (mtime+size keyed cache; invalid files stay cached until they change).
 */
export function createWorkflowScanner(
  dir: string,
  limits?: Partial<WorkflowLimits>,
): () => Promise<WorkflowListing[]> {
  const cache = new Map<string, { mtimeMs: number; size: number; entry: WorkflowListing | null }>();
  return async () => {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f));
    } catch {
      cache.clear();
      return [];
    }
    names.sort();
    const present = new Set(names);
    for (const gone of cache.keys()) if (!present.has(gone)) cache.delete(gone);
    const out: WorkflowListing[] = [];
    for (const f of names) {
      let st;
      try {
        st = await stat(join(dir, f));
      } catch {
        cache.delete(f); // vanished between readdir and stat
        continue;
      }
      const hit = cache.get(f);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        if (hit.entry) out.push(hit.entry);
        continue;
      }
      const entry = await loadListing(join(dir, f), f, limits);
      cache.set(f, { mtimeMs: st.mtimeMs, size: st.size, entry });
      if (entry) out.push(entry);
    }
    return out;
  };
}

export function workflowsPreamble(list: WorkflowListing[]): string {
  if (list.length === 0) return "";
  return [
    "## Available workflows",
    "",
    "Saved multi-agent workflow graphs (validated DAGs of worker nodes).",
    "Run one as-is with `hotdog workflow run <file>`, or reproduce its YAML and dispatch with `workflow_dispatch`.",
    "",
    ...list.map((w) => `- ${w.name}: ${w.description} (${w.file})`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export interface WorkflowToolOptions {
  /** Lazy TaskManager lookup (subagents pattern): sessions exist after extension load. */
  taskManagerProvider: () => TaskManager | null;
  /** `<workflows.path>/runs`; null when workflows.path is unset. */
  getRunsRoot: () => string | null;
  /** The workflows directory holding `*.workflow.yaml` graphs; null when unset. */
  getWorkflowsDir: () => string | null;
  /** Soft limits from resolved config (workflows.maxNodes, workflows.maxRuntimeMins). */
  limits: Partial<WorkflowLimits>;
  registry: RunRegistry;
}

abstract class WorkflowTool {
  abstract metadata: ToolMetadata;
  protected opts: WorkflowToolOptions;

  constructor(opts: WorkflowToolOptions) {
    this.opts = opts;
  }

  protected tasks(): TaskManager | null {
    return this.opts.taskManagerProvider();
  }

  abstract execute(
    input: string | Record<string, unknown> | null,
    ctx?: ToolContext,
  ): Promise<ToolResult>;

  abstract toToolDef(): ToolDef;

  callDisplay(_input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      _input,
      () => (this.constructor as { TOOL_NAME?: string }).TOOL_NAME ?? this.constructor.name,
    );
  }
}

// ── workflow_validate ───────────────────────────────────────────────────────

export class WorkflowValidateTool extends WorkflowTool {
  static readonly TOOL_NAME = "workflow_validate";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1, managerOnly: true };

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input) ?? {};
    const yaml = (args.yaml as string | undefined)?.trim();
    if (!yaml) return ToolResult.err("Error: yaml is required");

    // The identical entry point `hotdog workflow validate` uses — designs
    // face the same validator as hand-authored files.
    const r = runWorkflowCommandOnText("validate", "designed workflow", yaml, this.opts.limits);
    if (r.code !== 0) return ToolResult.err([...r.err, ...r.out].join("\n"));
    return ToolResult.ok([...r.out, "Valid. Call workflow_dispatch with this yaml to run it."].join("\n"));
  }

  toToolDef(): ToolDef {
    return toolDef(
      "workflow_validate",
      [
        "Validate a workflow graph (YAML) against the workflow schema — the exact validator hand-authored config/workflows files face. Errors are collected and repair-worthy: fix the yaml and call again.",
        "Schema: version: 1; name, description; nodes[] with id, optional description/profile/group (a declared model group to fan out across)/dependsOn/inputs ('{{nodes.<id>}}' data refs imply ordering)/accept. accept.files are paths inside the run dir each node must create; acceptance is machine-checked via those files plus a '<node-id>.verdict' file whose first line is pass|fail|reject. accept.judge names a judge node gating that producer; accept.retryOn/maxAttempts bound retries (ceiling 3). Hard node cap; unknown keys are refused — never invent fields.",
      ].join(" "),
      {
        properties: {
          yaml: param("string", "The full workflow YAML document"),
        },
        required: ["yaml"],
      },
    );
  }
}

// ── workflow_save ───────────────────────────────────────────────────────────

export class WorkflowSaveTool extends WorkflowTool {
  static readonly TOOL_NAME = "workflow_save";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 2, managerOnly: true };

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input) ?? {};
    const yaml = (args.yaml as string | undefined)?.trim();
    if (!yaml) return ToolResult.err("Error: yaml is required");

    // Only validated graphs hit the filesystem: a saved graph is trusted
    // input for future dispatches and for every manager's availability list.
    const r = runWorkflowCommandOnText("validate", "designed workflow", yaml, this.opts.limits);
    if (r.code !== 0) return ToolResult.err([...r.err, ...r.out].join("\n"));
    const wf = parseWorkflow(yaml, { limits: this.opts.limits }).workflow!; // validated above

    const dir = this.opts.getWorkflowsDir();
    if (!dir) return ToolResult.err("Error: workflows.path is not configured");

    // Name-derived filename: the validator's id rule keeps the path traversal-free.
    const file = join(dir, `${wf.name}.workflow.yaml`);
    // The availability listing keys by name, so two files claiming one name
    // would shadow each other; refuse instead of creating the second author.
    for (const w of await listWorkflows(dir, this.opts.limits)) {
      if (w.name === wf.name && w.file !== file) {
        return ToolResult.err(
          `workflow name '${wf.name}' is already defined by '${w.file}'; save over that graph or rename this one`,
        );
      }
    }

    const updating = await Bun.file(file).exists();
    await mkdir(dir, { recursive: true });
    await Bun.write(file, `${yaml}\n`);
    const warnings = r.out.filter((l) => l.startsWith("warning:"));
    return ToolResult.ok(
      [...warnings, `${updating ? "updated" : "saved"} ${file}`].join("\n"),
    ).withEntries({ file });
  }

  toToolDef(): ToolDef {
    return toolDef(
      "workflow_save",
      [
        "Save a workflow graph (YAML) into the workflows directory as <name>.workflow.yaml — the only way to persist or update a workflow; you have no file-write tools. Same name updates the existing graph in place.",
        "The yaml faces the same validator as workflow_validate before anything is written (errors are your repair list). A name already claimed by a different file is refused — availability keys by name.",
        "Saved graphs appear in managers' 'Available workflows' lists without a restart.",
      ].join(" "),
      {
        properties: {
          yaml: param("string", "The full workflow YAML document (must pass validation)"),
        },
        required: ["yaml"],
      },
    );
  }
}

// ── workflow_dispatch ───────────────────────────────────────────────────────

export class WorkflowDispatchTool extends WorkflowTool {
  static readonly TOOL_NAME = "workflow_dispatch";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 3, managerOnly: true };

  async execute(
    input: string | Record<string, unknown> | null,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const args = parseToolInput(input) ?? {};
    const yaml = (args.yaml as string | undefined)?.trim();
    if (!yaml) return ToolResult.err("Error: yaml is required");

    const parsed = parseWorkflow(yaml, { limits: this.opts.limits });
    if (!parsed.workflow) {
      return ToolResult.err([
        "invalid workflow — run workflow_validate for the full report:",
        ...parsed.errors.map((e) => `  - ${e}`),
      ].join("\n"));
    }

    const tasks = this.tasks();
    if (!tasks) return ToolResult.err("Error: Task manager not available");
    const runsRoot = this.opts.getRunsRoot();
    if (!runsRoot) return ToolResult.err("Error: workflows.path is not configured");

    const workflow = parsed.workflow;
    const forcedId = (args.run_id as string | undefined)?.trim();
    if (forcedId && !isSafeRunId(forcedId)) {
      return ToolResult.err(
        `invalid run_id '${forcedId}' (${RUN_ID_SHAPE_HINT})`,
      );
    }
    if (forcedId && this.opts.registry.get(forcedId)) {
      return ToolResult.err(`run ${forcedId} is already known in this process`);
    }
    const runId = forcedId || (await nextRunId(runsRoot, workflow.name));
    const runDir = join(runsRoot, runId);

    // Resume (forced id) claims the dir here, before the run is registered:
    // a live run dir owned by another process must be refused synchronously,
    // not discovered by the background run() and delivered as a crash.
    // The auto id is already reserved by nextRunId's exclusive mkdir.
    if (forcedId) {
      await mkdir(runDir, { recursive: true });
      const claim = await claimRunDir(runDir);
      if (!claim.ok) {
        return ToolResult.err(
          `run ${forcedId} is owned by live process ${claim.owner.pid} on '${claim.owner.host}'; ` +
            "stop it there before resuming",
        );
      }
      // The claim awaited: another dispatch could have grabbed the id meanwhile.
      // Do NOT release the marker here: the winning registration's run() owns
      // it and releases it in its finally. Deleting it now would leave the
      // live run's dir unclaimed against foreign processes (double-drive).
      if (this.opts.registry.get(forcedId)) {
        return ToolResult.err(`run ${forcedId} is already known in this process`);
      }
    }

    const run = new WorkflowRun({
      workflow,
      runId,
      runDir,
      tasks,
      limits: this.opts.limits,
    });
    const managed: ManagedRun = {
      runId,
      workflow: workflow.name,
      runDir,
      startedAt: Date.now(),
      run,
      finished: null,
      error: null,
    };
    this.opts.registry.add(managed);

    // Completion rides the delegating session's bus as a trusted harness
    // message (the task-completion delivery path) — a background run must
    // not require the manager to poll.
    const callingSessionId =
      (ctx?.get("agent") as { sessionId?: string } | undefined)?.sessionId ?? null;
    void run
      .run()
      .then((summary) => {
        managed.finished = summary;
        if (callingSessionId) {
          tasks.deliverTaskCompletion(runId, formatRunCompletion(summary, runDir), {
            sessionId: callingSessionId,
          });
        }
      })
      .catch((e: unknown) => {
        managed.error = e instanceof Error ? e.message : String(e);
        logger.error(`[workflow ${runId}] run crashed: ${formatError(e)}`);
        // The dispatch result promised a completion message; a crashed run
        // must deliver one too, or the delegating manager waits forever
        // (a resumed run dir holding a different graph throws here). Skipped
        // when the crash happened after the completion was already delivered.
        if (callingSessionId && !managed.finished) {
          tasks.deliverTaskCompletion(
            runId,
            `Workflow run ${runId}: crashed (${managed.error})\nrun dir: ${runDir}`,
            { sessionId: callingSessionId },
          );
        }
      });

    return ToolResult.ok(
      `run ${runId} dispatched (${workflow.nodes.length} node${workflow.nodes.length === 1 ? "" : "s"}; dir ${runDir}). ` +
        "You will receive a completion message; do not poll. workflow_status(run_id) shows live node states.",
    ).withEntries({ run_id: runId, run_dir: runDir });
  }

  toToolDef(): ToolDef {
    return toolDef(
      "workflow_dispatch",
      [
        "Dispatch a validated workflow graph for execution: nodes run as parked task agents on provider lanes (concurrency per provider is capped; node pins/requirements resolve against the model catalog). Each node is machine-gated (declared output files + verdict); failed attempts retry with critique, exhausted attempts fail the node and block its descendants.",
        "Call workflow_validate first — invalid yaml fails here too. run_id optionally resumes a previous run dir (filesystem-verified completed nodes are reused). The run completes asynchronously with a completion message; use workflow_status to inspect, and do NOT redesign the graph just to change an output — reconcile/resume instead.",
      ].join(" "),
      {
        properties: {
          yaml: param("string", "The workflow YAML document (must pass workflow_validate)"),
          run_id: param(
            "string",
            "Optional explicit run id; passing a previous run's id resumes it (only filesystem-verified completed nodes are reused)",
          ),
        },
        required: ["yaml"],
      },
    );
  }
}

// ── workflow_status ─────────────────────────────────────────────────────────

export class WorkflowStatusTool extends WorkflowTool {
  static readonly TOOL_NAME = "workflow_status";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 4, managerOnly: true };

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input) ?? {};
    const runId = (args.run_id as string | undefined)?.trim();
    const reg = this.opts.registry;

    if (runId) {
      if (!isSafeRunId(runId)) {
        return ToolResult.err(`invalid run_id '${runId}' (${RUN_ID_SHAPE_HINT})`);
      }
      const m = reg.get(runId);
      if (m) return ToolResult.ok(managedRunLines(m).join("\n"));
      // Runs owned by other processes (a foreground `hotdog workflow run`)
      // are visible read-only through the run log.
      const runsRoot = this.opts.getRunsRoot();
      if (runsRoot) {
        const s = await readRunSummary(join(runsRoot, runId));
        if (s) {
          return ToolResult.ok(
            [
              `run ${s.runId} (${s.workflow}): ${s.outcome ?? "unfinished"} (owned by another process)`,
              ...s.nodes.map((n) => `  ${n.id}: ${n.state}`),
            ].join("\n"),
          );
        }
      }
      return ToolResult.err(`run ${runId} not found`);
    }

    const runs = reg.all();
    if (runs.length === 0) {
      return ToolResult.ok("No workflow runs dispatched in this process.");
    }
    return ToolResult.ok(
      runs
        .map((m) =>
          m.finished
            ? `${m.runId}  ${m.workflow}  ${m.finished.outcome}`
            : m.error
              ? `${m.runId}  ${m.workflow}  crashed`
              : `${m.runId}  ${m.workflow}  active`,
        )
        .join("\n"),
    );
  }

  toToolDef(): ToolDef {
    return toolDef(
      "workflow_status",
      "[DO NOT USE for polling] Show workflow runs dispatched in this session (with no run_id) or one run's per-node states (run_id). Runs notify on completion; only call this when the user asks or before deciding a recovery step.",
      {
        properties: {
          run_id: param("string", "Optional run id to inspect in detail"),
        },
        required: [],
      },
    );
  }
}

// ---------------------------------------------------------------------------

export const WORKFLOW_TOOL_CONSTRUCTORS: Record<
  string,
  (opts: WorkflowToolOptions) => WorkflowTool
> = {
  workflow_validate: (opts) => new WorkflowValidateTool(opts),
  workflow_save: (opts) => new WorkflowSaveTool(opts),
  workflow_dispatch: (opts) => new WorkflowDispatchTool(opts),
  workflow_status: (opts) => new WorkflowStatusTool(opts),
};
