// Scenario: 2 providers x 1 lane each. A manager session turn on pA
// dispatches a workflow with three parallel nodes (group fanout across pA/pB).
// While the manager turn is live, only ONE node runs (on the open pB lane);
// when the manager produces its final result, its lane must free so a second
// node starts; as nodes finish the third runs; when the run resolves, the
// completion message wakes the manager into a new turn on a freed lane.

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "@core/session/message-bus.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { contentToText } from "@core/context/message.ts";
import { RunRegistry, WorkflowDispatchTool } from "@extensions/workflows/workflow-tools.ts";

async function settle(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function slotCount(lanesDir: string, lane: string): Promise<number> {
  try {
    const names = await readdir(join(lanesDir, lane));
    return names.filter((n) => n.startsWith("slot-")).length;
  } catch {
    return 0;
  }
}

const YAML = `
version: 1
name: fanout
description: three parallel nodes across two providers
nodes:
  - id: a
    group: two
    accept:
      files: [a.out]
  - id: b
    group: two
    accept:
      files: [b.out]
  - id: c
    group: two
    accept:
      files: [c.out]
`;

interface WorkerTurn {
  id: string;
  provider: string;
  finish: () => void;
}

describe("manager + workflow lane scenario (2 providers, cap 1)", () => {
  it("dispatch holds one lane, manager release frees it for the second node, wake turn runs after resolution", async () => {
    const lanesDir = await mkdtemp(join(tmpdir(), "lanes-scenario-"));
    const runsRoot = join(lanesDir, "runs");
    await mkdir(runsRoot, { recursive: true });

    const turns = new Set<WorkerTurn>();
    const doneTurns: WorkerTurn[] = [];

    const tasks = new TaskManager({
      buildAgent: async (config: Record<string, unknown>) => {
        const model = String(config.model ?? "");
        const agent: any = {
          run: async (input: string | Array<Record<string, unknown>>) => {
            const id = /node '([a-z0-9][a-z0-9-]*)'/.exec(contentToText(input))?.[1] ?? "?";
            let finish!: () => void;
            const gate = new Promise<void>((res) => (finish = res));
            const turn: WorkerTurn = { id, provider: model.split("/")[0]!, finish };
            turns.add(turn);
            await gate;
            turns.delete(turn);
            doneTurns.push(turn);
            // Satisfy the node gate: declared output + pass verdict, written
            // at turn end (inside the held slot, like a real worker saving).
            const runDir = join(runsRoot, "fanout-1");
            await writeFile(join(runDir, `${id}.out`), `${id} artifact`);
            await writeFile(join(runDir, `${id}.verdict`), "pass\n");
            return { type: "completion", content: `${id} pointer-summary` };
          },
          notifyCompletion: () => {},
          hooks: undefined,
        };
        return agent;
      },
      modelRegistry: { "pA/m": {}, "pB/m": {} } as never,
      config: {
        providers: [{ name: "pA" }, { name: "pB" }],
        modelGroups: { two: ["m"] },
      } as never,
      maxIterations: 5,
      taskProfile: "default",
      lanesPerProvider: 1,
      lanesDir,
      lanesRetryMs: 25,
      runningPeek: async () => new Set<string>(),
    });

    const lanes = createTurnLanes({
      lanesDir,
      lanesPerProvider: 1,
      providerDefs: [{ name: "pA" }, { name: "pB" }],
      lanesRetryMs: 25,
    });

    // Manager agent: turn 1 dispatches the workflow, then final-answers when
    // the test says so. Later turns (the wake) gate the same way.
    const tool = new WorkflowDispatchTool({
      taskManagerProvider: () => tasks,
      getRunsRoot: () => runsRoot,
      getWorkflowsDir: () => null,
      limits: {},
      registry: new RunRegistry(),
    });
    const ctx = new ToolContext({ agent: { sessionId: "mgr" } });

    let turnCount = 0;
    let dispatchError: unknown = null;
    const gates: Array<() => void> = [];
    const agent: any = {
      sessionId: "mgr",
      model: "pA/m",
      hooks: { runHookPipeline: async (_n: string, d: unknown) => d },
      run: async () => {
        turnCount++;
        if (turnCount === 1) {
          // Dispatch WHILE holding the pA turn slot.
          try {
            await tool.execute({ yaml: YAML, run_id: "fanout-1" }, ctx as never);
          } catch (e) {
            dispatchError = e;
          }
        }
        await new Promise<void>((res) => gates.push(res));
        return { type: "completion", content: `manager turn ${turnCount}` };
      },
      resetCancel: () => {},
      cancel: () => {},
      executeCommand: async () => null,
    };
    const finishTurn = () => gates.shift()!();

    const bus = new MessageBus({
      sessionManager: { getAgent: () => agent },
      sink: { emit: () => {} },
      lanes,
    });
    tasks.setSessionManager({
      getAgent: () => agent,
      getBus: (sid: string) => (sid === "mgr" ? bus : undefined),
    });

    void bus.run();
    bus.enqueue("dispatch the fanout workflow");

    // Turn 1 runs and holds exactly the pA slot.
    await settle(() => turnCount === 1, "manager turn 1 starts");
    expect(dispatchError).toBeNull();
    expect(await slotCount(lanesDir, "pA")).toBe(1);

    // With pA held by the manager, only one node can run, and it is on pB.
    await settle(() => turns.size === 1, "first node starts on the open provider");
    expect([...turns][0]!.provider).toBe("pB");
    expect(await slotCount(lanesDir, "pA")).toBe(1);
    expect(await slotCount(lanesDir, "pB")).toBe(1);

    // Manager final answer: the pA lane frees, second node starts on pA.
    finishTurn();
    await settle(() => turns.size === 2, "second node starts once the manager releases pA");
    expect([...turns].map((t) => t.provider).sort()).toEqual(["pA", "pB"]);
    // The idle manager holds nothing while the run continues: the pA slot
    // must exist again promptly, held by the node, not the session.
    const paHeldDeadline = Date.now() + 2000;
    let paHeld = await slotCount(lanesDir, "pA");
    while (paHeld !== 1) {
      if (Date.now() > paHeldDeadline) throw new Error(`pA lane not held by the running node (count=${paHeld})`);
      await new Promise((r) => setTimeout(r, 5));
      paHeld = await slotCount(lanesDir, "pA");
    }

    // Free a lane: the third node must start (never starved).
    [...turns][0]!.finish();
    await settle(() => turns.size === 2 && doneTurns.length === 1, "third node takes the freed lane");
    expect(new Set([...turns].map((t) => t.provider))).toEqual(new Set(["pA", "pB"]));

    // All three finish -> the run resolves and the wake turn starts.
    for (const t of [...turns]) t.finish();
    await settle(() => doneTurns.length === 3, "all node turns finish");
    await settle(() => turnCount === 2, "manager wakes after the run resolves");

    // The wake turn holds a lane again; finishing it leaves the ledger clean.
    expect(await slotCount(lanesDir, "pA")).toBe(1);
    finishTurn();
    const cleanDeadline = Date.now() + 3000;
    for (;;) {
      if ((await slotCount(lanesDir, "pA")) === 0 && (await slotCount(lanesDir, "pB")) === 0) break;
      if (Date.now() > cleanDeadline) throw new Error("timed out waiting for a clean ledger");
      await new Promise((r) => setTimeout(r, 5));
    }
    bus.cancel();
    await rm(lanesDir, { recursive: true, force: true });
  }, 15000);
});
