// workflow_followup / workflow_control (skip | resume | cancel) manager tools
// and the "skipped" status vocabulary end to end. No fleet access: scripted
// fake workers on a real TaskManager, tmp-dir fixtures only (tests never
// touch the real runs root).

import { describe, it, expect, afterAll } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText } from "@core/context/message.ts";
import { LlmError } from "@core/error.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { runWorkflowCommand } from "@extensions/workflows/workflow-cli.ts";
import {
  readRunSummary,
  scanInterruptedRuns,
} from "@extensions/workflows/run-store.ts";
import {
  RunRegistry,
  WorkflowControlTool,
  WorkflowDispatchTool,
  WorkflowFollowupTool,
  WorkflowStatusTool,
  WORKFLOW_TOOL_CONSTRUCTORS,
  type WorkflowToolOptions,
} from "@extensions/workflows/workflow-tools.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-ctl-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const DEAD_PID = 999999; // spec-blessed dead pid

async function settle(fn: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function journalLine(rec: Record<string, unknown>): string {
  return `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`;
}

function readLog(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// fake TaskManager: scripted workers keyed by the node id in the engine prompt
// ---------------------------------------------------------------------------

interface WorkerCtx {
  id: string;
  dir: string;
  attempt: number;
  onAbort: (cb: () => void) => void;
}
type WorkerSpec = (ctx: WorkerCtx) => Promise<unknown> | unknown;

function makeFake(spec: Record<string, WorkerSpec> = {}) {
  const turns: Record<string, number> = {};
  const steered: string[] = [];
  let builds = 0;
  const manager = new TaskManager({
    profileManager: { getProfile: () => null } as never,
    buildAgent: async () => {
      builds++;
      const agent: Record<string, unknown> = {
        run: async (input: string | Array<Record<string, unknown>>) => {
          const prompt = contentToText(input);
          const id = /node '([a-z0-9][a-z0-9-]*)'/.exec(prompt)?.[1] ?? "unknown";
          const dir = /\.verdict under (.+): first line/.exec(prompt)?.[1] ?? "";
          const attempt = (turns[id] = (turns[id] ?? 0) + 1);
          const aborters: Array<() => void> = [];
          (agent.abortSignal as AbortSignal | undefined)?.addEventListener("abort", () => {
            for (const cb of aborters) cb();
          });
          const fn = spec[id];
          if (!fn) {
            if (dir) writeFileSync(join(dir, `${id}.verdict`), "pass");
            return { type: "completion", content: `${id} pointer-summary` };
          }
          const out = await fn({ id, dir, attempt, onAbort: (cb) => aborters.push(cb) });
          if (out !== undefined) return out;
          return { type: "completion", content: `${id} pointer-summary` };
        },
        notifyCompletion: () => {},
        steer: (m: string) => {
          steered.push(m);
        },
      };
      return agent as never;
    },
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
  });
  return { manager, turns, steered, builds: () => builds };
}

/** Worker that writes its declared output + pass verdict and finishes. */
const good: WorkerSpec = ({ dir, id }) => {
  writeFileSync(join(dir, `${id}.out`), "artifact");
  writeFileSync(join(dir, `${id}.verdict`), "pass");
};

/** Worker that hangs until the task's abort signal fires. */
const hang: WorkerSpec = ({ onAbort }) =>
  new Promise((_resolve, reject) => {
    onAbort(() => reject(LlmError.Cancelled("aborted")));
  });

/** Workflow dir holding one graph file; returns [dir, writeHelper]. */
function wfDirWith(name: string, yaml: string): string {
  const dir = join(freshDir(), "defs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.workflow.yaml`), yaml);
  return dir;
}

function toolOpts(
  tasks: TaskManager | null,
  runsRoot: string | null,
  wfDir: string | null,
  registry = new RunRegistry(),
): WorkflowToolOptions & { registry: RunRegistry } {
  return {
    taskManagerProvider: () => tasks,
    getRunsRoot: () => runsRoot,
    getWorkflowsDir: () => wfDir,
    limits: {},
    registry,
  };
}

// ---------------------------------------------------------------------------
// seeded run dirs
// ---------------------------------------------------------------------------

interface SeedOpts {
  /** Per-node last journal state; no entry = never-started node. */
  states?: Record<string, string>;
  /** Node ids with a filesystem-verified succeeded claim. */
  claims?: string[];
  owner?: "dead" | "live" | "none";
  finished?: string;
}

function seedRun(runsRoot: string, runId: string, workflow: string, nodes: string[], opts: SeedOpts = {}): string {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  let text = journalLine({ ev: "started", runId, workflow, nodes, startedAt: Date.now() - 60_000 });
  for (const id of nodes) {
    const state = opts.states?.[id];
    if (!state) continue;
    text += journalLine({ ev: "node", id, state: "queued", attempt: 1 });
    if (state === "succeeded" && opts.claims?.includes(id)) {
      writeFileSync(join(dir, `${id}.out`), "alpha");
      writeFileSync(join(dir, `${id}.verdict`), "pass");
      const st = statSync(join(dir, `${id}.out`));
      text += journalLine({
        ev: "node",
        id,
        state: "succeeded",
        attempt: 1,
        verdict: "pass",
        summary: `${id} done`,
        deps: [],
        files: { [`${id}.out`]: { size: st.size, mtimeMs: st.mtimeMs } },
      });
    } else if (state !== "pending") {
      text += journalLine({ ev: "node", id, state, attempt: 1 });
    }
  }
  if (opts.finished) text += journalLine({ ev: "finished", outcome: opts.finished });
  writeFileSync(join(dir, "run.jsonl"), text);
  if (opts.owner === "dead") {
    writeFileSync(join(dir, ".owner"), `${JSON.stringify({ pid: DEAD_PID, host: hostname(), claimedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  } else if (opts.owner === "live") {
    // A live claim that is NOT ours: same-host alive pid with no registry entry
    // (the cross-process fixture; our own pid is simply "some live pid").
    writeFileSync(join(dir, ".owner"), `${JSON.stringify({ pid: process.pid, host: hostname(), claimedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// tool surface pins
// ---------------------------------------------------------------------------

describe("manager tool surface", () => {
  it("five constructors, all registered; new tools are managerOnly", () => {
    expect(Object.keys(WORKFLOW_TOOL_CONSTRUCTORS)).toEqual([
      "workflow_validate",
      "workflow_dispatch",
      "workflow_status",
      "workflow_followup",
      "workflow_control",
    ]);
    const o = toolOpts(null, null, null);
    expect(new WorkflowFollowupTool(o).metadata.managerOnly).toBe(true);
    expect(new WorkflowControlTool(o).metadata.managerOnly).toBe(true);
  });

  it("descriptions state the ceilings", () => {
    const o = toolOpts(null, null, null);
    const fu = new WorkflowFollowupTool(o).toToolDef().function.description;
    expect(fu).toContain("DO NOT USE for polling");
    expect(fu).toContain("running");
    const ctl = new WorkflowControlTool(o).toToolDef().function.description;
    expect(ctl).toContain("THIS process");
    expect(ctl).toContain("/workflow cancel");
    expect(ctl).toContain("skipped");
    expect(ctl).toContain("settles BOTH the producer and that judge cancelled");
    const st = new WorkflowStatusTool(o).toToolDef().function.description;
    expect(st).toContain("skipped");
    expect(st).toContain("cancelled");
  });

  it("input validation: run_id shape, action enum, required fields", async () => {
    const o = toolOpts(null, freshDir(), null);
    const ctl = new WorkflowControlTool(o);
    expect((await ctl.execute({})).error).toContain("run_id is required");
    expect((await ctl.execute({ run_id: "../escape", action: "skip" })).error).toContain("invalid run_id");
    expect((await ctl.execute({ run_id: "r1", action: "frobnicate" })).error).toContain("skip | resume | cancel");
    expect((await ctl.execute({ run_id: "r1", action: "skip" })).error).toContain("not found");
    const fu = new WorkflowFollowupTool(o);
    expect((await fu.execute({ run_id: "r1", node: "a" })).error).toContain("message is required");
    expect((await fu.execute({ run_id: "../x", node: "a", message: "m" })).error).toContain("invalid run_id");
  });
});

// ---------------------------------------------------------------------------
// workflow_followup
// ---------------------------------------------------------------------------

describe("workflow_followup", () => {
  const GRAPH = `
version: 1
name: flow
description: followup fixture
nodes:
  - id: a
  - id: b
    dependsOn: [a]
`;

  it("reaches a running node through the /followup seam; refuses everything else", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith("flow", GRAPH);
    let release!: () => void;
    const fake = makeFake({
      a: ({ dir }) =>
        new Promise((resolve) => {
          release = () => {
            writeFileSync(join(dir, "a.verdict"), "pass");
            resolve(undefined);
          };
        }),
    });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    const dispatched = await new WorkflowDispatchTool(opts).execute({ file: "flow", run_id: "frun" });
    expect(dispatched.error).toBeNull();
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "node a started");

    const fu = new WorkflowFollowupTool(opts);
    // Unknown run.
    expect((await fu.execute({ run_id: "nope", node: "a", message: "x" })).error).toContain("not found");
    // Unknown node -> states enumerated.
    const unknownNode = await fu.execute({ run_id: "frun", node: "zz", message: "x" });
    expect(unknownNode.error).toContain("a=running");
    expect(unknownNode.error).toContain("b=pending");
    // Not running -> actual state reported.
    expect((await fu.execute({ run_id: "frun", node: "b", message: "x" })).error).toContain("is pending");
    // Running node -> real steer through TaskManager.sendFollowUp -> agent.steer.
    const ok = await fu.execute({ run_id: "frun", node: "a", message: "use bun please" });
    expect(ok.error).toBeNull();
    expect(fake.steered).toEqual(["use bun please"]);

    release();
    await settle(() => !!opts.registry.get("frun")?.finished, "run settled");
    // Terminal run -> refusal with the outcome.
    expect((await fu.execute({ run_id: "frun", node: "a", message: "x" })).error).toContain("already succeeded");
  });
});

// ---------------------------------------------------------------------------
// workflow_control: skip
// ---------------------------------------------------------------------------

describe("workflow_control skip", () => {
  it("retires an ownerless interrupted run with one appended terminal line", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const runDir = seedRun(runsRoot, "sk-run", "retire", ["a", "b", "c"], {
      states: { a: "succeeded", b: "running" },
      claims: ["a"],
      owner: "dead",
    });
    const before = readFileSync(join(runDir, "run.jsonl"), "utf8");
    const opts = toolOpts(null, runsRoot, null);

    const res = await new WorkflowControlTool(opts).execute({ run_id: "sk-run", action: "skip" });
    expect(res.error).toBeNull();
    expect(res.output).toContain("skipped");

    // Exactly one appended line; the file itself is never rewritten.
    const after = readFileSync(join(runDir, "run.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    const appended = after.slice(before.length);
    expect(appended.endsWith("\n")).toBe(true);
    expect(appended.trimEnd().split("\n")).toHaveLength(1);
    const ev = JSON.parse(appended) as Record<string, Record<string, string> | string>;
    expect(ev.ev).toBe("finished");
    expect(ev.outcome).toBe("skipped");
    // Last-known states mirrored: succeeded stands, running -> skipped,
    // never-started -> blocked.
    expect(ev.states).toEqual({ a: "succeeded", b: "skipped", c: "blocked" });

    // No longer resumable anywhere: the interruption scan and workflow_status
    // drop it; the status surfaces show skipped.
    expect((await scanInterruptedRuns(runsRoot)).map((r) => r.runId)).not.toContain("sk-run");
    const status = await new WorkflowStatusTool(opts).execute({ run_id: "sk-run" });
    expect(status.output).toContain("skipped");
    expect(status.output).toContain("b: skipped");
    expect(status.output).not.toContain("resumable");
    const list = await runWorkflowCommand(["list"], { runsRoot });
    expect(list.out.join("\n")).toContain("sk-run  retire  skipped");
    expect(list.out.join("\n")).not.toContain("resumable");
    const st = await runWorkflowCommand(["status", "sk-run"], { runsRoot });
    expect(st.out[0]).toContain("skipped");
  });

  it("failed nodes stay failed through skip", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    seedRun(runsRoot, "sk2", "retire", ["a", "b"], { states: { a: "failed", b: "judging" }, owner: "dead" });
    const opts = toolOpts(null, runsRoot, null);
    expect((await new WorkflowControlTool(opts).execute({ run_id: "sk2", action: "skip" })).error).toBeNull();
    const s = await readRunSummary(join(runsRoot, "sk2"));
    expect(s?.outcome).toBe("skipped");
    expect(s?.nodes).toEqual([
      { id: "a", state: "failed" },
      { id: "b", state: "skipped" },
    ]);
  });

  it("refuses live-owned, already-terminal, and unknown runs; journal untouched", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const liveDir = seedRun(runsRoot, "sk-live", "retire", ["a"], { states: { a: "running" }, owner: "live" });
    const finDir = seedRun(runsRoot, "sk-fin", "retire", ["a"], { states: { a: "failed" }, finished: "failed" });
    const liveBefore = readFileSync(join(liveDir, "run.jsonl"), "utf8");
    const finBefore = readFileSync(join(finDir, "run.jsonl"), "utf8");
    const ctl = new WorkflowControlTool(toolOpts(null, runsRoot, null));

    const live = await ctl.execute({ run_id: "sk-live", action: "skip" });
    expect(live.error).toContain("live owner");
    expect(live.error).toContain("cancel");
    expect(readFileSync(join(liveDir, "run.jsonl"), "utf8")).toBe(liveBefore);

    const fin = await ctl.execute({ run_id: "sk-fin", action: "skip" });
    expect(fin.error).toContain("already failed");
    expect(readFileSync(join(finDir, "run.jsonl"), "utf8")).toBe(finBefore);

    expect((await ctl.execute({ run_id: "ghost", action: "skip" })).error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// workflow_control: resume == direct workflow_dispatch(run_id)
// ---------------------------------------------------------------------------

describe("workflow_control resume", () => {
  const GRAPH = `
version: 1
name: runnable
description: resume fixture
nodes:
  - id: a
    accept:
      files: [a.out]
  - id: b
    dependsOn: [a]
`;

  it("wraps the dispatch run_id path: identical reuse decisions", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith("runnable", GRAPH);

    for (const id of ["r-ctl", "r-dir"]) seedRun(runsRoot, id, "runnable", ["a", "b"], { states: { a: "succeeded", b: "running" }, claims: ["a"] });

    const fakeCtl = makeFake({ b: good });
    const optsCtl = toolOpts(fakeCtl.manager, runsRoot, wfDir);
    const ctl = await new WorkflowControlTool(optsCtl).execute({ run_id: "r-ctl", action: "resume" });
    expect(ctl.error).toBeNull();
    expect(ctl.output).toContain("run r-ctl dispatched");

    const fakeDir = makeFake({ b: good });
    const optsDir = toolOpts(fakeDir.manager, runsRoot, wfDir);
    const direct = await new WorkflowDispatchTool(optsDir).execute({ file: "runnable", run_id: "r-dir" });
    expect(direct.error).toBeNull();

    await settle(() => !!optsCtl.registry.get("r-ctl")?.finished, "r-ctl finished");
    await settle(() => !!optsDir.registry.get("r-dir")?.finished, "r-dir finished");

    // Same reuse decisions on both paths: a's claim valid and reused (its
    // worker never ran), b incomplete and executed, same outcome.
    const evOf = (id: string, evName: string) =>
      readLog(join(runsRoot, id)).find((e) => e.ev === evName) as Record<string, unknown>;
    for (const [id, opts, fake] of [["r-ctl", optsCtl, fakeCtl], ["r-dir", optsDir, fakeDir]] as const) {
      const resumed = evOf(id, "resumed");
      expect(resumed.valid).toEqual(["a"]);
      expect(resumed.invalid).toEqual(["b"]); // b: incomplete, never executed before
      expect(fake.turns["a"]).toBeUndefined(); // reused, not re-run
      expect(fake.turns["b"]).toBe(1);
      expect(opts.registry.get(id)?.finished?.outcome).toBe("succeeded");
    }
  });

  it("refuses live, terminal, active-in-process, unknown runs and missing graphs", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith("runnable", GRAPH);
    const ctl = new WorkflowControlTool(toolOpts(null, runsRoot, wfDir));

    seedRun(runsRoot, "rs-live", "runnable", ["a", "b"], { states: { a: "succeeded", b: "running" }, claims: ["a"], owner: "live" });
    expect((await ctl.execute({ run_id: "rs-live", action: "resume" })).error).toContain("live");

    seedRun(runsRoot, "rs-fin", "runnable", ["a", "b"], { states: { a: "succeeded", b: "failed" }, finished: "failed" });
    expect((await ctl.execute({ run_id: "rs-fin", action: "resume" })).error).toContain("already failed");

    expect((await ctl.execute({ run_id: "ghost", action: "resume" })).error).toContain("not found");

    seedRun(runsRoot, "rs-gone", "vanished-graph", ["a"], {});
    expect((await ctl.execute({ run_id: "rs-gone", action: "resume" })).error).toContain("no longer saved");

    // Active in THIS process -> nothing to resume.
    const fake = makeFake({ a: hang });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    const optsCtl = new WorkflowControlTool(opts);
    await new WorkflowDispatchTool(opts).execute({ file: "runnable", run_id: "rs-act" });
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "a started");
    expect((await optsCtl.execute({ run_id: "rs-act", action: "resume" })).error).toContain("active in this process");
    opts.registry.get("rs-act")?.run.cancel();
    await settle(() => !!opts.registry.get("rs-act")?.finished, "rs-act settled");
  });
});

// ---------------------------------------------------------------------------
// workflow_control: cancel (in-process)
// ---------------------------------------------------------------------------

describe("workflow_control cancel", () => {
  it("node cancel: cancelled node, frozen ladder, blocked descendant, sibling completes", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith(
      "fork",
      `
version: 1
name: fork
description: two branches
nodes:
  - id: a
    accept:
      files: [a.out]
  - id: b
    dependsOn: [a]
  - id: c
    dependsOn: [a]
    accept:
      files: [c.out]
  - id: d
    dependsOn: [b]
`,
    );
    const fake = makeFake({ a: good, c: good, b: hang });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    await new WorkflowDispatchTool(opts).execute({ file: "fork", run_id: "nc" });
    await settle(() => (fake.turns["b"] ?? 0) >= 1, "node b running");

    const ctl = new WorkflowControlTool(opts);
    const res = await ctl.execute({ run_id: "nc", action: "cancel", node: "b" });
    expect(res.error).toBeNull();
    expect(res.output).toContain("Cancel requested for node 'b'");

    // The retry ladder is frozen: no further attempts for b, ever.
    await settle(() => !!opts.registry.get("nc")?.finished, "run settled");
    const attempts = opts.registry.get("nc")!.run.status().find((v) => v.id === "b")!.attempt;
    const bEvents = readLog(join(runsRoot, "nc")).filter((e) => e.ev === "node" && e.id === "b");
    await new Promise((r) => setTimeout(r, 250));
    expect(opts.registry.get("nc")!.run.status().find((v) => v.id === "b")!.attempt).toBe(attempts);
    expect(readLog(join(runsRoot, "nc")).filter((e) => e.ev === "node" && e.id === "b")).toHaveLength(bEvents.length);
    expect(attempts).toBe(1); // one worker turn, cancelled mid-turn, never respawned

    const finished = opts.registry.get("nc")!.finished!;
    expect(finished.states.b).toBe("cancelled");
    expect(finished.states.c).toBe("succeeded"); // sibling rode on
    expect(finished.states.d).toBe("blocked"); // descendant blocked
    expect(finished.outcome).toBe("failed"); // not all succeeded

    const log = readLog(join(runsRoot, "nc"));
    const dBlocked = log.find((e) => e.ev === "node" && e.id === "d" && e.state === "blocked") as {
      detail?: string;
    };
    expect(dBlocked?.detail).toContain("dependency 'b' cancelled"); // honest reason
    // Journal keeps full history (cancel is not a delete).
    expect(log[0]!.ev).toBe("started");
    expect(log.at(-1)!.ev).toBe("finished");

    // Already-terminal node -> refused with its real state.
    const again = await ctl.execute({ run_id: "nc", action: "cancel", node: "b" });
    expect(again.error).toContain("already cancelled");
    const doneNode = await ctl.execute({ run_id: "nc", action: "cancel", node: "c" });
    expect(doneNode.error).toContain("already succeeded");
  });

  it("queued node cancel: the worker never spawns", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith("q", `
version: 1
name: q
description: queued cancel
nodes:
  - id: a
  - id: b
    dependsOn: [a]
`);
    let release!: () => void;
    const fake = makeFake({
      a: ({ dir }) =>
        new Promise((resolve) => {
          release = () => {
            writeFileSync(join(dir, "a.verdict"), "pass");
            resolve(undefined);
          };
        }),
    });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    await new WorkflowDispatchTool(opts).execute({ file: "q", run_id: "qc" });
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "a started");

    const ctl = new WorkflowControlTool(opts);
    expect((await ctl.execute({ run_id: "qc", action: "cancel", node: "b" })).error).toBeNull();
    // Unknown node enumerates states (the pending cancel is still pending in
    // state terms until the engine settles it after its dependency lands).
    const unknown = await ctl.execute({ run_id: "qc", action: "cancel", node: "zz" });
    expect(unknown.error).toContain("a=running");
    expect(unknown.error).toContain("b=pending");

    release();
    await settle(() => !!opts.registry.get("qc")?.finished, "run settled");
    expect(fake.turns["b"]).toBeUndefined(); // never built a worker
    expect(opts.registry.get("qc")!.finished!.states.b).toBe("cancelled");
  });

  it("judge cancel mid-gate: judge cancelled, producer blocked honestly", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith(
      "jdg",
      `
version: 1
name: jdg
description: judged producer
nodes:
  - id: p
    accept:
      files: [p.out]
      judge: j
  - id: j
    dependsOn: [p]
`,
    );
    const fake = makeFake({ p: good, j: hang });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    const dispatched = await new WorkflowDispatchTool(opts).execute({ file: "jdg", run_id: "jc" });
    expect(dispatched.error).toBeNull();
    await settle(
      () => opts.registry.get("jc")?.run.status().some((v) => v.id === "p" && v.state === "judging") ?? false,
      "producer judging",
    );

    const res = await new WorkflowControlTool(opts).execute({ run_id: "jc", action: "cancel", node: "j" });
    expect(res.error).toBeNull();
    await settle(() => !!opts.registry.get("jc")?.finished, "run settled");

    const finished = opts.registry.get("jc")!.finished!;
    expect(finished.states.j).toBe("cancelled");
    expect(finished.states.p).toBe("blocked"); // not resurrected, verdict that could not land stays absent
    const detail = (readLog(join(runsRoot, "jc")).find(
      (e) => e.ev === "node" && e.state === "blocked" && String(e.detail ?? "").includes("judge 'j' cancelled"),
    ) ?? {}) as { detail?: string };
    expect(detail.detail).toContain("judge 'j' cancelled");
  });

  it("producer cancel mid-judging: owner cancelled, judge frozen, never mis-bucketed", async () => {
    // Audit regression: #runJudge used to be deaf to the OWNER's per-node
    // cancel -- a default judge settled "failed before delivering a verdict"
    // (manager cancel mis-read as infra failure) and a multi-attempt judge
    // respawned post-cancel, spending tokens and landing a stale verdict.
    for (const [tag, jAccept] of [
      ["default-judge", ""],
      ["three-attempt-judge", "    accept:\n      maxAttempts: 3\n"],
    ] as const) {
      const root = freshDir();
      const runsRoot = join(root, "runs");
      const wfDir = wfDirWith(
        "jdg2",
        `
version: 1
name: jdg2
description: producer cancel mid-judging
nodes:
  - id: p
    accept:
      files: [p.out]
      judge: j
  - id: j
${jAccept}    dependsOn: [p]
`,
      );
      const fake = makeFake({ p: good, j: hang });
      const opts = toolOpts(fake.manager, runsRoot, wfDir);
      const dispatched = await new WorkflowDispatchTool(opts).execute({ file: "jdg2", run_id: "jpc" });
      expect(dispatched.error).toBeNull();
      await settle(() => (fake.turns["j"] ?? 0) >= 1, `judge worker started (${tag})`);

      const res = await new WorkflowControlTool(opts).execute({ run_id: "jpc", action: "cancel", node: "p" });
      expect(res.error).toBeNull();
      await settle(() => !!opts.registry.get("jpc")?.finished, `run settled (${tag})`);

      const finished = opts.registry.get("jpc")!.finished!;
      expect(finished.states.p, tag).toBe("cancelled");
      expect(finished.states.j, tag).toBe("cancelled");
      expect(finished.outcome).toBe("failed");

      // The judge ladder is frozen: exactly one worker turn, nothing spawned
      // after the cancel.
      await new Promise((r) => setTimeout(r, 250));
      expect(fake.turns["j"], tag).toBe(1);
      expect(fake.turns["p"], tag).toBe(1);

      const log = readLog(join(runsRoot, "jpc"));
      const jCancelled = log.find((e) => e.ev === "node" && e.id === "j" && e.state === "cancelled") as {
        detail?: string;
      };
      expect(jCancelled?.detail).toContain("owner 'p' cancelled"); // honest reason
      expect(log.some((e) => String(e.detail ?? "").includes("failed before delivering a verdict"))).toBe(false);
      expect(log.at(-1)).toMatchObject({ ev: "finished", outcome: "failed" });
    }
  });

  it("run-level cancel settles cancelled through the engine path, journal kept", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith("rc", `
version: 1
name: rc
description: run cancel
nodes:
  - id: a
  - id: b
    dependsOn: [a]
`);
    const fake = makeFake({ a: hang });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    await new WorkflowDispatchTool(opts).execute({ file: "rc", run_id: "rc" });
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "a started");

    const res = await new WorkflowControlTool(opts).execute({ run_id: "rc", action: "cancel" });
    expect(res.error).toBeNull();
    expect(res.output).toContain("Cancel requested for run rc");
    await settle(() => !!opts.registry.get("rc")?.finished, "run settled");

    const finished = opts.registry.get("rc")!.finished!;
    expect(finished.outcome).toBe("cancelled");
    expect(finished.states.a).toBe("cancelled");
    expect(fake.manager.activeTasks()).toEqual([]);
    const log = readLog(join(runsRoot, "rc"));
    expect(log[0]!.ev).toBe("started"); // full history survives the cancel
    expect(log.at(-1)).toMatchObject({ ev: "finished", outcome: "cancelled" });

    // Run-level cancel on an already-settled run: honest report.
    const again = await new WorkflowControlTool(opts).execute({ run_id: "rc", action: "cancel" });
    expect(again.error).toContain("already cancelled");
  });

  it("refuses runs this process does not own, with the /workflow cancel pointer", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const dir = seedRun(runsRoot, "x-run", "retire", ["a"], { states: { a: "running" }, owner: "live" });
    const before = readFileSync(join(dir, "run.jsonl"), "utf8");
    const ctl = new WorkflowControlTool(toolOpts(null, runsRoot, null));

    const res = await ctl.execute({ run_id: "x-run", action: "cancel" });
    expect(res.error).toContain("not owned by this process");
    expect(res.error).toContain("/workflow cancel x-run");
    expect(readFileSync(join(dir, "run.jsonl"), "utf8")).toBe(before); // journal untouched

    // A disk-terminal run reports per node too.
    seedRun(runsRoot, "x-fin", "retire", ["a", "b"], { states: { a: "succeeded", b: "failed" }, finished: "failed" });
    expect((await ctl.execute({ run_id: "x-fin", action: "cancel", node: "b" })).error).toContain("already failed");
    expect((await ctl.execute({ run_id: "ghost", action: "cancel" })).error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// skipped/cancelled vocabulary: journal round-trips
// ---------------------------------------------------------------------------

describe("skipped vocabulary round-trip", () => {
  it("readRunSummary mirrors the terminal finished-event states", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const dir = join(runsRoot, "mirror");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.jsonl"),
      journalLine({ ev: "started", runId: "mirror", workflow: "w", nodes: ["a", "b"], startedAt: 1 }) +
        journalLine({ ev: "node", id: "a", state: "running", attempt: 1 }) +
        journalLine({ ev: "finished", outcome: "skipped", states: { a: "skipped", b: "blocked" } }),
    );
    const s = await readRunSummary(dir);
    expect(s?.outcome).toBe("skipped");
    expect(s?.nodes).toEqual([
      { id: "a", state: "skipped" },
      { id: "b", state: "blocked" },
    ]);
    expect((await scanInterruptedRuns(runsRoot)).map((r) => r.runId)).toEqual([]);
  });

  it("node events with terminal skipped/cancelled count as settled truth", async () => {
    const root = freshDir();
    const dir = join(root, "n");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.jsonl"),
      journalLine({ ev: "started", runId: "n", workflow: "w", nodes: ["a", "b"], startedAt: 1 }) +
        journalLine({ ev: "node", id: "a", state: "skipped", attempt: 1 }) +
        journalLine({ ev: "node", id: "b", state: "cancelled", attempt: 1 }) +
        journalLine({ ev: "finished", outcome: "cancelled" }),
    );
    const s = await readRunSummary(dir);
    expect(s?.nodes).toEqual([
      { id: "a", state: "skipped" },
      { id: "b", state: "cancelled" },
    ]);
  });

  it("an old journal (no states field, no skipped) still loads", async () => {
    const root = freshDir();
    const dir = join(root, "old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.out"), "keep");
    writeFileSync(join(dir, "old.verdict"), "pass");
    const st = statSync(join(dir, "old.out"));
    writeFileSync(
      join(dir, "run.jsonl"),
      journalLine({ ev: "started", runId: "old", workflow: "w", nodes: ["a", "b"], startedAt: Date.now() }) +
        journalLine({
          ev: "node",
          id: "a",
          state: "succeeded",
          attempt: 1,
          verdict: "pass",
          summary: "s",
          deps: [],
          files: { "old.out": { size: st.size, mtimeMs: st.mtimeMs } },
        }) +
        journalLine({ ev: "node", id: "b", state: "blocked", attempt: 0, detail: "dependency 'x' failed" }) +
        journalLine({ ev: "interrupted", detail: "owner lost (restart?); resumable with dispatch run_id" }) +
        journalLine({ ev: "finished", outcome: "failed" }),
    );
    const s = await readRunSummary(dir);
    expect(s?.outcome).toBe("failed");
    expect(s?.nodes).toEqual([
      { id: "a", state: "succeeded" },
      { id: "b", state: "blocked" },
    ]);
  });

  it("engine reload tolerates skipped/cancelled history (resume re-runs only unfinished work)", async () => {
    const root = freshDir();
    const runsRoot = join(root, "runs");
    const wfDir = wfDirWith(
      "tol",
      `
version: 1
name: tol
description: reload tolerance
nodes:
  - id: a
    accept:
      files: [a.out]
  - id: b
    dependsOn: [a]
`,
    );
    seedRun(runsRoot, "tol-run", "tol", ["a", "b"], { states: { a: "succeeded", b: "cancelled" }, claims: ["a"] });
    appendFileSync(
      join(runsRoot, "tol-run", "run.jsonl"),
      journalLine({ ev: "node", id: "b", state: "skipped", attempt: 1 }),
    );

    const fake = makeFake({ b: good });
    const opts = toolOpts(fake.manager, runsRoot, wfDir);
    const res = await new WorkflowDispatchTool(opts).execute({ file: "tol", run_id: "tol-run" });
    expect(res.error).toBeNull();
    await settle(() => !!opts.registry.get("tol-run")?.finished, "tol-run finished");
    expect(fake.turns["a"]).toBeUndefined(); // reused, not re-run
    expect(fake.turns["b"]).toBe(1); // unfinished work re-ran
    expect(opts.registry.get("tol-run")!.finished!.outcome).toBe("succeeded");
  });
});
