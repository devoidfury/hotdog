// Direct task-seam kills (the task_interrupt path WITHOUT the engine's own
// cancel()/cancelNode()): a worker interrupted via TaskManager ends its turn
// "cancelled" with both engine flags clear. Owner ruling: a user-cancelled
// worker is TERMINAL -- the node settles "cancelled" (never "attempts
// exhausted (failed)"), the ladder never respawns, descendants block through
// the ordinary dependency rule, siblings ride (the cancelNode doctrine).
// Also pinned: the retry ladder stays alive for REAL failures (gate-rejected
// completed turns warm-retry; failed turns cold re-admit), the judge seam
// mirrors the ruling, and the cancel()/cancelNode() flag routes are
// untouched (their full regressions live in workflows-control.test.ts).
// No fleet access: scripted fake workers on a real TaskManager, tmp dirs only.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText } from "@core/context/message.ts";
import { LlmError } from "@core/error.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { runWorkflowCommand } from "@extensions/workflows/workflow-cli.ts";
import { readRunSummary, scanInterruptedRuns } from "@extensions/workflows/run-store.ts";
import { NODE_STATE, WorkflowRun } from "@extensions/workflows/engine.ts";
import { parseWorkflow, type Workflow } from "@extensions/workflows/workflow.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-cancel-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function settle(fn: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wf(text: string): Workflow {
  const r = parseWorkflow(text);
  if (!r.workflow) throw new Error(`invalid fixture: ${r.errors.join("; ")}`);
  return r.workflow;
}

function readLog(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface WorkerCtx {
  id: string;
  dir: string;
  attempt: number;
  onAbort: (cb: () => void) => void;
}
type WorkerSpec = (ctx: WorkerCtx) => Promise<unknown> | unknown;

/** TaskManager with scripted fake workers keyed by the node id in the prompt. */
function makeFake(dir: string, spec: Record<string, WorkerSpec>) {
  const turns: Record<string, number> = {};
  let builds = 0;
  const manager = new TaskManager({
    profileManager: { getProfile: () => null } as never,
    buildAgent: async () => {
      builds++;
      const agent: Record<string, unknown> = {
        run: async (input: string | Array<Record<string, unknown>>) => {
          const prompt = contentToText(input);
          const id = /node '([a-z0-9][a-z0-9-]*)'/.exec(prompt)?.[1] ?? "unknown";
          const attempt = (turns[id] = (turns[id] ?? 0) + 1);
          const aborters: Array<() => void> = [];
          (agent.abortSignal as AbortSignal | undefined)?.addEventListener("abort", () => {
            for (const cb of aborters) cb();
          });
          const fn = spec[id];
          if (!fn) {
            writeFileSync(join(dir, `${id}.verdict`), "pass");
            return { type: "completion", content: `${id} pointer-summary` };
          }
          const out = await fn({ id, dir, attempt, onAbort: (cb) => aborters.push(cb) });
          if (out !== undefined) return out;
          return { type: "completion", content: `${id} pointer-summary` };
        },
        notifyCompletion: () => {},
        steer: () => {},
      };
      return agent as never;
    },
    modelRegistry: {},
    config: {},
    maxIterations: 5,
    taskProfile: "default",
  });
  return { manager, turns, builds: () => builds };
}

const good: WorkerSpec = ({ dir, id }) => {
  writeFileSync(join(dir, `${id}.out`), "artifact");
  writeFileSync(join(dir, `${id}.verdict`), "pass");
};

const hang: WorkerSpec = ({ onAbort }) =>
  new Promise((_resolve, reject) => {
    onAbort(() => reject(LlmError.Cancelled("aborted")));
  });

const nodeEvents = (dir: string, id: string) =>
  readLog(dir).filter((e) => e.ev === "node" && e.id === id);

describe("direct task-seam kill: terminal cancel, frozen ladder", () => {
  it("interrupting a running node's task settles cancelled; descendant blocks, sibling rides, nothing respawns", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, { a: good, b: hang, c: good });
    const workflow = wf(`
      version: 1
      name: killmid
      description: kill b mid-turn through the task seam
      nodes:
        - id: a
          accept:
            files: [a.out]
        - id: b
          dependsOn: [a]
          accept:
            maxAttempts: 3
        - id: c
          dependsOn: [a]
          accept:
            files: [c.out]
        - id: d
          dependsOn: [b]
    `);
    const run = new WorkflowRun({ workflow, runId: "k1", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["b"] ?? 0) >= 1, "b running");
    const taskId = run.status().find((s) => s.id === "b")!.task!;
    expect(taskId).not.toBeNull();

    // The defect seam: TaskManager's own interrupt (what workflow_control
    // task_interrupt / task_cancel / session-delete drive), engine flags
    // untouched. Pre-fix the ladder treated this as a failed attempt and
    // cold-respawned a fresh hang, so this await would never resolve --
    // eventually settling b FAILED "attempts exhausted (3)".
    expect(fake.manager.interruptTask(taskId)).toBe(true);
    const summary = await runP;

    expect(summary.states.b).toBe(NODE_STATE.CANCELLED);
    expect(summary.states.a).toBe(NODE_STATE.SUCCEEDED);
    expect(summary.states.c).toBe(NODE_STATE.SUCCEEDED); // sibling rode on
    expect(summary.states.d).toBe(NODE_STATE.BLOCKED); // descendant blocked
    expect(summary.outcome).toBe("failed"); // NOT the engine's own run cancel

    const view = run.status().find((s) => s.id === "b")!;
    expect(view.attempt).toBe(1); // the killed turn only; ladder frozen
    expect(view.state).toBe(NODE_STATE.CANCELLED);

    // Journal honesty: the cancelled settle logs what the flag-cancel route
    // logs (a "cancelled" node event) -- no attempt-failed/attempt-rejected
    // and no respawn event (queued/retry-warm/running) for b after it.
    const bEvents = nodeEvents(dir, "b");
    expect(bEvents.map((e) => e.state)).toEqual(["queued", "running", "cancelled"]);
    expect(bEvents.some((e) => e.state === "attempt-failed" || e.state === "attempt-rejected")).toBe(false);
    expect(String(bEvents[2]!.detail ?? "")).toBe(""); // no invented detail
    const dBlocked = nodeEvents(dir, "d").find((e) => e.state === "blocked")!;
    expect(String(dBlocked.detail)).toContain("dependency 'b' cancelled");

    // Zero respawn after the kill: turns frozen, no new journal lines, no
    // zombie task holding a lane (#releaseTask on the already-interrupted
    // task is a no-op, mirroring the engine's own cancel path).
    await sleep(250);
    expect(fake.turns["b"]).toBe(1);
    expect(nodeEvents(dir, "b")).toHaveLength(bEvents.length);
    expect(fake.manager.activeTasks()).toEqual([]);

    // The nr.cancelRequested decision: the node leaves the SAME footprint the
    // cancelNode route leaves -- terminal, reported as such, never accepted.
    expect(run.cancelNode("b")).toEqual({ error: "terminal", state: "cancelled" });
  });
});

describe("the ladder stays alive for REAL failures (control pins)", () => {
  it("gate-rejected COMPLETED turn: attempt-rejected + warm retry, succeeds", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d, attempt }) => {
        if (attempt === 1) {
          writeFileSync(join(d, "a.verdict"), "fail\nmissing output");
        } else {
          writeFileSync(join(d, "a.out"), "fixed");
          writeFileSync(join(d, "a.verdict"), "pass");
        }
      },
    });
    const workflow = wf(`
      version: 1
      name: gaterepair
      description: rejected attempt still retries
      nodes:
        - id: a
          accept:
            files: [a.out]
            retryOn: [fail]
            maxAttempts: 2
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe(NODE_STATE.SUCCEEDED);
    expect(fake.turns["a"]).toBe(2);
    expect(fake.builds()).toBe(1); // warm, same session
    const states = nodeEvents(dir, "a").map((e) => e.state);
    expect(states).toContain("attempt-rejected");
    expect(states).toContain("retry-warm");
  });

  it("turn ending FAILED cold re-admits a fresh task", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d, attempt }) => {
        if (attempt === 1) throw new Error("llm exploded");
        writeFileSync(join(d, "a.verdict"), "pass");
      },
    });
    const workflow = wf(`
      version: 1
      name: infrafail
      description: failed turn cold re-admits
      nodes:
        - id: a
          accept:
            maxAttempts: 2
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe(NODE_STATE.SUCCEEDED);
    expect(fake.turns["a"]).toBe(2);
    expect(fake.builds()).toBe(2); // cold re-admission: a new task
    const states = nodeEvents(dir, "a").map((e) => e.state);
    expect(states).toContain("attempt-failed");
    expect(states.filter((s) => s === "queued")).toHaveLength(2); // the re-admission happened
  });
});

describe("judge seam: direct kill is terminal for judge and producer", () => {
  const JUDGED = `
      version: 1
      name: judgedkill
      description: judged producer
      nodes:
        - id: p
          accept:
            files: [p.out]
            judge: j
            maxAttempts: 3
        - id: j
          dependsOn: [p]
          accept:
            maxAttempts: 3
`;

  it("interrupting the JUDGE's task settles both cancelled; no judge respawn", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, { p: good, j: hang });
    const run = new WorkflowRun({ workflow: wf(JUDGED), runId: "j1", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["j"] ?? 0) >= 1, "judge worker running");
    const jTask = run.status().find((s) => s.id === "j")!.task!;
    expect(fake.manager.interruptTask(jTask)).toBe(true);
    const summary = await runP;

    // jres.kind === "cancel" route: the owner settles cancelled with the
    // judge; the judge's 3-attempt ladder never respawns.
    expect(summary.states.j).toBe(NODE_STATE.CANCELLED);
    expect(summary.states.p).toBe(NODE_STATE.CANCELLED);
    expect(summary.outcome).toBe("failed"); // no run-level flag was set
    await sleep(250);
    expect(fake.turns["j"]).toBe(1);
    expect(fake.turns["p"]).toBe(1);
    const jEvents = nodeEvents(dir, "j").map((e) => e.state);
    expect(jEvents).toEqual(["queued", "running", "cancelled"]);
    const log = readLog(dir);
    expect(log.some((e) => String(e.detail ?? "").includes("attempts exhausted"))).toBe(false);
    expect(log.some((e) => String(e.detail ?? "").includes("failed before delivering a verdict"))).toBe(false);
  });

  it("workflow_control judge cancel (flag route) still BLOCKS the producer -- doctrine unchanged", async () => {
    // The distinction my judge branch must preserve: jnr.cancelRequested
    // (workflow_control cancelled THIS judge) blocks the producer honestly;
    // only flagless direct kills take the kind "cancel" route.
    const dir = freshDir();
    const fake = makeFake(dir, { p: good, j: hang });
    const run = new WorkflowRun({ workflow: wf(JUDGED), runId: "j2", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["j"] ?? 0) >= 1, "judge worker running");
    expect(run.cancelNode("j")).toEqual({ ok: true });
    const summary = await runP;
    expect(summary.states.j).toBe(NODE_STATE.CANCELLED);
    expect(summary.states.p).toBe(NODE_STATE.BLOCKED);
    const blocked = readLog(dir).find((e) => e.state === "blocked" && e.id === "p")!;
    expect(String(blocked.detail)).toContain("judge 'j' cancelled");
  });

  it("owner cancel mid-judging with a landed verdict: flag route unchanged, owner wins", async () => {
    // "Keep whatever verdict already landed" stays flag-driven: attempt 1's
    // judge verdict (reject) only queued a warm retry; cancelling the OWNER
    // during attempt 2's judging settles both cancelled through the engine's
    // own JUDGING fan-out -- never respawned, owner-cancel detail on the judge.
    const dir = freshDir();
    const fake = makeFake(dir, {
      p: good,
      j: ({ dir: d, attempt, onAbort }) => {
        if (attempt === 1) {
          writeFileSync(join(d, "j.verdict"), "reject\ntry harder");
          return;
        }
        return new Promise((_resolve, reject) => {
          onAbort(() => reject(LlmError.Cancelled("aborted")));
        });
      },
    });
    const run = new WorkflowRun({ workflow: wf(JUDGED), runId: "j3", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["j"] ?? 0) >= 2, "second judge attempt running");
    expect(run.cancelNode("p")).toEqual({ ok: true });
    const summary = await runP;
    expect(summary.states.p).toBe(NODE_STATE.CANCELLED);
    expect(summary.states.j).toBe(NODE_STATE.CANCELLED);
    await sleep(250);
    expect(fake.turns["j"]).toBe(2); // no respawn past the cancel
    const log = readLog(dir);
    expect(log.some((e) => e.id === "p" && e.state === "succeeded")).toBe(false);
    const jCancelled = log.find((e) => e.id === "j" && e.state === "cancelled")!;
    expect(String(jCancelled.detail)).toContain("owner 'p' cancelled");
  });
});

describe("journal replay of a cancelled settle", () => {
  it("readRunSummary, the interrupted scan and the CLI status all take it", async () => {
    const runsRoot = freshDir();
    const dir = join(runsRoot, "cs1");
    mkdirSync(dir, { recursive: true });
    const fake = makeFake(dir, { a: hang });
    const workflow = wf(`
      version: 1
      name: replay
      description: cancelled journal replays
      nodes:
        - id: a
        - id: b
          dependsOn: [a]
    `);
    const run = new WorkflowRun({ workflow, runId: "cs1", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "a running");
    expect(fake.manager.interruptTask(run.status().find((s) => s.id === "a")!.task!)).toBe(true);
    await runP;

    const summary = await readRunSummary(dir);
    expect(summary?.outcome).toBe("failed");
    expect(summary?.nodes).toEqual([
      { id: "a", state: "cancelled" },
      { id: "b", state: "blocked" },
    ]);
    expect((await scanInterruptedRuns(runsRoot)).map((r) => r.runId)).toEqual([]);
    const st = await runWorkflowCommand(["status", "cs1"], { runsRoot });
    expect(st.out.join("\n")).toContain("cancelled");
    expect(st.out.join("\n")).toContain("blocked");
  });
});
