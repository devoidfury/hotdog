// A task/worker turn that ends via a stopLoop tool (e.g. handoff) must
// deliver that tool's CONTENT to the delegating manager. The bug: the
// manager received "Task completed via tool return: return" -- the bare
// executor outcome word, never the stopping tool's result.

import { describe, it, expect } from "bun:test";
import { TaskManager } from "@core/session/task-manager.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import { ToolResult } from "@core/extensions/tool-utils.ts";
import { toolContentText } from "@utils/tool-content.ts";
import {
  MockLLMClient,
  MockTool,
  buildStreamResponse,
  createFixture,
} from "../helpers.ts";
import { expectToolReturn } from "../test-helpers.ts";

// Poll until a condition holds (task-manager.test.ts idiom: fixed sleeps
// are racy under parallel load).
async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A worker Agent whose one and only turn ends by calling `stopTool`. */
function stoppingAgent(stopTool: MockTool) {
  const mockLLM = new MockLLMClient({
    responseSequences: [
      buildStreamResponse({
        content: "",
        toolCalls: [{ index: 0, name: stopTool.name, arguments: "{}", id: "call_stop_1" }],
      }),
    ],
  });
  const { agent, toolRegistry } = createFixture({ mockLLM });
  toolRegistry.register(stopTool.name, stopTool);
  return agent;
}

/**
 * The same agent wrapped for TaskManager: the run is the REAL Agent.run
 * (the producer under test); notifyCompletion captures the manager-visible
 * string (finalizeTurn delivers the turn result through it).
 */
function stoppingWorker(stopTool: MockTool, delivered: (r: string) => void) {
  const agent = stoppingAgent(stopTool);
  return {
    run: (prompt: unknown, images?: unknown, opts?: unknown) =>
      (agent as any).run(prompt, images, opts),
    notifyCompletion: (r: string) => delivered(r),
  };
}

function managerFor(agent: Record<string, unknown>) {
  return new TaskManager({
    buildAgent: async () => agent as any,
    modelRegistry: {} as any,
    config: {} as any,
    maxIterations: 100,
    taskProfile: "default",
  });
}

describe("task delivery of a stopLoop tool's content", () => {
  it("the tool_return RunResult carries the stopping tool's content", async () => {
    const agent = stoppingAgent(
      new MockTool({
        name: "handoff",
        execute: async () => ToolResult.stop("Plan: ship the parser, then docs. Decision: keep the wire stable."),
      }),
    );

    const result = await agent.run("work it");

    const toolReturn = expectToolReturn(result);
    expect(toolReturn.outcome).toBe("return");
    expect(toolContentText(toolReturn.content)).toContain("ship the parser");
  });

  it("delegating manager receives the summary, not the bare word 'return'", async () => {
    let delivered = "";
    const manager = managerFor(
      stoppingWorker(
        new MockTool({
          name: "handoff",
          execute: async () => ToolResult.stop("Handoff summary: parser shipped; next phase is docs."),
        }),
        (r) => { delivered = r; },
      ),
    );

    await manager.spawnTask("t-handoff", "work");
    await settle(() => manager.taskStatus("t-handoff") === TASK_STATUS.COMPLETED, "t-handoff -> COMPLETED");

    expect(delivered).toContain("parser shipped; next phase is docs.");
    expect(delivered).not.toBe("Task completed via tool return: return");
  });

  it("stopLoop with EMPTY content keeps the old fallback string", async () => {
    let delivered = "";
    const manager = managerFor(
      stoppingWorker(
        new MockTool({
          name: "wait",
          execute: async () => ToolResult.stop(""),
        }),
        (r) => { delivered = r; },
      ),
    );

    await manager.spawnTask("t-empty", "work");
    await settle(() => manager.taskStatus("t-empty") === TASK_STATUS.COMPLETED, "t-empty -> COMPLETED");

    expect(delivered).toBe("Task completed via tool return: return");
  });
});
