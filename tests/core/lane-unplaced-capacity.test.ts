// Unplaced-spawn capacity bypass (bug regression suite).
//
// Reported: provider lanes at 1 per lane, yet ai365 ran two concurrent
// runloops. Root mechanism: a spawn whose model chain resolves to nothing
// lands LOCKED on the phantom bare-name lane keyed "", whose cap came out of
// makeLaneCaps as the global fallback (unlimited when no global numeric cap
// is configured) -- so unplaced tasks never took a slot on the provider their
// traffic actually hits, bypassing per-provider taskLanes entirely.
//
// Fixes under test:
//  A. parent-model chain: workflow-engine spawns carry the delegating
//     session's model (parentModel), delegate_task passes it directly, and the
//     TaskManager falls back to the resolved build-default model -- so the
//     chain resolves onto a REAL lane in practice.
//  B. capOf("") never silently unlimiteds when finite per-provider overrides
//     exist (conservative min), so the residual phantom lane is capped.

import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "@core/session/task-manager.ts";
import { makeLaneCaps } from "@core/session/model-resolver.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { RunRegistry, WorkflowDispatchTool } from "@extensions/workflows/workflow-tools.ts";

async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeManager(
  opts: {
    lanes?: number;
    providers?: Array<Record<string, unknown>>;
    registry?: Record<string, unknown>;
    defaultModel?: string | null;
  } = {},
) {
  const runs: Array<{ model: string; release: () => void }> = [];
  const manager = new TaskManager({
    buildAgent: async (cfg: Record<string, unknown>) => {
      let release!: () => void;
      runs.push({
        model: String((cfg as Record<string, unknown>).model ?? ""),
        release: () => release(),
      });
      return {
        run: () => new Promise<void>((resolve) => { release = resolve; }),
        notifyCompletion: () => {},
      } as never;
    },
    modelRegistry: (opts.registry ?? {}) as never,
    config: { providers: opts.providers ?? [] } as never,
    maxIterations: 100,
    taskProfile: "default",
    lanesPerProvider: opts.lanes,
    defaultModel: opts.defaultModel,
  } as never);
  return { manager, runs };
}

describe("phantom ''-lane capacity (conservative fallback cap)", () => {
  it("makeLaneCaps: capOf('') takes the min of finite per-provider overrides when the global cap is absent", () => {
    const caps = makeLaneCaps(undefined, [{ name: "ai365", taskLanes: 1 }, { name: "pB", taskLanes: 3 }]);
    expect(caps.capOf("ai365")).toBe(1);
    expect(caps.capOf("pB")).toBe(3);
    // Providers with no def stay unlimited: an override never constrains a
    // KNOWN-but-uncapped provider...
    expect(caps.capOf("pC")).toBe(Number.POSITIVE_INFINITY);
    // ...but the phantom bare-name lane always carries capped-provider traffic.
    expect(caps.capOf("")).toBe(1);
  });

  it("makeLaneCaps: unlimited when nothing is capped; global cap still bounds '' when lower", () => {
    expect(makeLaneCaps(undefined, []).capOf("")).toBe(Number.POSITIVE_INFINITY);
    expect(makeLaneCaps(0, []).capOf("")).toBe(Number.POSITIVE_INFINITY);
    // taskLanes below 1 normalizes to unlimited: it must not drag '' down.
    expect(makeLaneCaps(undefined, [{ name: "pA", taskLanes: 0 }]).capOf("")).toBe(
      Number.POSITIVE_INFINITY,
    );
    // Global cap stays the ceiling; the conservative '' cap is the min.
    expect(makeLaneCaps(4, [{ name: "pA", taskLanes: 2 }]).capOf("")).toBe(2);
    expect(makeLaneCaps(1, [{ name: "pA", taskLanes: 5 }]).capOf("")).toBe(1);
  });

  it("two unplaced tasks never run concurrently when a provider lane caps at 1 and the global cap is unlimited", async () => {
    const { manager, runs } = makeManager({
      lanes: 0, // global unlimited
      providers: [{ name: "ai365", taskLanes: 1 }],
    });
    await manager.spawnTask("t1", "a", {} as never);
    await manager.spawnTask("t2", "b", {} as never);
    await settle(() => manager.taskStatus("t1") === "running", "first unplaced task runs");
    // Grace period for the (buggy) second start on the unlimited phantom lane.
    await new Promise((r) => setTimeout(r, 50));
    // BUG (pre-fix): t2 started immediately, concurrently with t1.
    expect(manager.taskStatus("t2")).toBe("queued");
    expect(runs.length).toBe(1);

    runs[0]!.release();
    await settle(() => manager.taskStatus("t1") === "completed", "t1 done");
    await settle(() => manager.taskStatus("t2") === "running", "t2 admitted after release");
    runs[1]!.release();
  });
});

describe("build-default model placement (no more phantom lane when a default exists)", () => {
  it("a modelless spawn resolves onto the build default's REAL provider lane and queues behind its cap", async () => {
    const { manager, runs } = makeManager({
      lanes: 0, // global unlimited; ai365 capped at 1 via its provider def
      providers: [{ name: "ai365", taskLanes: 1 }],
      registry: { "ai365/qwen": { name: "ai365/qwen", contextLimit: 8192 } },
      defaultModel: "ai365/qwen",
    });
    await manager.spawnTask("t1", "a", { workerModel: "ai365/qwen" } as never);
    await settle(() => runs.length === 1, "placed task running on ai365");

    // Modelless spawn: with the build default known it must lock onto the
    // ai365 lane and QUEUE, not run unplaced on the phantom "" lane.
    await manager.spawnTask("t2", "b", {} as never);
    expect(manager.taskStatus("t2")).toBe("queued");
    expect(runs.length).toBe(1); // BUG (pre-fix): second build against ai365 starts anyway
    expect(manager.taskLane("t2")!.provider).toBe("ai365");

    runs[0]!.release();
    await settle(() => manager.taskStatus("t2") === "running", "t2 admitted once ai365 frees");
    expect(runs[1]!.model).toBe("ai365/qwen");
    runs[1]!.release();
  });
});

describe("parentModel spawn option (chain default without a session lookup)", () => {
  it("parentModel supplies the chain default when no managerAgent/sessionManager is wired", async () => {
    const { manager, runs } = makeManager({
      lanes: 1,
      registry: { "n9/solo": { name: "n9/solo", contextLimit: 8192 } },
    });
    await manager.spawnTask("t1", "a", { parentModel: "n9/solo" } as never);
    await settle(() => runs.length === 1, "task placed");
    // BUG (pre-fix): parentModel ignored -> chain collapses to "", the task
    // builds with an empty model and sits on the phantom lane.
    expect(runs[0]!.model).toBe("n9/solo");
    expect(manager.taskLane("t1")!.provider).toBe("n9");
    runs[0]!.release();
  });
});

// ---------------------------------------------------------------------------
// Workflow engine seam: parked node spawns never carried a managerAgent, so
// the session-store chain lookup could not resolve -- the delegating model
// must ride the run config (parentModel) instead.
// ---------------------------------------------------------------------------

const GRAPH = `
version: 1
name: inherit
description: single node, no pin/group -- chain default must resolve
nodes:
  - id: a
    accept:
      files: [a.out]
`;

describe("workflow node inherits the dispatching session's model", () => {
  it("a node without pin/group builds with a real catalog model, never the empty string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lanes-inherit-"));
    const runsRoot = join(dir, "runs");
    await mkdir(runsRoot, { recursive: true });
    const graphFile = join(dir, "inherit.workflow.yaml");
    await writeFile(graphFile, GRAPH);
    const runDir = join(runsRoot, "inh-1");

    const built: string[] = [];
    const tasks = new TaskManager({
      buildAgent: async (config: Record<string, unknown>) => {
        built.push(String(config.model ?? ""));
        return {
          run: async () => {
            await writeFile(join(runDir, "a.out"), "artifact");
            await writeFile(join(runDir, "a.verdict"), "pass\n");
            return { type: "completion", content: "done" };
          },
          notifyCompletion: () => {},
        } as never;
      },
      modelRegistry: { "pA/m": {}, "pB/m": {} } as never,
      config: { providers: [{ name: "pA" }, { name: "pB" }] } as never,
      maxIterations: 5,
      taskProfile: "default",
      lanesPerProvider: 1,
      lanesDir: join(dir, "lanes"),
      lanesRetryMs: 25,
      runningPeek: async () => new Set<string>(),
    } as never);

    const tool = new WorkflowDispatchTool({
      taskManagerProvider: () => tasks,
      getRunsRoot: () => runsRoot,
      getWorkflowsDir: () => dir,
      limits: {},
      registry: new RunRegistry(),
    });
    const ctx = new ToolContext({
      agent: { sessionId: "mgr", model: "pB/m" },
    });

    const result = await tool.execute({ file: graphFile, run_id: "inh-1" }, ctx as never);
    expect(result.error).toBeNull();
    expect(result.output).toContain("run inh-1 dispatched");

    await settle(() => built.length === 1, "node task builds");
    // BUG (pre-fix): "" -- unplaced on the phantom lane; the manager's model
    // ("pB/m") never reached the spawn. Post-fix the chain fans the name
    // across catalog providers, cold order picks pA first.
    expect(built[0]).toBe("pA/m");

    await rm(dir, { recursive: true, force: true });
  });
});
