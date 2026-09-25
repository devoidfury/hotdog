// Increment 5 (surfaces) tests: the new CLI verbs, the manager tool trio,
// the /workflow + /followup commands, and the availability listing.
// No fleet access: TaskManager runs scripted fake workers, like the engine
// tests do.

import { describe, it, expect, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { HOOKS } from "@core/hooks.ts";
import { contentToText } from "@core/context/message.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { create } from "@extensions/workflows/index.ts";
import { runWorkflowCommand } from "@extensions/workflows/workflow-cli.ts";
import { parseWorkflow } from "@extensions/workflows/workflow.ts";
import {
  claimRunDir,
  nextRunId,
  WorkflowRun,
  type EngineTaskPort,
} from "@extensions/workflows/engine.ts";
import {
  RunRegistry,
  WorkflowDispatchTool,
  WorkflowSaveTool,
  WorkflowStatusTool,
  WorkflowValidateTool,
  createWorkflowScanner,
  listWorkflows,
} from "@extensions/workflows/workflow-tools.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-surf-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW_TEXT = `
version: 1
name: runnable
description: cli run smoke
nodes:
  - id: a
    accept:
      files: [a.out]
  - id: b
    dependsOn: [a]
    accept:
      files: [b.out]
`;

async function settle(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ---------------------------------------------------------------------------
// fake TaskManager: workers extract run dir + node id from the composed prompt
// ---------------------------------------------------------------------------

function makeFakeAgents(opts: { slow?: boolean } = {}) {
  let builds = 0;
  const tasks = new TaskManager({
    buildAgent: async () => {
      builds++;
      return {
        run: async (input: string | Array<Record<string, unknown>>) => {
          const prompt = contentToText(input);
          const id = /node '([a-z0-9-]+)'/.exec(prompt)?.[1] ?? "x";
          const dir = /\.verdict under (.+): first line/.exec(prompt)?.[1];
          if (dir) {
            if (opts.slow && id === "a") await new Promise((r) => setTimeout(r, 1100));
            writeFileSync(join(dir, `${id}.out`), "artifact");
            writeFileSync(join(dir, `${id}.verdict`), "pass");
          }
          return { type: "completion", content: `${id} pointer-summary` };
        },
        notifyCompletion: () => {},
        steer: () => {},
      } as never;
    },
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
  });
  return { tasks, builds: () => builds };
}

// ---------------------------------------------------------------------------
// seeded run dirs for list / status / reconcile / cancel
// ---------------------------------------------------------------------------

function seedRun(
  runsRoot: string,
  runId: string,
  opts: { finished?: string; succeededA?: boolean } = {},
): string {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const events: Array<Record<string, unknown>> = [
    { ev: "started", runId, workflow: "demo", nodes: ["a", "b"], startedAt: 1 },
  ];
  if (opts.succeededA) {
    writeFileSync(join(dir, "a.out"), "hello");
    writeFileSync(join(dir, "a.verdict"), "pass");
    const st = statSync(join(dir, "a.out"));
    events.push({
      ev: "node",
      id: "a",
      state: "succeeded",
      attempt: 1,
      verdict: "pass",
      summary: "s",
      deps: [],
      files: { "a.out": { size: st.size, mtimeMs: st.mtimeMs } },
    });
  }
  if (opts.finished) events.push({ ev: "finished", outcome: opts.finished });
  writeFileSync(join(dir, "run.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

describe("cli: list / status / reconcile / cancel", () => {
  it("list reports one line per run dir, skipping non-runs", async () => {
    const root = freshDir();
    seedRun(root, "20260101-1010-one", { finished: "succeeded" });
    seedRun(root, "20260101-1011-two"); // unfinished
    mkdirSync(join(root, "not-a-run"));
    const r = await runWorkflowCommand(["list"], { runsRoot: root });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "20260101-1010-one  demo  succeeded",
      "20260101-1011-two  demo  unfinished",
    ]);
  });

  it("list with no runs dir is empty success", async () => {
    const r = await runWorkflowCommand(["list"], { runsRoot: join(freshDir(), "nope") });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["no runs"]);
  });

  it("status prints per-node states from the log", async () => {
    const root = freshDir();
    seedRun(root, "r1", { succeededA: true });
    const r = await runWorkflowCommand(["status", "r1"], { runsRoot: root });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("run r1 (demo): unfinished");
    expect(r.out).toContain("  a: succeeded");
    expect(r.out).toContain("  b: pending");
  });

  it("reconcile validates fs claims and lists incomplete nodes", async () => {
    const root = freshDir();
    seedRun(root, "r1", { succeededA: true, finished: "failed" });
    const r = await runWorkflowCommand(["reconcile", "r1"], { runsRoot: root });
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("valid: a");
    expect(r.out.join("\n")).toContain("incomplete: b");
    expect(r.out.join("\n")).toContain("--id r1");
  });

  it("reconcile catches a stale claim after its output changed", async () => {
    const root = freshDir();
    const dir = seedRun(root, "r1", { succeededA: true, finished: "failed" });
    writeFileSync(join(dir, "a.out"), "hello mutated");
    const r = await runWorkflowCommand(["reconcile", "r1"], { runsRoot: root });
    expect(r.out.join("\n")).toContain("invalid: a");
  });

  it("cancel on a finished run is idempotent success", async () => {
    const root = freshDir();
    seedRun(root, "r1", { finished: "succeeded" });
    const r = await runWorkflowCommand(["cancel", "r1"], { runsRoot: root });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("run r1: already succeeded");
  });

  it("cancel of a foreign live run explains ownership (v1 constraint)", async () => {
    const root = freshDir();
    seedRun(root, "r1");
    const r = await runWorkflowCommand(["cancel", "r1"], { runsRoot: root });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("does not own it");
    expect(r.err.join("\n")).toContain("/workflow cancel");
  });

  it("status/cancel/reconcile of an unknown run fail; missing runsRoot fails", async () => {
    const root = freshDir();
    expect((await runWorkflowCommand(["status", "nope"], { runsRoot: root })).code).toBe(1);
    expect((await runWorkflowCommand(["cancel", "nope"], { runsRoot: root })).code).toBe(1);
    expect((await runWorkflowCommand(["reconcile", "nope"], { runsRoot: root })).code).toBe(1);
    const noRoot = await runWorkflowCommand(["list"]);
    expect(noRoot.code).toBe(1);
    expect(noRoot.err[0]).toContain("workflows.path");
  });
});

describe("cli: run", () => {
  it("nextRunId builds plan-decision-4 ids and avoids collisions", async () => {
    const root = freshDir();
    const now = new Date(2026, 0, 1, 10, 10);
    expect(await nextRunId(root, "demo", now)).toBe("20260101-1010-demo");
    // The dir is RESERVED by nextRunId itself (exclusive mkdir, TOCTOU): a
    // bare dir with no run.jsonl still takes the id out of circulation --
    // a second process in the same minute cannot pick the same run dir.
    expect(await nextRunId(root, "demo", now)).toBe("20260101-1010-demo-2");
    seedRun(root, "20260101-1010-demo-2");
    expect(await nextRunId(root, "demo", now)).toBe("20260101-1010-demo-3");
  });

  it("runs a graph to completion, exits 0, writes run.jsonl", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const fake = makeFakeAgents();
    const emitted: string[] = [];
    const r = await runWorkflowCommand(["run", file], {
      runsRoot: root,
      runHost: () => ({ tasks: fake.tasks }),
      emit: (l) => emitted.push(l),
    });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^run 2\d{7}-\d{4}-runnable: succeeded$/);
    const runDir = join(root, r.out[0]!.slice(4, r.out[0]!.indexOf(":")));
    for (const f of ["a.out", "a.verdict", "b.out", "b.verdict", "run.jsonl"]) {
      statSync(join(runDir, f));
    }
  });

  it("emits live progress lines while nodes run", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const fake = makeFakeAgents({ slow: true });
    const emitted: string[] = [];
    const r = await runWorkflowCommand(["run", file], {
      runsRoot: root,
      runHost: () => ({ tasks: fake.tasks }),
      emit: (l) => emitted.push(l),
    });
    expect(r.code).toBe(0);
    expect(emitted[0]).toContain("in ");
    expect(emitted.some((l) => l.includes("a: running"))).toBe(true);
  });

  it("--id re-runs the same dir; surviving claims are reused, no rebuild", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const first = makeFakeAgents();
    const r1 = await runWorkflowCommand(["run", file], {
      runsRoot: root,
      runHost: () => ({ tasks: first.tasks }),
    });
    expect(r1.code).toBe(0);
    const runId = r1.out[0]!.slice(4, r1.out[0]!.indexOf(":"));

    const second = makeFakeAgents();
    const r2 = await runWorkflowCommand(["run", file, "--id", runId], {
      runsRoot: root,
      runHost: () => ({ tasks: second.tasks }),
    });
    expect(r2.code).toBe(0);
    expect(second.builds()).toBe(0); // everything was reused from disk
    expect(readFileSync(join(root, runId, "run.jsonl"), "utf8")).toContain('"ev":"resumed"');
  });

  it("run without a session-capable host fails cleanly", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const r = await runWorkflowCommand(["run", file], { runsRoot: root });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("session-capable");
  });

  it("run on an invalid graph returns the collected validation errors", async () => {
    const root = freshDir();
    const file = join(root, "bad.yaml");
    writeFileSync(file, "version: 1\nname: Bad!\nnodes: []\n");
    const r = await runWorkflowCommand(["run", file], {
      runsRoot: root,
      runHost: () => ({ tasks: new TaskManager({ buildAgent: async () => ({} as never), modelRegistry: {}, config: {}, maxIterations: 1, taskProfile: "default" }) }),
    });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("invalid workflow");
  });

  it("run --id on another workflow's run dir reports the resume guard cleanly", async () => {
    // Regression: the guard threw out of run() as an unhandled rejection.
    const root = freshDir();
    seedRun(root, "r-clash"); // records workflow "demo"
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const r = await runWorkflowCommand(["run", file, "--id", "r-clash"], {
      runsRoot: root,
      runHost: () => ({ tasks: new TaskManager({ buildAgent: async () => ({} as never), modelRegistry: {}, config: {}, maxIterations: 1, taskProfile: "default" }) }),
    });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("run r-clash failed");
    expect(r.err.join("\n")).toContain("holds workflow 'demo'");
  });
});

describe("manager tools", () => {
  const toolOpts = (tasks: TaskManager | null, runsRoot: string | null, workflowsDir: string | null = null) => ({
    taskManagerProvider: () => tasks,
    getRunsRoot: () => runsRoot,
    getWorkflowsDir: () => workflowsDir,
    limits: {},
    registry: new RunRegistry(),
  });

  it("all four are managerOnly", () => {
    const o = toolOpts(null, null);
    expect(new WorkflowValidateTool(o).metadata.managerOnly).toBe(true);
    expect(new WorkflowSaveTool(o).metadata.managerOnly).toBe(true);
    expect(new WorkflowDispatchTool(o).metadata.managerOnly).toBe(true);
    expect(new WorkflowStatusTool(o).metadata.managerOnly).toBe(true);
  });

  it("workflow_validate mirrors the CLI validate verbatim", async () => {
    const t = new WorkflowValidateTool(toolOpts(null, null));
    const ok = await t.execute({ yaml: WORKFLOW_TEXT });
    expect(ok.error).toBeNull();
    expect(ok.output).toContain("valid: runnable (2 nodes)");

    const bad = await t.execute({ yaml: "version: 9\nnodes: nope\n" });
    expect(bad.error).not.toBeNull();
    expect(bad.error).toContain("invalid workflow: designed workflow");
    expect(bad.error).toContain("version must be 1");
  });

  it("workflow_validate requires yaml", async () => {
    const t = new WorkflowValidateTool(toolOpts(null, null));
    expect((await t.execute({})).error).not.toBeNull();
  });

  it("workflow_save writes validated graphs, updates in place, refuses clashes", async () => {
    const root = freshDir();
    const wfDir = join(root, "defs");
    const t = new WorkflowSaveTool(toolOpts(null, null, wfDir));

    // Invalid designs never touch the filesystem.
    const bad = await t.execute({ yaml: "version: 9\n" });
    expect(bad.error).toContain("version must be 1");
    expect(existsSync(join(wfDir, "runnable.workflow.yaml"))).toBe(false);

    const saved = await t.execute({ yaml: WORKFLOW_TEXT });
    expect(saved.error).toBeNull();
    const file = join(wfDir, "runnable.workflow.yaml");
    expect(readFileSync(file, "utf8")).toContain("name: runnable");
    expect(saved.output).toContain("saved");

    // Same name updates the same file.
    const updated = await t.execute({ yaml: WORKFLOW_TEXT.replace("cli run smoke", "v2 rubric") });
    expect(updated.output).toContain("updated");
    expect(readFileSync(file, "utf8")).toContain("v2 rubric");

    // A different file claiming the name would shadow in the availability list.
    writeFileSync(join(wfDir, "imposter.yaml"), WORKFLOW_TEXT);
    const clash = await t.execute({ yaml: WORKFLOW_TEXT });
    expect(clash.error).toContain("already defined by");
    expect(clash.error).toContain("imposter.yaml");

    // The scanner sees the saved graph without a restart.
    const listing = await listWorkflows(wfDir);
    expect(listing.some((w) => w.file === file && w.name === "runnable")).toBe(true);
  });

  it("workflow_save without workflows.path fails loud", async () => {
    const r = await new WorkflowSaveTool(toolOpts(null, null)).execute({ yaml: WORKFLOW_TEXT });
    expect(r.error).toContain("workflows.path");
  });

  it("dispatch runs the graph, registers it, and status reports states", async () => {
    const root = freshDir();
    const fake = makeFakeAgents();
    const opts = toolOpts(fake.tasks, root);
    const dispatch = new WorkflowDispatchTool(opts);
    const status = new WorkflowStatusTool(opts);

    const badDesign = await dispatch.execute({ yaml: "version: 42\n" });
    expect(badDesign.error).not.toBeNull();
    expect(badDesign.error).toContain("workflow_validate");

    const ctx = { get: () => ({ sessionId: "mgr-session" }) };
    const r = await dispatch.execute({ yaml: WORKFLOW_TEXT }, ctx as never);
    expect(r.error).toBeNull();
    const m = opts.registry.active()[0]!;
    expect(m.runId).toMatch(/-runnable$/);
    await settle(() => m.finished !== null || m.error !== null, "dispatched run to finish");

    const s1 = await status.execute({});
    expect(s1.output).toBe(`${m.runId}  runnable  succeeded`);
    const s2 = await status.execute({ run_id: m.runId });
    expect(s2.output).toContain("  a: succeeded");
    expect(s2.output).toContain("  b: succeeded");
  });

  it("dispatch without a task manager or runs root fails loud", async () => {
    expect((await new WorkflowDispatchTool(toolOpts(null, "/x")).execute({ yaml: WORKFLOW_TEXT })).error).not.toBeNull();
    expect((await new WorkflowDispatchTool(toolOpts({} as TaskManager, null)).execute({ yaml: WORKFLOW_TEXT })).error).not.toBeNull();
  });

  it("status falls back to the run log for runs owned elsewhere", async () => {
    const root = freshDir();
    seedRun(root, "r-foreign");
    const t = new WorkflowStatusTool(toolOpts(null, root));
    const r = await t.execute({ run_id: "r-foreign" });
    expect(r.error).toBeNull();
    expect(r.output).toContain("owned by another process");
  });

  it("dispatch refuses a run_id already active in-process", async () => {
    const root = freshDir();
    const fake = makeFakeAgents();
    const opts = toolOpts(fake.tasks, root);
    const dispatch = new WorkflowDispatchTool(opts);
    await dispatch.execute({ yaml: WORKFLOW_TEXT, run_id: "fixed-id" });
    const again = await dispatch.execute({ yaml: WORKFLOW_TEXT, run_id: "fixed-id" });
    expect(again.error).not.toBeNull();
    expect(again.error).toContain("already known");
  });

  it("a crashed dispatch still notifies the delegating session", async () => {
    // The dispatch result promises "you will receive a completion message";
    // a run that crashes (here: --id-style resume of a dir recorded for a
    // different workflow) must deliver one too, or the manager waits forever.
    const root = freshDir();
    seedRun(root, "r-clash"); // records workflow "demo"; WORKFLOW_TEXT is "runnable"
    const fake = makeFakeAgents();
    const delivered: Array<{ taskId: string | null; result: string }> = [];
    fake.tasks.deliverTaskCompletion = (taskId, result) => {
      delivered.push({ taskId, result });
    };
    const opts = toolOpts(fake.tasks, root);
    const dispatch = new WorkflowDispatchTool(opts);
    const ctx = { get: () => ({ sessionId: "mgr-session" }) };
    const r = await dispatch.execute({ yaml: WORKFLOW_TEXT, run_id: "r-clash" }, ctx as never);
    expect(r.error).toBeNull(); // dispatched first; the crash surfaces through the notification

    const m = opts.registry.get("r-clash")!;
    await settle(() => m.error !== null, "dispatched run to crash");
    expect(m.error).toContain("holds workflow 'demo'");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.taskId).toBe("r-clash");
    expect(delivered[0]!.result).toContain("crashed");
    expect(delivered[0]!.result).toContain("run dir:");
  });

  it("model-supplied run_id cannot escape the runs root", async () => {
    const root = freshDir();
    const fake = makeFakeAgents();
    const dispatch = new WorkflowDispatchTool(toolOpts(fake.tasks, root));
    for (const bad of ["../evil", "..", "/abs/path", "a/b", "'])"]) {
      const r = await dispatch.execute({ yaml: WORKFLOW_TEXT, run_id: bad });
      expect(r.error).not.toBeNull();
      expect(r.error).toContain("invalid run_id");
    }
    // Nothing was written outside (or inside) the runs root.
    expect(() => statSync(join(root, "..", "evil"))).toThrow();
  });

  it("status refuses an escaping run_id before touching disk", async () => {
    const t = new WorkflowStatusTool(toolOpts(null, freshDir()));
    const r = await t.execute({ run_id: "../../etc/passwd" });
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("invalid run_id");
  });
});

// ---------------------------------------------------------------------------
// extension wiring: availability listing + slash commands
// ---------------------------------------------------------------------------

function stubCore(workflowsPath: string, tasks: TaskManager | null) {
  const services = new Map<string, unknown>();
  if (tasks) services.set("taskManager", tasks);
  return {
    config: { workflows: { path: workflowsPath } },
    services: {
      has: (n: string) => services.has(n),
      get: (n: string) => services.get(n),
    },
  } as never;
}

function stubPort(): EngineTaskPort {
  return {
    spawnTask: async () => {
      throw new Error("not spawned");
    },
    taskTurn: async () => {
      throw new Error("no turn");
    },
    completeTask: () => false,
    interruptTask: () => true,
    sendFollowUp: () => false,
  };
}

describe("extension surfaces", () => {
  it("availability lists valid workflows to managers only", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "one.workflow.yaml"), WORKFLOW_TEXT);
    writeFileSync(join(dir, "broken.workflow.yaml"), "version: 1\nname: broken!\n");
    const ext = await create(stubCore(dir, null));

    const hook = ext.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const forManager = (await hook({ agent: { managerProfile: true } } as never)) as
      | { content?: string }
      | undefined;
    expect(String(forManager?.content)).toContain("runnable: cli run smoke");
    expect(String(forManager?.content)).not.toContain("broken");
    const forWorker = await hook({ agent: { managerProfile: false } } as never);
    expect(forWorker).toBeUndefined();

    const listed = await listWorkflows(dir);
    expect(listed.map((w) => w.name)).toEqual(["runnable"]);
  });

  it("availability is live: files added/edited/removed after load change the preamble", async () => {
    const dir = freshDir();
    const ext = await create(stubCore(dir, null));
    const hook = ext.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const managerHook = () =>
      hook({ agent: { managerProfile: true } } as never) as Promise<
        { content?: string } | undefined
      >;

    expect((await managerHook())?.content ?? "").toBe("");

    writeFileSync(
      join(dir, "late.workflow.yaml"),
      WORKFLOW_TEXT.replace("runnable", "latename").replace("cli run smoke", "first description"),
    );
    expect(String((await managerHook())?.content)).toContain("latename: first description");

    // In-place edit: description grows a byte, defeating the mtime+size gate.
    writeFileSync(
      join(dir, "late.workflow.yaml"),
      WORKFLOW_TEXT.replace("runnable", "latename").replace("cli run smoke", "second description"),
    );
    expect(String((await managerHook())?.content)).toContain("second description");

    rmSync(join(dir, "late.workflow.yaml"));
    expect((await managerHook())?.content ?? "").toBe("");
  });

  it("createWorkflowScanner: stat-gated cache re-parses only new/changed files", async () => {
    const dir = freshDir();
    const scan = createWorkflowScanner(dir);
    expect(await scan()).toEqual([]);

    writeFileSync(join(dir, "w.workflow.yaml"), WORKFLOW_TEXT);
    const first = await scan();
    expect(first.map((w) => w.name)).toEqual(["runnable"]);
    expect(await scan()).toEqual(first); // unchanged file: cache hit

    // An invalid file stays cached-as-invalid (no re-parse, no repeat warn)
    // until it changes; fixing it then surfaces it.
    writeFileSync(join(dir, "bad.workflow.yaml"), "nope");
    expect(await scan()).toHaveLength(1);
    writeFileSync(
      join(dir, "bad.workflow.yaml"),
      WORKFLOW_TEXT.replace("runnable", "fixed").replace("cli run smoke", "now valid"),
    );
    expect((await scan()).map((w) => w.name).sort()).toEqual(["fixed", "runnable"]);
  });

  it("no workflows dir means no preamble", async () => {
    const ext = await create(stubCore(join(freshDir(), "absent"), null));
    const hook = ext.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    expect(await hook({ agent: { managerProfile: true } } as never)).toBeUndefined();
  });

  it("registers workflow tools + slash commands", async () => {
    const ext = await create(stubCore(freshDir(), null));
    const tools: string[] = [];
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({ register: (n: string) => tools.push(n) } as never);
    expect(tools).toEqual([
      "workflow_validate",
      "workflow_save",
      "workflow_dispatch",
      "workflow_status",
    ]);

    const cmds = new Map<string, { matches: (c: string) => boolean; handler: Function }>();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds.set(n, d as never) },
    } as never);
    expect([...cmds.keys()]).toEqual(["workflow", "followup"]);
    expect(cmds.get("workflow")!.matches("workflow cancel x")).toBe(true);
    expect(cmds.get("workflow")!.matches("workflowtools")).toBe(false);
    expect(cmds.get("followup")!.matches("followup build fix it")).toBe(true);
  });

  it("/workflow lists, details, and cancels in-process runs", async () => {
    const ext = await create(stubCore(freshDir(), null));
    const runs = (ext.runs as RunRegistry);
    const workflow = parseWorkflow(WORKFLOW_TEXT).workflow!;
    const run = new WorkflowRun({ workflow, runId: "rr1", runDir: "/tmp/unused-rr1", tasks: stubPort() });
    runs.add({ runId: "rr1", workflow: "runnable", runDir: "/tmp/unused-rr1", startedAt: 0, run, finished: null, error: null });

    const cmds = new Map<string, { handler: (a: never, v: string | null) => Promise<{ content?: string; error?: string }> }>();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds.set(n, d as never) },
    } as never);
    const wfCmd = cmds.get("workflow")!.handler;

    const list = await wfCmd({} as never, "workflow");
    expect(list.content).toContain("rr1");
    expect(list.content).toContain("active");

    const detail = await wfCmd({} as never, "workflow rr1");
    expect(detail.content).toContain("  a: pending");

    const cancel = await wfCmd({} as never, "workflow cancel rr1");
    expect(cancel.content).toContain("Cancel requested");

    const unknown = await wfCmd({} as never, "workflow nope");
    expect(unknown.error).toContain("Unknown run");

    const empty = await create(stubCore(freshDir(), null));
    const cmds2 = new Map<string, { handler: (a: never, v: string | null) => Promise<{ content?: string }> }>();
    await empty.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds2.set(n, d as never) },
    } as never);
    expect((await cmds2.get("workflow")!.handler({} as never, "workflow")).content).toContain("No workflow runs");
  });

  it("/followup routes to WorkflowRun.steer with run disambiguation", async () => {
    const ext = await create(stubCore(freshDir(), null));
    const cmds = new Map<string, { handler: (a: never, v: string | null) => Promise<{ content?: string; error?: string }> }>();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds.set(n, d as never) },
    } as never);
    const follow = cmds.get("followup")!.handler;

    // Nothing running yet.
    expect((await follow({} as never, "followup a keep going")).error).toContain("No active");

    const workflow = parseWorkflow(WORKFLOW_TEXT).workflow!;
    let steered: Array<[string, string]> = [];
    const run = new WorkflowRun({ workflow, runId: "rr1", runDir: "/tmp/unused-rr1", tasks: stubPort() });
    run.steer = (nodeId: string, message: string) => {
      steered.push([nodeId, message]);
      return nodeId === "a";
    };
    (ext.runs as RunRegistry).add({ runId: "rr1", workflow: "runnable", runDir: "/tmp", startedAt: 0, run, finished: null, error: null });

    const sent = await follow({} as never, "followup a use bun please");
    expect(sent.content).toContain("Steering sent");
    expect(steered).toEqual([["a", "use bun please"]]);

    // Non-accepted steer -> not-mid-turn error, with message preserved verbatim.
    const miss = await follow({} as never, "followup b hello there");
    expect(miss.error).toContain("not mid-turn");

    // Missing message -> usage.
    expect((await follow({} as never, "followup a")).error).toContain("Usage");

    // Explicit run-id form.
    steered = [];
    const explicit = await follow({} as never, "followup rr1 a go on");
    expect(explicit.content).toContain("Steering sent");
    expect(steered).toEqual([["a", "go on"]]);
  });
});

// ---------------------------------------------------------------------------
// run-dir ownership (no double-driving a run dir)
// ---------------------------------------------------------------------------

function seedOwner(runDir: string, owner: { pid: number; host: string }): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, ".owner"),
    JSON.stringify({ claimedAt: "2026-01-01T00:00:00.000Z", ...owner }),
  );
}

describe("run-dir ownership", () => {
  it("claimRunDir: fresh claim, own-pid re-entry, live refusal, stale reclaim, foreign-host reclaim", async () => {
    const dir = join(freshDir(), "r1");
    mkdirSync(dir);

    expect((await claimRunDir(dir, { pid: 111, host: "h" })).ok).toBe(true);
    // Re-entry by the same pid passes (a dispatch pre-claim is followed by run()'s claim).
    expect((await claimRunDir(dir, { pid: 111, host: "h" })).ok).toBe(true);

    // Same-host claim by another live pid is refused, with the owner reported.
    const bad = await claimRunDir(dir, { pid: 222, host: "h", pidAlive: () => true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.owner.pid).toBe(111);

    // Same-host stale claim (dead pid) is reclaimed.
    expect((await claimRunDir(dir, { pid: 333, host: "h", pidAlive: () => false })).ok).toBe(true);
    expect(readFileSync(join(dir, ".owner"), "utf8")).toContain('"pid":333');

    // Foreign-host claim: liveness cannot be checked from here; reclaimed (v1 stance).
    seedOwner(dir, { pid: 42, host: "elsewhere" });
    expect((await claimRunDir(dir, { pid: 333, host: "h", pidAlive: () => true })).ok).toBe(true);
  });

  // Loop regression for the writeFile-wx window: a claimer that read a mid-create
  // empty `.owner` judged the rival corrupt, discarded its claim and took over --
  // two owners on one run dir. Creation is now atomic (tmp + link), and 50 rounds
  // sample the window that the single-shot form missed.
  it("claimRunDir: concurrent claims on a free dir elect exactly one owner", async () => {
    for (let round = 0; round < 50; round++) {
      const dir = join(freshDir(), `race-free-${round}`);
      mkdirSync(dir);
      const results = await Promise.all([
        claimRunDir(dir, { pid: 111, host: "h", pidAlive: () => true }),
        claimRunDir(dir, { pid: 222, host: "h", pidAlive: () => true }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const disk = JSON.parse(readFileSync(join(dir, ".owner"), "utf8")) as { pid: number };
      expect([111, 222]).toContain(disk.pid);
      const loser = results.find((r) => !r.ok);
      expect(loser && !loser.ok ? loser.owner.pid : null).toBe(disk.pid);
    }
  });

  it("claimRunDir: concurrent reclaim of a stale claim elects exactly one owner", async () => {
    const dir = join(freshDir(), "race-stale");
    mkdirSync(dir);
    seedOwner(dir, { pid: 999, host: "h" });
    const alive = (p: number) => p !== 999; // the seeded claimer is dead; rivals are live
    const results = await Promise.all([
      claimRunDir(dir, { pid: 111, host: "h", pidAlive: alive }),
      claimRunDir(dir, { pid: 222, host: "h", pidAlive: alive }),
      claimRunDir(dir, { pid: 333, host: "h", pidAlive: alive }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const disk = JSON.parse(readFileSync(join(dir, ".owner"), "utf8")) as { pid: number };
    expect([111, 222, 333]).toContain(disk.pid);
    for (const loser of results.filter((r) => !r.ok)) {
      if (!loser.ok) expect(loser.owner.pid).toBe(disk.pid);
    }
    // The elected owner's claim is re-entrant for it.
    expect((await claimRunDir(dir, { pid: disk.pid, host: "h", pidAlive: alive })).ok).toBe(true);
  });

  it("claimRunDir: a corrupt marker is discarded, never honored or truncated into ownership", async () => {
    const dir = join(freshDir(), "race-corrupt");
    mkdirSync(dir);
    writeFileSync(join(dir, ".owner"), "{ not json !!");
    expect((await claimRunDir(dir, { pid: 111, host: "h" })).ok).toBe(true);
    expect(readFileSync(join(dir, ".owner"), "utf8")).toContain('"pid":111');
    // And a live claim now refuses.
    const bad = await claimRunDir(dir, { pid: 222, host: "h", pidAlive: () => true });
    expect(bad.ok).toBe(false);
  });

  it("WorkflowRun.run refuses to drive a run dir claimed by a live process", async () => {
    const runDir = join(freshDir(), "r1");
    seedOwner(runDir, { pid: 4242, host: hostname() });
    const run = new WorkflowRun({
      workflow: parseWorkflow(WORKFLOW_TEXT).workflow!,
      runId: "r1",
      runDir,
      tasks: {} as EngineTaskPort, // never reached: the claim refuses first
      claimOptions: { pid: 111, host: hostname(), pidAlive: () => true },
    });
    await expect(run.run()).rejects.toThrow(/owned by live process 4242/);
  });

  it("a completed foreground run releases the .owner marker", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const r = await runWorkflowCommand(["run", file], {
      runsRoot: root,
      runHost: () => ({ tasks: makeFakeAgents().tasks }),
    });
    expect(r.code).toBe(0);
    const runId = r.out[0]!.slice(4, r.out[0]!.indexOf(":"));
    expect(() => statSync(join(root, runId, ".owner"))).toThrow();
  });

  it("a throwing resume still releases the .owner claim (no park under a live pid)", async () => {
    const runDir = join(freshDir(), "r1");
    mkdirSync(runDir, { recursive: true });
    // run.jsonl for a DIFFERENT workflow: run()'s resume guard throws after
    // the claim was taken. A long-lived session process must not leave the
    // dir claimed by its still-live pid.
    writeFileSync(
      join(runDir, "run.jsonl"),
      JSON.stringify({ ev: "started", runId: "r1", workflow: "other-wf", nodes: ["a", "b"], startedAt: 1 }) + "\n",
    );
    const run = new WorkflowRun({
      workflow: parseWorkflow(WORKFLOW_TEXT).workflow!,
      runId: "r1",
      runDir,
      tasks: {} as EngineTaskPort, // never reached: the resume guard throws first
      claimOptions: { pid: 111, host: hostname(), pidAlive: () => true },
    });
    await expect(run.run()).rejects.toThrow(/holds workflow 'other-wf'/);
    expect(() => statSync(join(runDir, ".owner"))).toThrow();
    // Another live process can claim the dir again immediately.
    expect(
      (await claimRunDir(runDir, { pid: 222, host: hostname(), pidAlive: () => true })).ok,
    ).toBe(true);
  });

  it("workflow_dispatch with a resume run_id refuses a dir owned by a live foreign process", async () => {
    const root = freshDir();
    // Real liveness check against the init pid: alive on any Linux host, so
    // the claim must be refused without any seam.
    seedOwner(join(root, "resume-me"), { pid: 1, host: hostname() });
    const opts = {
      taskManagerProvider: () => makeFakeAgents().tasks,
      getRunsRoot: () => root,
      getWorkflowsDir: () => null,
      limits: {},
      registry: new RunRegistry(),
    };
    const res = await new WorkflowDispatchTool(opts).execute({
      yaml: WORKFLOW_TEXT,
      run_id: "resume-me",
    });
    expect(res.error).toContain("owned by live process 1");
  });

  it("cancel names the owner of a foreign unfinished run", async () => {
    const root = freshDir();
    seedRun(root, "r1");
    seedOwner(join(root, "r1"), { pid: 4242, host: "somewhere" });
    const r = await runWorkflowCommand(["cancel", "r1"], { runsRoot: root });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("Owner: pid 4242 on 'somewhere'");
  });
});

// ---------------------------------------------------------------------------
// extension-internal seams: taskManagerProvider, runHost, CLI subcommand
// ---------------------------------------------------------------------------

describe("extension wiring: provider, runHost, CLI subcommand", () => {
  function stubCore2(workflowsPath: string, opts: { resolved?: boolean } = {}) {
    const core: Record<string, unknown> = {
      config: { workflows: { path: workflowsPath } },
      services: { has: () => false, get: () => undefined },
      createLlmClient: () => ({}),
    };
    if (opts.resolved !== false) {
      core.resolved = {
        modelRegistry: {},
        maxIterations: 3,
        taskProfile: "task-default",
      };
    }
    return core as never;
  }

  type Handler = (cli: { args?: string[] }) => Promise<number>;
  async function cliHandler(ext: Awaited<ReturnType<typeof create>>): Promise<Handler> {
    let handler: Handler | null = null;
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({
      register: (_n: string, def: { handler: Handler }) => {
        handler = def.handler;
      },
    } as never);
    return handler!;
  }

  async function withQuietConsole(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
    const origLog = console.log;
    const origErr = console.error;
    const out: string[] = [];
    const err: string[] = [];
    console.log = ((l?: unknown) => out.push(String(l))) as never;
    console.error = ((l?: unknown) => err.push(String(l))) as never;
    try {
      return { code: await fn(), out, err };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  it("CLI subcommand runs through runHost; the resume guard fails it without building agents", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    // The extension roots runs under <workflows.path>/runs.
    seedRun(join(root, "runs"), "r-clash"); // records workflow "demo"

    const ext = await create(stubCore2(root));
    const handler = await cliHandler(ext);
    const r1 = await withQuietConsole(() => handler({ args: ["run", file, "--id", "r-clash"] }));
    expect(r1.code).toBe(1);
    expect(r1.err.join("\n")).toContain("holds workflow 'demo'");

    // Second call hits runHost's cached-host branch.
    const r2 = await withQuietConsole(() => handler({ args: ["run", file, "--id", "r-clash"] }));
    expect(r2.code).toBe(1);
  });

  it("runHost without a resolved config reports the session-capable error", async () => {
    const root = freshDir();
    const file = join(root, "wf.yaml");
    writeFileSync(file, WORKFLOW_TEXT);
    const ext = await create(stubCore2(root, { resolved: false }));
    const handler = await cliHandler(ext);
    const r = await withQuietConsole(() => handler({ args: ["run", file] }));
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("session-capable");
  });

  it("extension tools resolve the TaskManager through the taskManager service", async () => {
    // No service registered: provider returns null, dispatch fails loud.
    const bare = await create(stubCore(freshDir(), null));
    const tools1 = new Map<string, { execute: (a: never, c?: never) => Promise<{ error: string | null }> }>();
    await bare.hooks![HOOKS.TOOLS_REGISTER]!({
      register: (n: string, t: never) => tools1.set(n, t as never),
    } as never);
    expect((await tools1.get("workflow_dispatch")!.execute({ yaml: WORKFLOW_TEXT } as never)).error).not.toBeNull();

    // Service registered: provider hands the tool the TaskManager verbatim.
    const root = freshDir();
    const fake = makeFakeAgents();
    const ext = await create(stubCore(root, fake.tasks));
    const tools2 = new Map<string, { execute: (a: never, c?: never) => Promise<{ error: string | null }> }>();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({
      register: (n: string, t: never) => tools2.set(n, t as never),
    } as never);
    const r = await tools2.get("workflow_dispatch")!.execute({ yaml: WORKFLOW_TEXT } as never);
    expect(r.error).toBeNull();
    const m = (ext.runs as RunRegistry).active()[0]!;
    await settle(() => m.finished !== null || m.error !== null, "service-backed dispatch to finish");
    expect(m.finished!.outcome).toBe("succeeded");
  });

  it("/workflow cancel explains unknown, finished, and crashed runs", async () => {
    const ext = await create(stubCore(freshDir(), null));
    const cmds = new Map<string, { handler: (a: never, v: string | null) => Promise<{ content?: string; error?: string }> }>();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds.set(n, d as never) },
    } as never);
    const wfCmd = cmds.get("workflow")!.handler;

    // Unknown id on an empty registry: the "(none)" ownership hint.
    const unknown = await wfCmd({} as never, "workflow cancel nope");
    expect(unknown.error).toContain("Unknown run 'nope'");
    expect(unknown.error).toContain("(none)");

    // Unknown id with a run owned here: the id shows up in the ownership list.
    const workflow = parseWorkflow(WORKFLOW_TEXT).workflow!;
    const run = new WorkflowRun({ workflow, runId: "rr1", runDir: "/tmp/unused-rr2", tasks: stubPort() });
    (ext.runs as RunRegistry).add({ runId: "rr1", workflow: "runnable", runDir: "/tmp/unused-rr2", startedAt: 0, run, finished: null, error: null });
    const unknown2 = await wfCmd({} as never, "workflow cancel nope");
    expect(unknown2.error).toContain("rr1");

    // Finished and crashed runs are idempotent no-ops.
    const done = new WorkflowRun({ workflow, runId: "done1", runDir: "/tmp/unused-rr3", tasks: stubPort() });
    (ext.runs as RunRegistry).add({ runId: "done1", workflow: "runnable", runDir: "/tmp/unused-rr3", startedAt: 0, run: done, finished: { outcome: "succeeded", states: {} } as never, error: null });
    expect((await wfCmd({} as never, "workflow cancel done1")).content).toContain("already succeeded");

    const crashed = new WorkflowRun({ workflow, runId: "bad1", runDir: "/tmp/unused-rr4", tasks: stubPort() });
    (ext.runs as RunRegistry).add({ runId: "bad1", workflow: "runnable", runDir: "/tmp/unused-rr4", startedAt: 0, run: crashed, finished: null, error: "boom" });
    expect((await wfCmd({} as never, "workflow cancel bad1")).content).toContain("already crashed");
  });

  it("/followup refuses to guess between multiple active runs", async () => {
    const ext = await create(stubCore(freshDir(), null));
    const cmds = new Map<string, { handler: (a: never, v: string | null) => Promise<{ content?: string; error?: string }> }>();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (n: string, d: never) => cmds.set(n, d as never) },
    } as never);
    const follow = cmds.get("followup")!.handler;

    const workflow = parseWorkflow(WORKFLOW_TEXT).workflow!;
    for (const id of ["ra", "rb"]) {
      const run = new WorkflowRun({ workflow, runId: id, runDir: `/tmp/unused-${id}`, tasks: stubPort() });
      (ext.runs as RunRegistry).add({ runId: id, workflow: "runnable", runDir: "/tmp", startedAt: 0, run, finished: null, error: null });
    }
    const r = await follow({} as never, "followup a keep going");
    expect(r.error).toContain("Multiple active runs");
    expect(r.error).toContain("ra");
    expect(r.error).toContain("rb");

    // An explicit run id still steers despite the ambiguity.
    let steered: string | null = null;
    (ext.runs as RunRegistry).get("rb")!.run.steer = ((nodeId: string, message: string) => {
      steered = `${nodeId}:${message}`;
      return true;
    }) as never;
    const ok = await follow({} as never, "followup rb a go on");
    expect(ok.content).toContain("Steering sent");
    expect(steered as string | null).toBe("a:go on");
  });
});
