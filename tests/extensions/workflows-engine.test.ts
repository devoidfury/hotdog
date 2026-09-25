// Tests for the workflow engine (increment 4). No fleet access: the engine
// runs against a real TaskManager whose buildAgent returns scripted fake
// worker agents; output files and verdicts are written by those fakes.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TaskManager } from "@core/session/task-manager.ts";
import { LlmError } from "@core/error.ts";
import { contentToText } from "@core/context/message.ts";
import { parseWorkflow, type Workflow } from "@extensions/workflows/workflow.ts";
import { NODE_STATE, reconcileRun, WorkflowRun } from "@extensions/workflows/engine.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-engine-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function settle(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function writeFile(dir: string, rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function wf(text: string): Workflow {
  const r = parseWorkflow(text);
  if (!r.workflow) throw new Error(`invalid fixture: ${r.errors.join("; ")}`);
  return r.workflow;
}

interface WorkerCtx {
  id: string;
  dir: string;
  attempt: number; // 1-based turns for this node id (warm retries included)
  prompts: string[]; // every prompt this node id has received
  onAbort: (cb: () => void) => void; // fires when the task's abortSignal aborts
}
type WorkerSpec = (ctx: WorkerCtx) => Promise<unknown> | unknown;

interface Fake {
  manager: TaskManager;
  builds: () => number;
  turns: Record<string, number>;
  prompts: Record<string, string[]>;
  rawPrompts: Record<string, Array<string | Array<Record<string, unknown>>>>;
  steered: string[];
  maxActive: () => number;
}

/** TaskManager with scripted fake workers keyed by the node id in the prompt. */
function makeFake(
  dir: string,
  spec: Record<string, WorkerSpec>,
  opts: {
    lanes?: number;
    modelRegistry?: Record<string, never>;
    runningPeek?: (provider: string) => Promise<Set<string>>;
    modelGroups?: Record<string, string[]>;
  } = {},
): Fake {
  const turns: Record<string, number> = {};
  const prompts: Record<string, string[]> = {};
  const rawPrompts: Fake["rawPrompts"] = {};
  const steered: string[] = [];
  let builds = 0;
  let active = 0;
  let maxActive = 0;
  const manager = new TaskManager({
    buildAgent: async () => {
      builds++;
      const agent: Record<string, unknown> = {
        run: async (input: string | Array<Record<string, unknown>>) => {
          // Engine prompts are content parts; assertions match on the text.
          const prompt = contentToText(input);
          const m = /node '([a-z0-9][a-z0-9-]*)'/.exec(prompt);
          const id = m?.[1] ?? "unknown";
          (prompts[id] ??= []).push(prompt);
          (rawPrompts[id] ??= []).push(input);
          const attempt = (turns[id] = (turns[id] ?? 0) + 1);
          active++;
          maxActive = Math.max(maxActive, active);
          const aborters: Array<() => void> = [];
          const signal = agent.abortSignal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            for (const cb of aborters) cb();
          });
          try {
            const fn = spec[id];
            if (!fn) {
              writeFile(dir, `${id}.verdict`, "pass");
              return { type: "completion", content: `${id} pointer-summary` };
            }
            const out = await fn({ id, dir, attempt, prompts: prompts[id]!, onAbort: (cb) => aborters.push(cb) });
            if (out !== undefined) return out;
            return { type: "completion", content: `${id} pointer-summary` };
          } finally {
            active--;
          }
        },
        notifyCompletion: () => {},
        steer: (m: string) => {
          steered.push(m);
        },
      };
      return agent as never;
    },
    modelRegistry: opts.modelRegistry ?? {},
    config: opts.modelGroups ? ({ modelGroups: opts.modelGroups } as never) : {},
    maxIterations: 5,
    taskProfile: "default",
    lanesPerProvider: opts.lanes,
    runningPeek: opts.runningPeek,
  });
  return {
    manager,
    builds: () => builds,
    turns,
    prompts,
    rawPrompts,
    steered,
    maxActive: () => maxActive,
  };
}

/** Default good worker: writes declared files (via extraFiles) + a pass verdict. */
function good(extraFiles: Record<string, string> = {}): WorkerSpec {
  return ({ dir, id, attempt }) => {
    for (const [rel, body] of Object.entries(extraFiles)) {
      writeFile(dir, rel, `${body} #v${attempt}`);
    }
    writeFile(dir, `${id}.verdict`, "pass");
  };
}

function readLog(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("engine: state machine & gates", () => {
  it("runs a linear graph; downstream sees upstream pointer summaries", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: good({ "out.txt": "artifact" }),
      b: good({ "result.txt": "final" }),
    });
    const workflow = wf(`
      version: 1
      name: linear
      description: a then b
      nodes:
        - id: a
          accept:
            files: [out.txt]
        - id: b
          dependsOn: [a]
          inputs:
            artifact: "{{nodes.a.out}}"
          accept:
            files: [result.txt]
    `);
    const run = new WorkflowRun({ workflow, runId: "run1", runDir: dir, tasks: fake.manager });
    const summary = await run.run();

    expect(summary.outcome).toBe("succeeded");
    expect(summary.states).toEqual({ a: "succeeded", b: "succeeded" });
    // b's prompt carries the upstream verdict + pointer summary + data ref.
    expect(fake.prompts["b"]![0]).toContain("node 'a': verdict pass");
    expect(fake.prompts["b"]![0]).toContain("a pointer-summary");
    expect(fake.prompts["b"]![0]).toContain("input 'artifact' refers to 'nodes.a.out'");
    // Every declared contract landed in the run dir.
    readFileSync(join(dir, "out.txt"), "utf8");
    readFileSync(join(dir, "a.verdict"), "utf8");

    const events = readLog(dir);
    expect(events[0]!.ev).toBe("started");
    expect(events.find((e) => e.id === "a" && e.state === "succeeded")).toBeTruthy();
    expect(events.find((e) => e.id === "b" && e.state === "succeeded")).toBeTruthy();
    expect(events.at(-1)!.ev).toBe("finished");
    expect(events.at(-1)!.outcome).toBe("succeeded");
  });

  it("missing output file fails the node; descendants block, siblings ride", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: () => undefined, // claims files, writes none
      b: good({ "b.txt": "x" }),
      c: good({ "c.txt": "x" }),
    });
    const workflow = wf(`
      version: 1
      name: gatefail
      description: a fails, b blocks, c rides
      nodes:
        - id: a
          accept:
            files: [missing.txt]
        - id: b
          dependsOn: [a]
        - id: c
    `);
    const run = new WorkflowRun({ workflow, runId: "run1", runDir: dir, tasks: fake.manager });
    const summary = await run.run();

    expect(summary.outcome).toBe("failed");
    expect(summary.states).toEqual({ a: "failed", b: "blocked", c: "succeeded" });
    const aEv = readLog(dir).find((e) => e.id === "a" && e.state === "failed");
    expect(String(aEv!.detail)).toContain("missing outputs: missing.txt");
  });

  it("worker verdict fail/reject is machine-gated", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d }) => writeFile(d, "a.verdict", "FAIL\nupper case trims fine"),
    });
    const workflow = wf(`
      version: 1
      name: verdictfail
      description: honest self-fail
      nodes:
        - id: a
    `);
    const run = new WorkflowRun({ workflow, runId: "run1", runDir: dir, tasks: fake.manager });
    const summary = await run.run();
    expect(summary.states.a).toBe("failed");
    expect(String(readLog(dir).find((e) => e.id === "a" && e.state === "failed")!.detail)).toContain(
      "worker verdict 'fail'",
    );
    expect(fake.turns["a"]).toBe(1);
  });

  it("unparsable verdict fails the attempt", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d }) => writeFile(d, "a.verdict", "probably fine I think"),
    });
    const workflow = wf(`
      version: 1
      name: badverdict
      description: unparsable verdict
      nodes:
        - id: a
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe("failed");
    expect(String(readLog(dir).find((e) => e.id === "a" && e.state === "failed")!.detail)).toContain(
      "verdict file 'a.verdict'",
    );
  });

  it("warm retry: same session, critique in follow-up, attempts counted", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d, attempt }) => {
        if (attempt === 1) {
          writeFile(d, "a.verdict", "fail\nthe artifact was missing");
        } else {
          writeFile(d, "out.txt", "fixed");
          writeFile(d, "a.verdict", "pass");
        }
      },
    });
    const workflow = wf(`
      version: 1
      name: warmretry
      description: fail then warm retry passes
      nodes:
        - id: a
          accept:
            files: [out.txt]
            retryOn: [fail, reject]
            maxAttempts: 2
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();

    expect(summary.states.a).toBe("succeeded");
    expect(fake.builds()).toBe(1); // ONE task, two turns -> warm, cache-neutral
    expect(fake.turns["a"]).toBe(2);
    expect(fake.prompts["a"]![1]).toContain("The previous attempt was not accepted");
    expect(fake.prompts["a"]![1]).toContain("missing outputs");
    expect(readLog(dir).some((e) => e.state === "retry-warm")).toBe(true);
    const ok = readLog(dir).find((e) => e.id === "a" && e.state === "succeeded");
    expect(ok!.attempt).toBe(2);
  });

  it("warm retry killed while queued for the lane settles instead of hanging", async () => {
    // Regression: taskTurn resolves `cancelled` WITHOUT firing onTurn when the
    // entry dies during its queued-for-lane wait (external interrupt, session
    // delete); the engine must consume that resolution or the attempt's gate
    // never resolves and run() hangs forever.
    const dir = freshDir();
    const logged = (state: string): boolean => {
      try {
        return readLog(dir).some((e) => e.state === state);
      } catch {
        return false;
      }
    };
    let releaseS!: () => void;
    const holdS = new Promise<void>((r) => {
      releaseS = r;
    });
    const fake = makeFake(
      dir,
      {
        a: ({ dir: d, attempt }) => {
          if (attempt === 1) writeFile(d, "a.verdict", "fail\nnot yet");
          // attempt 2 must never run: the warm retry dies in the lane queue.
        },
        s: async () => {
          await holdS;
          writeFile(dir, "s.verdict", "pass");
        },
      },
      { lanes: 1 },
    );
    const workflow = wf(`
      version: 1
      name: deadqueue
      description: warm retry interrupted while queued for the lane
      nodes:
        - id: a
          accept:
            retryOn: [fail]
            maxAttempts: 2
        - id: s
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    // a's attempt 1 gate-fails (parked, lane yielded) -> s takes the lane ->
    // a's warm retry queues behind it: logged, but the second turn never starts.
    await settle(
      () => fake.turns["s"] === 1 && fake.turns["a"] === 1 && logged("retry-warm"),
      "warm retry queued behind s",
    );
    // External kill (task_cancel / session delete), not a workflow cancel.
    expect(fake.manager.interruptTask("r:a#1")).toBe(true);
    releaseS();
    const summary = await runP; // hung forever before the engine fix
    expect(summary.states.a).toBe(NODE_STATE.FAILED);
    expect(summary.states.s).toBe(NODE_STATE.SUCCEEDED);
    expect(fake.turns["a"]).toBe(1); // the queued retry never became an agent turn
    expect(fake.builds()).toBe(2); // a + s; no cold re-admission after the kill
  });

  it("retryOn selects which verdicts retry: fail with retryOn [reject] fails fast", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d }) => writeFile(d, "a.verdict", "fail"),
    });
    const workflow = wf(`
      version: 1
      name: noretry
      description: fail is not retried
      nodes:
        - id: a
          accept:
            retryOn: [reject]
            maxAttempts: 3
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe("failed");
    expect(fake.turns["a"]).toBe(1);
  });

  it("infra failure cold re-admits a fresh task", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d, attempt }) => {
        if (attempt === 1) throw new Error("llm exploded");
        writeFile(d, "a.verdict", "pass");
      },
    });
    const workflow = wf(`
      version: 1
      name: coldretry
      description: infra fail then cold admit
      nodes:
        - id: a
          accept:
            maxAttempts: 2
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe("succeeded");
    expect(fake.builds()).toBe(2); // new task = cold re-admission
    expect(fake.turns["a"]).toBe(2);
  });

  it("exhausted attempts fail exactly one way and free the lane", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ dir: d }) => writeFile(d, "a.verdict", "reject"),
    }, { lanes: 1 });
    const workflow = wf(`
      version: 1
      name: exhaust
      description: always rejects
      nodes:
        - id: a
          accept:
            maxAttempts: 3
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.a).toBe("failed");
    expect(fake.turns["a"]).toBe(3);
    // No parked zombie holding the lane: the manager reports nothing active.
    expect(fake.manager.activeTasks()).toEqual([]);
    expect(fake.manager.progressMessage()).toBeNull();
  });

  it("lane cap serializes independent nodes", async () => {
    const dir = freshDir();
    let gateResolve!: () => void;
    const hold = new Promise<void>((r) => {
      gateResolve = r;
    });
    const fake = makeFake(
      dir,
      {
        a: async ({ dir: d, onAbort }) => {
          onAbort(() => {
            gateResolve();
            throw LlmError.Cancelled("aborted");
          });
          await hold;
          writeFile(d, "a.verdict", "pass");
        },
        b: ({ dir: d }) => writeFile(d, "b.verdict", "pass"),
      },
      { lanes: 1 },
    );
    const workflow = wf(`
      version: 1
      name: lanes
      description: two independent nodes one lane
      nodes:
        - id: a
        - id: b
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(
      () => (fake.turns["a"] ?? 0) >= 1 && run.status().find((s) => s.id === "b")!.task !== null,
      "a running and b spawned",
    );
    const view = run.status().find((s) => s.id === "b")!;
    expect(view.state).toBe(NODE_STATE.RUNNING); // spawned; underlying task waits on the lane
    expect(view.taskStatus).toBe("queued");
    gateResolve();
    const summary = await runP;
    expect(summary.outcome).toBe("succeeded");
    expect(fake.maxActive()).toBe(1);
  });

  it("cancel interrupts running nodes and settles the run cancelled", async () => {
    const dir = freshDir();
    let releaseAbort!: () => void;
    const fake = makeFake(dir, {
      a: ({ onAbort }) =>
        new Promise((_resolve, reject) => {
          onAbort(() => reject(LlmError.Cancelled("aborted")));
          releaseAbort = () => reject(LlmError.Cancelled("aborted"));
        }),
    });
    const workflow = wf(`
      version: 1
      name: cancelme
      description: hangs until cancelled
      nodes:
        - id: a
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "worker started");
    run.cancel();
    const summary = await runP;
    expect(summary.outcome).toBe("cancelled");
    expect(summary.states.a).toBe(NODE_STATE.CANCELLED);
    expect(fake.manager.activeTasks()).toEqual([]);
    expect(readLog(dir).at(-1)!.outcome).toBe("cancelled");
    void releaseAbort;
  });

  it("max_runtime kills a slow node with no retry", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: ({ onAbort }) =>
        new Promise((_resolve, reject) => {
          onAbort(() => reject(LlmError.Cancelled("aborted")));
        }),
    });
    const workflow = wf(`
      version: 1
      name: slow
      description: exceeds runtime cap
      nodes:
        - id: a
          accept:
            maxAttempts: 3
    `);
    const summary = await new WorkflowRun({
      workflow,
      runId: "r",
      runDir: dir,
      tasks: fake.manager,
      maxRuntimeMsOverride: 80,
    }).run();
    expect(summary.states.a).toBe("failed");
    expect(String(readLog(dir).find((e) => e.id === "a" && e.state === "failed")!.detail)).toContain(
      "max_runtime",
    );
    expect(fake.turns["a"]).toBe(1); // runtime kill is terminal, not retried
  });

  it("capability requirements resolve through the model resolver at admission", async () => {
    const dir = freshDir();
    // Distinct models per provider: each requires-plan collapses to a single
    // candidate, so placement (and the agent build) is synchronous -- fakes
    // can assert on prompt turn counts.
    const registry = {
      "p1/heavy": { name: "heavy", temperature: null, contextLimit: 262144, tags: [], capabilities: {} },
      "p2/light": { name: "light", temperature: null, contextLimit: 65536, tags: [], capabilities: {} },
    } as never;
    const fake = makeFake(
      dir,
      { a: good() },
      {
        modelRegistry: registry as never,
      },
    );
    const workflow = wf(`
      version: 1
      name: placement
      description: requires drive placement
      nodes:
        - id: a
          requires:
            ctx: 100000
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const summary = await run.run();
    expect(summary.outcome).toBe("succeeded");
    expect(fake.turns["a"]).toBe(1);
    const taskId = run.status().find((s) => s.id === "a")!.task!;
    expect(fake.manager.taskLane(taskId)).toEqual({ model: "p1/heavy", provider: "p1" });
  });

  it("group nodes fan out across provider lanes and run in parallel", async () => {
    const dir = freshDir();
    const registry = {
      "p1/q": { name: "q", temperature: null, contextLimit: 131072, tags: [] },
      "p2/q": { name: "q", temperature: null, contextLimit: 131072, tags: [] },
    } as never;
    // Both workers stall until they are simultaneously in flight; the 1.5s
    // escape keeps a serialization bug from hanging the suite (it would show
    // up as maxActive === 1 instead).
    let arrived = 0;
    let bothHere!: () => void;
    const gate = new Promise<void>((res) => (bothHere = res));
    const stall: WorkerSpec = async ({ id }) => {
      arrived++;
      if (arrived === 2) bothHere();
      await Promise.race([gate, new Promise((r) => setTimeout(r, 1500))]);
      writeFile(dir, `${id}.out`, "x");
      writeFile(dir, `${id}.verdict`, "pass");
    };
    const fake = makeFake(dir, { a: stall, b: stall }, {
      lanes: 1,
      modelRegistry: registry as never,
      modelGroups: { pair: ["q"] },
    });
    const workflow = wf(`
      version: 1
      name: fanned
      description: two group nodes share one model on two providers
      nodes:
        - id: a
          group: pair
          accept:
            files: [a.out]
        - id: b
          group: pair
          accept:
            files: [b.out]
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const summary = await run.run();
    expect(summary.outcome).toBe("succeeded");
    // Cap is 1 per provider: overlap only happens if the two nodes landed on
    // different lanes.
    expect(fake.maxActive()).toBe(2);
    const lanes = run.status().map((s) => fake.manager.taskLane(s.task!)!.provider).sort();
    expect(lanes).toEqual(["p1", "p2"]);
  });

  it("steering reaches the live worker turn", async () => {
    const dir = freshDir();
    let release!: () => void;
    const fake = makeFake(dir, {
      a: ({ dir: d }) =>
        new Promise((resolve) => {
          release = () => {
            writeFile(d, "a.verdict", "pass");
            resolve(undefined);
          };
        }),
    });
    const workflow = wf(`
      version: 1
      name: steer
      description: mid-run steering
      nodes:
        - id: a
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const runP = run.run();
    await settle(() => (fake.turns["a"] ?? 0) >= 1, "worker started");
    expect(run.steer("a", "hold on")).toBe(true);
    expect(fake.steered).toEqual(["hold on"]);
    expect(run.steer("nope", "x")).toBe(false);
    release();
    const summary = await runP;
    expect(summary.outcome).toBe("succeeded");
  });
});

describe("engine: judge gates", () => {
  it("judged node completes on a single provider lane (parked producer must not block its judge)", async () => {
    // Regression: parked tasks used to hold their lane while idle, so with
    // taskLanesPerProvider=1 the judge queued forever behind the parked
    // producer and the run stalled until the runtime cap burned the attempts.
    const dir = freshDir();
    const fake = makeFake(
      dir,
      {
        build: ({ dir: d }) => {
          writeFile(d, "out.txt", "solid");
          writeFile(d, "build.verdict", "pass");
        },
        gate: ({ dir: d }) => writeFile(d, "gate.verdict", "pass\nlooks good"),
      },
      { lanes: 1 },
    );
    const workflow = wf(`
      version: 1
      name: judgedlane
      description: judged node sharing one saturated lane
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
        - id: gate
          dependsOn: [build]
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const summary = await Promise.race([
      run.run(),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    expect(summary).not.toBeNull(); // null = stall (the deadlock this test guards)
    expect(summary!.outcome).toBe("succeeded");
    expect(summary!.states).toEqual({ build: "succeeded", gate: "succeeded" });
  });

  it("judge rejects once, producer warm-retries, judge passes", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      build: ({ dir: d, attempt }) => {
        writeFile(d, "out.txt", `attempt ${attempt}`);
        writeFile(d, "build.verdict", "pass");
      },
      gate: ({ dir: d, attempt }) => {
        if (attempt === 1) writeFile(d, "gate.verdict", "reject\nnot rigorous enough");
        else writeFile(d, "gate.verdict", "pass\nlooks solid");
      },
    });
    const workflow = wf(`
      version: 1
      name: judged
      description: producer with judge
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
            maxAttempts: 2
        - id: gate
          dependsOn: [build]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();

    expect(summary.outcome).toBe("succeeded");
    expect(summary.states).toEqual({ build: "succeeded", gate: "succeeded" });
    expect(fake.turns["build"]).toBe(2); // warm retry held the session
    expect(fake.prompts["build"]![1]).toContain("not rigorous enough");
    expect(fake.prompts["gate"]![0]).toContain("JUDGE node 'gate' for producer 'build'");
    const log = readLog(dir);
    expect(log.filter((e) => e.id === "gate" && e.state === "judged")).toHaveLength(2);
    expect(log.some((e) => e.id === "build" && e.state === "judging")).toBe(true);
  });

  it("spliced model-authored content rides untrusted parts; framing stays text", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      build: ({ dir: d }) => {
        writeFile(d, "out.txt", "artifact");
        writeFile(d, "build.verdict", "pass");
      },
      gate: ({ dir: d, attempt }) => {
        writeFile(d, "gate.verdict", attempt === 1 ? "reject\nPOISON-CRITIQUE" : "pass");
      },
    });
    const workflow = wf(`
      version: 1
      name: splice-boundary
      description: untrusted splices
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
            maxAttempts: 2
        - id: gate
          dependsOn: [build]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.outcome).toBe("succeeded");

    // build's warm retry: the judge's verdict note and build's own summary
    // are model-authored -> untrusted parts; engine framing stays text.
    const raw = fake.rawPrompts["build"]![1];
    expect(Array.isArray(raw)).toBe(true);
    const parts = raw as Array<Record<string, unknown>>;
    const untrusted = parts.filter((p) => p.type === "untrusted").map((p) => String(p.text));
    expect(untrusted.some((t) => t.includes("POISON-CRITIQUE"))).toBe(true);
    expect(untrusted.some((t) => t.includes("build pointer-summary"))).toBe(true);
    const trusted = parts.filter((p) => p.type === "text").map((p) => String(p.text)).join("\n");
    expect(trusted).toContain("not accepted");
    expect(trusted).not.toContain("POISON-CRITIQUE");

    // The judge prompt carries the producer's summary as an untrusted part.
    const judgeRaw = fake.rawPrompts["gate"]![0] as Array<Record<string, unknown>>;
    expect(Array.isArray(judgeRaw)).toBe(true);
    expect(
      judgeRaw.some((p) => p.type === "untrusted" && String(p.text).includes("build pointer-summary")),
    ).toBe(true);
  });

  it("upstream pointer summaries arrive untrusted in the downstream prompt", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      a: good({ "out.txt": "x" }),
      b: good({ "result.txt": "y" }),
    });
    const workflow = wf(`
      version: 1
      name: linear-untrusted
      description: a then b
      nodes:
        - id: a
          accept:
            files: [out.txt]
        - id: b
          dependsOn: [a]
          accept:
            files: [result.txt]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.outcome).toBe("succeeded");
    const raw = fake.rawPrompts["b"]![0] as Array<Record<string, unknown>>;
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.some((p) => p.type === "untrusted" && String(p.text).includes("a pointer-summary"))).toBe(true);
    // The engine's own pointer lines (ids, verdict enum, paths) stay trusted text.
    expect(
      raw.some((p) => p.type === "text" && String(p.text).includes("node 'a': verdict pass")),
    ).toBe(true);
  });

  it("judge verdict 'reject' with retryOn [fail] fails the producer immediately", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      build: ({ dir: d }) => {
        writeFile(d, "out.txt", "x");
        writeFile(d, "build.verdict", "pass");
      },
      gate: ({ dir: d }) => writeFile(d, "gate.verdict", "reject\nnope"),
    });
    const workflow = wf(`
      version: 1
      name: rejectfast
      description: reject not in retryOn
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
            retryOn: [fail]
            maxAttempts: 2
        - id: gate
          dependsOn: [build]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.build).toBe("failed");
    expect(fake.turns["build"]).toBe(1);
    // The judge did its job (delivered a verdict) even though the producer failed.
    expect(summary.states.gate).toBe("succeeded");
  });

  it("judge infra failure blocks the producer (recovery = reconcile/re-run)", async () => {
    const dir = freshDir();
    const fake = makeFake(dir, {
      build: ({ dir: d }) => {
        writeFile(d, "out.txt", "x");
        writeFile(d, "build.verdict", "pass");
      },
      gate: () => {
        throw new Error("judge llm down");
      },
    });
    const workflow = wf(`
      version: 1
      name: judgebreak
      description: judge keeps crashing
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
        - id: gate
          dependsOn: [build]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager }).run();
    expect(summary.states.build).toBe("blocked");
    expect(summary.states.gate).toBe("failed");
    expect(fake.manager.activeTasks()).toEqual([]); // judge task released, not parked forever
  });

  it("judge awaits its non-owner dependencies before running (W-1 regression)", async () => {
    // Before the fix the judge spawned the instant its producer passed the file
    // gate, without awaiting the judge's own declared sibling dependency. It
    // could then read a missing or mid-write output. The judge must wait for
    // every non-owner dependency to settle first (the gated owner must not be
    // awaited, since its own settled will not resolve until after this judge).
    const dir = freshDir();
    let releaseSpec!: () => void;
    const specHeld = new Promise<void>((r) => {
      releaseSpec = r;
    });
    const specSeenByJudge: boolean[] = [];
    const fake = makeFake(
      dir,
      {
        build: ({ dir: d }) => {
          writeFile(d, "out.txt", "solid");
          writeFile(d, "build.verdict", "pass");
        },
        spec: async ({ dir: d }) => {
          await specHeld; // slow, independent sibling the judge depends on
          writeFile(d, "spec.txt", "evidence");
          writeFile(d, "spec.verdict", "pass");
        },
        gate: ({ dir: d }) => {
          let exists = false;
          try {
            exists = readFileSync(join(d, "spec.txt")).length > 0;
          } catch {
            exists = false;
          }
          specSeenByJudge.push(exists);
          writeFile(d, "gate.verdict", "pass\nlooks good");
        },
      },
      { lanes: 2 },
    );
    const workflow = wf(`
      version: 1
      name: judgedeps
      description: judge must await its sibling dependency
      nodes:
        - id: build
          accept:
            files: [out.txt]
            judge: gate
        - id: spec
          accept:
            files: [spec.txt]
        - id: gate
          dependsOn: [build, spec]
    `);
    const run = new WorkflowRun({ workflow, runId: "r", runDir: dir, tasks: fake.manager });
    const runP = Promise.race([
      run.run(),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    // build is fast; spec is held. Once spec is running the judge must still
    // be waiting on it (with no await, gate would already have run).
    await settle(() => (fake.turns["spec"] ?? 0) >= 1, "spec running");
    expect(fake.turns["gate"] ?? 0).toBe(0);
    // Hold the window open: without the engine's dep-await, the pre-fix judge
    // spawn chain (completeTask -> handle.done -> stat gate -> spawnTask)
    // completes within this stretch and the judge runs against a missing
    // spec.txt, making the assertions below non-vacuous.
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.turns["gate"] ?? 0).toBe(0);
    // Release spec; the judge may now run and must see spec's output.
    releaseSpec();
    const summary = await runP;
    expect(summary).not.toBeNull();
    expect(summary!.outcome).toBe("succeeded");
    expect(summary!.states).toEqual({ build: "succeeded", spec: "succeeded", gate: "succeeded" });
    // The judge observed spec.txt exactly once and it existed.
    expect(specSeenByJudge).toEqual([true]);
  });
});

describe("engine: run log, reconcile & resume", () => {
  async function completedRun(dir: string): Promise<Fake> {
    const fake = makeFake(dir, {
      a: good({ "a.txt": "alpha" }),
      b: good({ "b.txt": "beta" }),
    });
    const workflow = wf(`
      version: 1
      name: two
      description: a then b
      nodes:
        - id: a
          accept:
            files: [a.txt]
        - id: b
          dependsOn: [a]
          accept:
            files: [b.txt]
    `);
    const summary = await new WorkflowRun({ workflow, runId: "r1", runDir: dir, tasks: fake.manager }).run();
    expect(summary.outcome).toBe("succeeded");
    return fake;
  }

  const twoGraph = () =>
    wf(`
      version: 1
      name: two
      description: a then b
      nodes:
        - id: a
          accept:
            files: [a.txt]
        - id: b
          dependsOn: [a]
          accept:
            files: [b.txt]
    `);

  it("reconcile validates intact claims and flags modified ones", async () => {
    const dir = freshDir();
    await completedRun(dir);

    let report = await reconcileRun(dir);
    expect(report.workflow).toBe("two");
    expect(report.valid.sort()).toEqual(["a", "b"]);
    expect(report.invalid).toEqual([]);
    expect(report.incomplete).toEqual([]);

    // b's output modified after the fact -> claim no longer matches.
    truncateSync(join(dir, "b.txt"), 2);
    report = await reconcileRun(dir);
    expect(report.valid).toEqual(["a"]);
    expect(report.invalid).toEqual(["b"]);

    // a modified -> cascade invalidates b's input match too.
    writeFile(dir, "a.txt", "totally different");
    report = await reconcileRun(dir);
    expect(report.valid).toEqual([]);
    expect(report.invalid.sort()).toEqual(["a", "b"]);
  });

  it("resume reuses valid claims and executes only the rest", async () => {
    const dir = freshDir();
    await completedRun(dir);
    writeFile(dir, "b.txt", "tampered with"); // invalidate b only

    const fake = makeFake(dir, {
      a: good({ "a.txt": "should-not-run" }),
      b: good({ "b.txt": "rerun" }),
    });
    const summary = await new WorkflowRun({ workflow: twoGraph(), runId: "r2", runDir: dir, tasks: fake.manager }).run();
    expect(summary.outcome).toBe("succeeded");
    expect(fake.turns["a"]).toBeUndefined(); // reused, never re-executed
    expect(fake.turns["b"]).toBe(1);
    const log = readLog(dir);
    const resumed = log.find((e) => e.ev === "resumed");
    expect(resumed).toBeTruthy();
    expect(resumed!.valid).toEqual(["a"]);
    expect(fake.manager.activeTasks()).toEqual([]);
  });

  it("resume refuses a different workflow in the same dir", async () => {
    const dir = freshDir();
    await completedRun(dir);
    const other = wf(`
      version: 1
      name: other
      description: different workflow
      nodes:
        - id: a
    `);
    const fake = makeFake(dir, {});
    expect(
      new WorkflowRun({ workflow: other, runId: "r", runDir: dir, tasks: fake.manager }).run(),
    ).rejects.toThrow("holds workflow 'two'");
  });
});
