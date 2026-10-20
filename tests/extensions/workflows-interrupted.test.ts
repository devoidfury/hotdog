// Restart durability for workflow runs: the activation scan marks crashed run
// dirs with one `interrupted` journal event (idempotent), the engine treats
// unknown events as inert state-wise, and the surfaces (workflow_status tool,
// `workflow list`) name resumable runs. Mark + surface only -- never resume.

import { describe, it, expect, afterAll } from "bun:test";
import {
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
import { TaskManager } from "@core/session/task-manager.ts";
import { create } from "@extensions/workflows/index.ts";
import { runWorkflowCommand } from "@extensions/workflows/workflow-cli.ts";
import { parseWorkflow, type Workflow } from "@extensions/workflows/workflow.ts";
import {
  INTERRUPTED_DETAIL,
  markInterruptedRuns,
  scanInterruptedRuns,
  WorkflowRun,
} from "@extensions/workflows/engine.ts";
import { RunRegistry, WorkflowStatusTool } from "@extensions/workflows/workflow-tools.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const DEAD_PID = 999999; // spec-blessed dead pid

function journalLine(rec: Record<string, unknown>): string {
  return `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`;
}

interface SeedOpts {
  owner?: "dead" | "live" | "foreign" | "corrupt" | "none";
  marker?: boolean; // journal already ends with an `interrupted` event
  nodeActivity?: boolean; // otherwise the journal holds only `started`
  finished?: string; // outcome string: the journal ends with `finished`
}

/**
 * Hand-seeded crashed run dir: node `a` succeeded (real file + verdict so the
 * claim validates), node `b` was running when the writer died.
 */
function seedRunDir(runsRoot: string, runId: string, opts: SeedOpts = {}): string {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  let text = journalLine({
    ev: "started",
    runId,
    workflow: "demo",
    nodes: ["a", "b"],
    startedAt: Date.now() - 5000,
  });
  if (opts.nodeActivity !== false) {
    writeFileSync(join(dir, "a.out"), "alpha");
    writeFileSync(join(dir, "a.verdict"), "pass");
    const st = statSync(join(dir, "a.out"));
    text += journalLine({ ev: "node", id: "a", state: "queued", attempt: 1, task: `${runId}:a#1` });
    text += journalLine({ ev: "node", id: "a", state: "running", attempt: 1, task: `${runId}:a#1` });
    text += journalLine({
      ev: "node",
      id: "a",
      state: "succeeded",
      attempt: 1,
      verdict: "pass",
      summary: "a done",
      deps: [],
      files: { "a.out": { size: st.size, mtimeMs: st.mtimeMs } },
    });
    text += journalLine({ ev: "node", id: "b", state: "queued", attempt: 1, task: `${runId}:b#1` });
    text += journalLine({ ev: "node", id: "b", state: "running", attempt: 1, task: `${runId}:b#1` });
  }
  if (opts.marker) text += journalLine({ ev: "interrupted", detail: INTERRUPTED_DETAIL });
  if (opts.finished) text += journalLine({ ev: "finished", outcome: opts.finished });
  writeFileSync(join(dir, "run.jsonl"), text);

  const owners: Record<"dead" | "live" | "foreign", { pid: number; host: string; claimedAt: string }> =
    {
      dead: { pid: DEAD_PID, host: hostname(), claimedAt: "2026-01-01T00:00:00.000Z" },
      live: { pid: process.pid, host: hostname(), claimedAt: "2026-01-01T00:00:00.000Z" },
      foreign: { pid: 4242, host: "another-machine", claimedAt: "2026-01-01T00:00:00.000Z" },
    };
  const owner = opts.owner && opts.owner in owners ? owners[opts.owner as "dead" | "live" | "foreign"] : undefined;
  if (opts.owner === "corrupt") writeFileSync(join(dir, ".owner"), "garbage, crashed writer");
  else if (owner) writeFileSync(join(dir, ".owner"), `${JSON.stringify(owner)}\n`);
  return dir;
}

function countEvents(dir: string, ev: string): number {
  return readFileSync(join(dir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {}; // torn lines are skipped, same as the engine's readers
      }
    })
    .filter((e) => e.ev === ev).length;
}

const twoGraph = (): Workflow => {
  const r = parseWorkflow(`
    version: 1
    name: demo
    description: a then b
    nodes:
      - id: a
        accept:
          files: [a.out]
      - id: b
        dependsOn: [a]
        accept:
          files: [b.out]
  `);
  if (!r.workflow) throw new Error(`invalid fixture: ${r.errors.join("; ")}`);
  return r.workflow;
};

/** Scripted fake workers: write the node's output + pass verdict (engine prompts carry the run dir). */
function makeFake(): { tasks: TaskManager; turns: Record<string, number> } {
  const turns: Record<string, number> = {};
  const tasks = new TaskManager({
    buildAgent: async () => {
      return {
        run: async (input: string | Array<Record<string, unknown>>) => {
          const prompt = contentToText(input);
          const id = /node '([a-z0-9-]+)'/.exec(prompt)?.[1] ?? "x";
          const dir = /\.verdict under (.+): first line/.exec(prompt)?.[1];
          turns[id] = (turns[id] ?? 0) + 1;
          if (dir) {
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
  return { tasks, turns };
}

describe("interrupted-run scan & marking", () => {
  it("marks a crashed run exactly once; a rescan does not repeat the event", async () => {
    const root = freshDir();
    const dir = seedRunDir(root, "run-dead");

    const found = await markInterruptedRuns(root);
    expect(found.map((r) => r.runId)).toEqual(["run-dead"]);
    expect(countEvents(dir, "interrupted")).toBe(1);
    const lines = readFileSync(join(dir, "run.jsonl"), "utf8").trim().split("\n");
    const marker = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(marker.ev).toBe("interrupted");
    expect(marker.detail).toBe(INTERRUPTED_DETAIL);
    expect(typeof marker.t).toBe("string");

    // Idempotence: the last event already is the marker -> no second append.
    await markInterruptedRuns(root);
    expect(countEvents(dir, "interrupted")).toBe(1);
    // The run stays resumable: it is listed even when already marked.
    expect((await scanInterruptedRuns(root)).map((r) => r.runId)).toEqual(["run-dead"]);
  });

  it("never marks finished runs or runs whose owner pid is alive (this process)", async () => {
    const root = freshDir();
    const finishedDir = seedRunDir(root, "run-finished", { finished: "succeeded", owner: "none" });
    const liveDir = seedRunDir(root, "run-live", { owner: "live" });

    expect(await scanInterruptedRuns(root)).toEqual([]);
    expect(await markInterruptedRuns(root)).toEqual([]);
    expect(countEvents(finishedDir, "interrupted")).toBe(0);
    expect(countEvents(liveDir, "interrupted")).toBe(0);
  });

  it("absent, corrupt, and foreign-host owners all read as interrupted (reclaim-with-warning stance)", async () => {
    const root = freshDir();
    seedRunDir(root, "run-absent", { owner: "none" });
    seedRunDir(root, "run-corrupt", { owner: "corrupt" });
    seedRunDir(root, "run-foreign", { owner: "foreign" });

    const found = await markInterruptedRuns(root);
    expect(found.map((r) => r.runId).sort()).toEqual(["run-absent", "run-corrupt", "run-foreign"]);
    for (const r of found) expect(countEvents(r.runDir, "interrupted")).toBe(1);
  });

  it("listing includes started-only dirs; marking (and the warn set) requires node activity", async () => {
    const root = freshDir();
    const bare = seedRunDir(root, "run-bare", { owner: "none", nodeActivity: false });

    const found = await markInterruptedRuns(root);
    expect(found.map((r) => r.runId)).toEqual(["run-bare"]);
    expect(found[0]!.nodeActivity).toBe(false);
    expect(countEvents(bare, "interrupted")).toBe(0); // no node activity -> no marker
  });

  it("torn and unknown journal lines are skipped without crashing the scan", async () => {
    const root = freshDir();
    const dir = seedRunDir(root, "run-garbage", { owner: "dead" });
    writeFileSync(
      join(dir, "run.jsonl"),
      readFileSync(join(dir, "run.jsonl"), "utf8") +
        `{"ev":"coroutine_exhausted","note":"a future writer's event"}\n` +
        `this line is not json at all\n`,
    );
    const found = await markInterruptedRuns(root);
    expect(found.map((r) => r.runId)).toEqual(["run-garbage"]);
    // The last PARSED event was the foreign ev, so marking still applies.
    expect(countEvents(dir, "interrupted")).toBe(1);
  });

  it("activation via create() marks seeded crashed runs, rescans idempotently", async () => {
    const root = freshDir();
    const wfDir = join(root, "wf");
    const dir = seedRunDir(join(wfDir, "runs"), "run-boot", { owner: "dead" });

    await create({ config: { workflows: { path: wfDir } } } as never);
    expect(countEvents(dir, "interrupted")).toBe(1);

    await create({ config: { workflows: { path: wfDir } } } as never);
    expect(countEvents(dir, "interrupted")).toBe(1);
  });
  it("the bounded activation scan judges huge journals from the head line + tail window", async () => {
    const root = freshDir();
    const pad = (ev: Record<string, unknown>) => journalLine({ ...ev, pad: "x".repeat(60) });

    // >2x the scan window: started head, thousands of node lines, killed with
    // b running, dead owner -- marking must judge it without reading it whole.
    const dir = seedRunDir(root, "run-huge", { owner: "dead", nodeActivity: false });
    let text = readFileSync(join(dir, "run.jsonl"), "utf8"); // started-only base
    for (let i = 0; i < 2000; i++) text += pad({ ev: "node", id: "a", state: "running", attempt: 1 });
    text += journalLine({ ev: "node", id: "b", state: "running", attempt: 1 });
    writeFileSync(join(dir, "run.jsonl"), text);
    expect(text.length).toBeGreaterThan(128 * 1024);

    const found = await markInterruptedRuns(root);
    expect(found.map((r) => r.runId)).toEqual(["run-huge"]);
    expect(countEvents(dir, "interrupted")).toBe(1);
    await markInterruptedRuns(root);
    expect(countEvents(dir, "interrupted")).toBe(1); // idempotence across the window too

    // A huge journal that DID reach finished: the tail ends `finished`, skip.
    const doneDir = join(root, "run-huge-done");
    mkdirSync(doneDir, { recursive: true });
    let done = journalLine({ ev: "started", runId: "run-huge-done", workflow: "demo", nodes: ["a"], startedAt: Date.now() });
    for (let i = 0; i < 2000; i++) done += pad({ ev: "node", id: "a", state: "running", attempt: 1 });
    done += journalLine({ ev: "finished", outcome: "succeeded", states: {} });
    writeFileSync(join(doneDir, "run.jsonl"), done);
    writeFileSync(join(doneDir, ".owner"), `${JSON.stringify({ pid: DEAD_PID, host: hostname() })}\n`);

    // A huge non-engine journal (no started head): not a run dir, untouched.
    const foreign = join(root, "not-a-run");
    mkdirSync(foreign, { recursive: true });
    let junk = "";
    for (let i = 0; i < 2000; i++) junk += pad({ ev: "someone-elses-event", i });
    writeFileSync(join(foreign, "run.jsonl"), junk);

    const second = await markInterruptedRuns(root);
    expect(second.map((r) => r.runId)).toEqual(["run-huge"]); // still listed (already marked), the rest untouched
    expect(countEvents(doneDir, "interrupted")).toBe(0);
    expect(countEvents(foreign, "interrupted")).toBe(0);
  });
});

describe("engine tolerance & resume-after-interrupted equivalence", () => {
  it("resume on a marked (+garbage-line) dir behaves identically to resume on an unmarked dir", async () => {
    const marked = seedRunDir(freshDir(), "run-x");
    const clean = seedRunDir(freshDir(), "run-x");
    // The marked dir carries the crash marker, a dead-pid claim, and a
    // garbage-but-valid-json event: none may influence the resume.
    writeFileSync(
      join(marked, "run.jsonl"),
      readFileSync(join(marked, "run.jsonl"), "utf8") +
        journalLine({ ev: "interrupted", detail: INTERRUPTED_DETAIL }) +
        `{"ev":"mystery_machine","x":1}\n`,
      { flag: "a" },
    );
    writeFileSync(join(marked, ".owner"), `${JSON.stringify({ pid: DEAD_PID, host: hostname() })}\n`);

    interface Outcome {
      outcome: string;
      states: Record<string, string>;
      aTurns?: number;
      bTurns?: number;
    }
    const results: Outcome[] = [];
    for (const dir of [marked, clean]) {
      const fake = makeFake();
      const summary = await new WorkflowRun({
        workflow: twoGraph(),
        runId: "run-x",
        runDir: dir,
        tasks: fake.tasks,
      }).run();
      results.push({
        outcome: summary.outcome,
        states: summary.states,
        aTurns: fake.turns["a"],
        bTurns: fake.turns["b"],
      });
    }
    const [markedRun, cleanRun] = results as [Outcome, Outcome];
    // Identical behavior: a's claim validates in both (reused, never run), b re-executes once.
    expect(cleanRun.outcome).toBe("succeeded");
    expect(markedRun).toEqual(cleanRun);
    expect(markedRun.aTurns).toBeUndefined();
    expect(markedRun.bTurns).toBe(1);
    // The marked journal keeps its marker and still terminates with `finished`.
    expect(countEvents(marked, "interrupted")).toBe(1);
    expect(countEvents(marked, "finished")).toBe(1);
  });
});

describe("surfacing: workflow_status tool + CLI list", () => {
  const toolOpts = (runsRoot: string | null) => ({
    taskManagerProvider: () => null,
    getRunsRoot: () => runsRoot,
    getWorkflowsDir: () => null,
    limits: {},
    registry: new RunRegistry(),
  });

  it("no run_id: in-process output stays byte-identical when nothing qualifies", async () => {
    const empty = freshDir();
    const tool = new WorkflowStatusTool(toolOpts(empty));
    expect((await tool.execute({})).output).toBe("No workflow runs dispatched in this process.");

    // A live-owned unfinished run does not qualify either (it is not interrupted).
    const root = freshDir();
    seedRunDir(root, "run-live", { owner: "live" });
    expect((await new WorkflowStatusTool(toolOpts(root)).execute({})).output).toBe(
      "No workflow runs dispatched in this process.",
    );
  });

  it("no run_id: interrupted fixture dirs append the disk section with the literal resume instruction", async () => {
    const root = freshDir();
    seedRunDir(root, "20260101-1010-crash", { owner: "dead" });
    const r = await new WorkflowStatusTool(toolOpts(root)).execute({});
    expect(r.output).toContain("No workflow runs dispatched in this process.");
    expect(r.output).toContain("Interrupted runs on disk (owner lost -- restart?):");
    expect(r.output).toContain("  20260101-1010-crash  demo  last: a=succeeded, b=running -- re-dispatch the same file with run_id");
    // The in-process header stays the FIRST output bytes.
    expect(r.output.startsWith("No workflow runs dispatched in this process.\n")).toBe(true);
  });

  it("CLI list names interrupted runs and keeps live-owner runs plain 'unfinished'", async () => {
    const root = freshDir();
    seedRunDir(root, "run-dead", { owner: "dead" });
    seedRunDir(root, "run-live", { owner: "live" });
    seedRunDir(root, "run-done", { finished: "succeeded", owner: "none" });
    const r = await runWorkflowCommand(["list"], { runsRoot: root });
    expect(r.out).toEqual([
      "run-dead  demo  interrupted (resumable: run --id run-dead)",
      "run-done  demo  succeeded",
      "run-live  demo  unfinished",
    ]);
  });
});
