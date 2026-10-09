/**
 * Manager-only workflow tools.
 *
 * The repair loop for manager-designed graphs IS the tool error:
 * workflow_validate runs the exact same parseWorkflow as hand-authored <workflows.path> files,
 * and a valid design is saved as a graph file on the spot.
 * Orchestrator profile: these three plus the delegation tools, no bash/edit/file-write
 * (profile tool allowlists enforce; hermes anti-temptation pattern).
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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
    // Re-dispatching a settled id (resume/continue) replaces the old entry;
    // history stays in the run dir's run.jsonl, not the registry.
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

  /**
   * A registry entry only blocks its id while the run is live. Once a run has
   * settled (finished or crashed) it stays in the map for status/history, but
   * its id becomes re-dispatchable so `run_id` can resume/continue the same
   * run dir -- reconcile-resume re-verifies completed nodes against the
   * filesystem, and the .owner claim still guards against live double-driving
   * (in-process races included: see the post-claim re-check in dispatch).
   */
  blocks(id: string): boolean {
    const m = this.#runs.get(id);
    return !!m && !m.finished && !m.error;
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
    "Run one with `workflow_dispatch(file=\"<name>\")` (optionally with `args` for graphs that declare `params`)",
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
  /** Resolved config modelGroups: enables declared-group resolution in validate/dispatch.
   *  When absent the group field is shape-checked only (runtime still resolves loudly). */
  getModelGroups?: () => Record<string, string[]>;
  registry: RunRegistry;
}

/** Resolve a model-supplied file reference inside the workflows dir and read
 *  it: a bare name (with or without the conventional `.workflow.yaml` suffix)
 *  or an absolute path the dir itself contains. Anything that resolves outside
 *  the dir is refused outright -- these tools must not become a general
 *  file-read primitive for profiles deliberately built without file tools. */
async function readWorkflowFileRef(
  fileRef: string,
  dir: string | null,
): Promise<{ text: string; path: string } | { error: string }> {
  if (!dir) return { error: "Error: workflows.path is not configured" };
  const root = resolve(dir);
  const base = resolve(root, fileRef);
  if (base !== root && !base.startsWith(root + sep)) {
    return { error: `Error: file must be inside the workflows dir (${root})` };
  }
  for (const cand of [base, `${base}.workflow.yaml`]) {
    try {
      return { text: await Bun.file(cand).text(), path: cand };
    } catch {
      // try the next candidate
    }
  }
  return { error: `no workflow file found; tried: ${base}, ${base}.workflow.yaml` };
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
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1, managerOnly: true };

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input) ?? {};
    const yaml = (args.yaml as string | undefined)?.trim();
    const file = (args.file as string | undefined)?.trim();
    if (yaml && file) return ToolResult.err("Error: provide either yaml or file, not both");
    if (!yaml && !file) return ToolResult.err("Error: yaml or file is required");

    // file mode: re-validate an existing graph, mirroring the CLI verbatim.
    if (file) {
      const ref = await readWorkflowFileRef(file, this.opts.getWorkflowsDir());
      if ("error" in ref) return ToolResult.err(ref.error);
      const r = runWorkflowCommandOnText(
        "validate",
        ref.path,
        ref.text,
        this.opts.limits,
        undefined,
        this.opts.getModelGroups?.(),
      );
      if (r.code !== 0) return ToolResult.err([...r.err, ...r.out].join("\n"));
      return ToolResult.ok(r.out.join("\n"));
    }

    // yaml mode: validate, then persist — validation IS the save step.
    // The identical entry point `hotdog workflow validate` uses — designs
    // face the same validator as hand-authored files.
    const r = runWorkflowCommandOnText(
      "validate",
      "designed workflow",
      yaml!,
      this.opts.limits,
      undefined,
      this.opts.getModelGroups?.(),
    );
    if (r.code !== 0) return ToolResult.err([...r.err, ...r.out].join("\n"));
    const wf = parseWorkflow(yaml!, { limits: this.opts.limits, modelGroups: this.opts.getModelGroups?.() }).workflow!; // validated above

    const dir = this.opts.getWorkflowsDir();
    if (!dir) return ToolResult.err("Error: workflows.path is not configured");

    // Name-derived filename: the validator's id rule keeps the path traversal-free.
    const target = join(dir, `${wf.name}.workflow.yaml`);
    // The availability listing keys by name, so two files claiming one name
    // would shadow each other; refuse instead of creating the second author.
    for (const w of await listWorkflows(dir, this.opts.limits)) {
      if (w.name === wf.name && w.file !== target) {
        return ToolResult.err(
          `workflow name '${wf.name}' is already defined by '${w.file}'; save over that graph or rename this one`,
        );
      }
    }

    const updating = await Bun.file(target).exists();
    await mkdir(dir, { recursive: true });
    await Bun.write(target, `${yaml}\n`);
    const warnings = r.out.filter((l) => l.startsWith("warning:"));
    return ToolResult.ok(
      [
        ...warnings,
        `${updating ? "updated" : "saved"} ${target}`,
        `Call workflow_dispatch with file='${target}' to run it.`,
      ].join("\n"),
    ).withEntries({ file: target });
  }

  toToolDef(): ToolDef {
    return toolDef(
      "workflow_validate",
      [
        "Validate a YAML workflow graph against the workflow schema.",
        "A valid graph is SAVED into the workflows directory as <name>.workflow.yaml and the saved path is returned:",
        "that is the only way to persist or update a workflow (same name updates in place).",
        "Saved graphs appear in managers' 'Available workflows' lists without a restart.",
        "Alternatively pass file (instead of yaml) to validate an existing graph in place: nothing is written.",
        "Schema: version: 1; name, description; optional params (id -> default string, null = required with no default; reference values as '{{params.<id>}}' inside any string so the saved graph is a reusable template);",
        "nodes[] with id, optional description / profile / group (a declared model group to fan out across) / dependsOn / inputs ('{{nodes.<id>}}' data refs imply ordering) / accept.",
        "accept.files are paths inside the run dir each node must create; acceptance is machine-checked via those files plus a '<node-id>.verdict' file whose first line is pass|fail|reject.",
        "accept.judge names a judge node gating that producer; accept.retryOn / maxAttempts bound retries (ceiling 3). Hard node cap; unknown keys are refused: never invent fields.",
      ].join(" "),
      {
        properties: {
          yaml: param("string", "The full workflow YAML document to validate and save"),
          file: param("string", "An existing workflow file to re-validate instead"),
        },
        required: [],
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
    const fileRef = (args.file as string | undefined)?.trim();
    if (!fileRef) {
      return ToolResult.err("Error: file is required (the path workflow_validate returned)");
    }

    let params: Record<string, string> | undefined;
    if (args.args !== undefined) {
      if (typeof args.args !== "object" || args.args === null || Array.isArray(args.args)) {
        return ToolResult.err("Error: args must be an object of param id -> string value");
      }
      params = {};
      for (const [k, v] of Object.entries(args.args as Record<string, unknown>)) {
        if (typeof v !== "string") {
          return ToolResult.err(`Error: args.'${k}' must be a string value`);
        }
        params[k] = v;
      }
    }

    // Resolve inside the workflows dir (see readWorkflowFileRef): bare name or
    // contained path; outside references are refused, not read.
    const ref = await readWorkflowFileRef(fileRef, this.opts.getWorkflowsDir());
    if ("error" in ref) return ToolResult.err(ref.error);

    // STRICT param mode: params is always at least an empty object, so a graph with an
    // undecided required param fails here, not mid-run.
    const parsed = parseWorkflow(ref.text, {
      limits: this.opts.limits,
      params: params ?? {},
      modelGroups: this.opts.getModelGroups?.(),
    });
    if (!parsed.workflow) {
      return ToolResult.err([
        `invalid workflow: ${ref.path}`,
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
    // A settled run (finished or crashed) no longer blocks its id: `run_id`
    // resumes/continues the same run dir (reconcile-resume re-verifies every
    // completed node against the filesystem, so only unfinished work reruns).
    // Only a LIVE in-process run refuses the id.
    if (forcedId && this.opts.registry.blocks(forcedId)) {
      return ToolResult.err(
        `run ${forcedId} is still active in this process; wait for it or '/workflow cancel ${forcedId}'`,
      );
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
      if (this.opts.registry.blocks(forcedId)) {
        return ToolResult.err(
          `run ${forcedId} is still active in this process; wait for it or '/workflow cancel ${forcedId}'`,
        );
      }
    }

    // The delegating agent: sessionId routes the completion message back to its bus;
    // model is the default for nodes without an explicit one.
    const callingAgent = ctx?.get("agent") as
      | { sessionId?: string; model?: string }
      | undefined;
    const callingSessionId = callingAgent?.sessionId ?? null;
    const parentModel =
      typeof callingAgent?.model === "string" && callingAgent.model.trim()
        ? callingAgent.model.trim()
        : undefined;

    const run = new WorkflowRun({
      workflow,
      runId,
      runDir,
      tasks,
      limits: this.opts.limits,
      ...(parentModel ? { parentModel } : {}),
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
        "Dispatch a saved workflow graph for execution: nodes run as parked task agents on provider lanes.",
        "Each node is machine-gated (declared output files + verdict); failed attempts retry with critique, exhausted attempts fail the node and block its descendants.",
        "file is the path workflow_validate returned, or a saved graph's name, resolved against the workflows dir.",
        "args optionally supplies values for the graph's declared params (id->string), making saved graphs reusable templates.",
        "Call workflow_validate first.",
        "run_id optionally resumes a previous run dir (filesystem-verified completed nodes are reused).",
        "The run completes asynchronously with a completion message; use workflow_status to inspect, and do NOT redesign the graph just to change an output: reconcile / resume with args instead.",
      ].join(" "),
      {
        properties: {
          file: param("string", "The workflow file to run (path returned by workflow_validate, or a saved graph's name)"),
          run_id: param(
            "string",
            "Optional explicit run id; passing a previous run's id resumes it (only filesystem-verified completed nodes are reused)",
          ),
          args: param(
            "object",
            "Optional values for the graph's declared params (param id -> string); every required param must receive a value or default",
            { additionalProperties: { type: "string" } },
          ),
        },
        required: ["file"],
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
  workflow_dispatch: (opts) => new WorkflowDispatchTool(opts),
  workflow_status: (opts) => new WorkflowStatusTool(opts),
};
