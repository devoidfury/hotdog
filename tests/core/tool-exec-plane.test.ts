// Tool-executor plane fork with a FAKE link -- no spawned
// processes (real-spawn coverage lives in tool-exec-broker-spawn.test.ts).
// Also covers toolExecPlaneSettings/toolExecModeLabel and the pilot tags.

import { describe, it, expect } from "bun:test";
import { createToolExecutor, type ToolExecutorDeps } from "@core/tool-executor.ts";
import { Agent } from "@core/agent.ts";
import { createToolRegistry, type Tool, type ToolDef } from "@core/extensions/tool-registry.ts";
import { createHooks } from "@core/hooks.ts";
import { Message } from "@core/context/message.ts";
import { TransientError } from "@core/error.ts";
import { ToolResult } from "@core/extensions/tool-utils.ts";
import {
  serializeToolResult,
  serializeWireError,
  reviveWireError,
  type ToolExecLink,
  type WireToolResult,
} from "@core/tool-exec-protocol.ts";
import {
  postureDrift,
  sharedToolExecBroker,
  toolExecPlaneSettings,
  toolExecModeLabel,
} from "@core/tool-exec-broker.ts";
import { BashTool } from "@extensions/bash-tool/index.ts";
import { ReadTool } from "@extensions/core-tools/read.ts";
import { GrepTool } from "@extensions/core-tools/grep.ts";
import { toolContentText } from "@utils/tool-content.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTool(name: string, execute: Tool["execute"], execution?: "local" | "worker"): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1, ...(execution ? { execution } : {}) },
    toToolDef: (): ToolDef => ({
      type: "function",
      function: { name, description: "test tool", parameters: { type: "object", properties: {}, required: [] } },
    }),
    execute,
  };
}

interface FakeLink extends ToolExecLink {
  calls: Array<{ session: string; tool: string; args: unknown; ctx: unknown; toolCallId?: string }>;
  responses: Array<() => Promise<WireToolResult>>;
}

function fakeLink(...responders: Array<() => Promise<WireToolResult>>): FakeLink {
  const link: FakeLink = {
    calls: [],
    responses: [...responders],
    async invoke(req) {
      link.calls.push({
        session: req.session,
        tool: req.tool,
        args: req.args,
        ctx: req.ctx,
        toolCallId: req.toolCallId,
      });
      const next = link.responses.shift();
      if (!next) throw new Error("fake link: no scripted response");
      return next();
    },
    async close() {},
  };
  return link;
}

function setup(tools: Tool[], plane: Partial<ToolExecutorDeps>) {
  const toolRegistry = createToolRegistry();
  for (const t of tools) {
    const def = t.toToolDef() as ToolDef;
    toolRegistry.register(def.function.name, t);
  }
  const addedMessages: Message[] = [];
  const agent = {
    sessionId: "sess-42",
    addMessage: (m: Message) => { addedMessages.push(m); },
    getToolDefs: async (): Promise<ToolDef[]> =>
      Array.from(toolRegistry.getAll()).map(([n]) => ({
        type: "function",
        function: { name: n, description: "d", parameters: { type: "object", properties: {}, required: [] } },
      })),
  } as unknown as ToolExecutorDeps["agent"];

  const deps: ToolExecutorDeps = {
    toolRegistry,
    hooks: createHooks(),
    emitOutput: () => {},
    workspaceRoots: ["/srv/proj", "/srv/extra"],
    workspaceDeny: [".env*"],
    maxRetries: 1,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent,
    ...plane,
  };
  return { executor: createToolExecutor(deps), addedMessages };
}

const call = (toolName: string, args = "{}") => ({
  id: `call-${toolName}`,
  type: "function" as const,
  function: { name: toolName, arguments: args },
});

const okText = (t: string) => async () => serializeToolResult(ToolResult.ok(t));

// ── Fork behavior ────────────────────────────────────────────────────────────

describe("ToolExecutor plane fork", () => {
  it("routes worker-tagged tools through the link, not the local tool", async () => {
    let localRan = false;
    const link = fakeLink(okText("pong"));
    const { executor, addedMessages } = setup(
      [makeTool("planned", async () => { localRan = true; return "local"; }, "worker")],
      { toolExec: "worker", toolExecLink: link, toolExecConfig: { coreTools: { readToolLimit: 7 } } },
    );

    const { outcome, toolResults } = await executor.execute([call("planned", '{"x":1}')]);
    expect(outcome).toBe("continue");
    expect(localRan).toBe(false);
    expect(link.calls).toHaveLength(1);
    expect(toolContentText(toolResults[0]!.content)).toContain("pong");
    expect(addedMessages).toHaveLength(1);
  });

  it("marshals the per-call ctx: session, workspace roots + deny, tool config", async () => {
    const link = fakeLink(okText("ok"));
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      { toolExec: "worker", toolExecLink: link, toolExecConfig: { bashTool: { bashTimeoutMs: 1234 } } },
    );
    await executor.execute([call("planned")]);
    const ctx = link.calls[0]!.ctx as Record<string, unknown>;
    expect(ctx).toEqual({
      session: "sess-42",
      workspace: { roots: ["/srv/proj", "/srv/extra"], deny: [".env*"] },
      toolConfig: { bashTool: { bashTimeoutMs: 1234 } },
    });
  });

  it("keeps untagged tools inline even with the plane on", async () => {
    let localRan = false;
    const link = fakeLink();
    const { executor } = setup(
      [makeTool("inliney", async () => { localRan = true; return ToolResult.ok("local"); })],
      { toolExec: "worker", toolExecLink: link },
    );
    const { toolResults } = await executor.execute([call("inliney")]);
    expect(localRan).toBe(true);
    expect(link.calls).toHaveLength(0);
    expect(toolContentText(toolResults[0]!.content)).toContain("local");
  });

  it("inline mode never touches the link even for tagged tools", async () => {
    let localRan = false;
    const link = fakeLink();
    const { executor } = setup(
      [makeTool("planned", async () => { localRan = true; return ToolResult.ok("local"); }, "worker")],
      { toolExec: "inline", toolExecLink: link },
    );
    await executor.execute([call("planned")]);
    expect(localRan).toBe(true);
    expect(link.calls).toHaveLength(0);
  });

  it("carries the model's tool call id to the link (output attribution on the runner)", async () => {
    const link = fakeLink(okText("ok"));
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      { toolExec: "worker", toolExecLink: link },
    );
    await executor.execute([call("planned")]);
    // The transcript call id, not the wire/cancel correlation id: a tool
    // emitting output events on the runner must key them to the visible call.
    expect(link.calls[0]!.toolCallId).toBe("call-planned");
  });

  it("a link failure becomes an error tool result (no inline downgrade)", async () => {
    let localRan = false;
    const link: FakeLink = {
      calls: [],
      responses: [],
      invoke: async () => { throw new Error("broker worker exited (code 1)"); },
      close: async () => {},
    };
    const { executor } = setup(
      [makeTool("planned", async () => { localRan = true; return "local"; }, "worker")],
      // maxRetries 0 so the TransientError retry budget stays out of the way.
      { toolExec: "worker", toolExecLink: link },
    );
    const { toolResults } = await executor.execute([call("planned")]);
    expect(localRan).toBe(false);
    const part = toolContentText(toolResults[0]!.content);
    expect(part).toContain("Error executing tool planned");
    expect(part).toContain("broker worker exited");
  });

  it("revives TransientError across the wire so the retry loop retries", async () => {
    let localRuns = 0;
    // The failure crosses the wire as bytes and comes back revived, exactly
    // like the real broker's fail frame -> reviveWireError path.
    const wireTransient = serializeWireError(new TransientError("flaky"));
    const link = fakeLink(
      async () => {
        throw reviveWireError(wireTransient);
      },
      okText("second try"),
    );
    const { executor } = setup(
      [makeTool("planned", async () => { localRuns++; return "local"; }, "worker")],
      { toolExec: "worker", toolExecLink: link, maxRetries: 1 },
    );
    const { toolResults } = await executor.execute([call("planned")]);
    expect(localRuns).toBe(0);
    expect(link.calls).toHaveLength(2);
    expect(toolContentText(toolResults[0]!.content)).toContain("second try");
  });

  it("revives the stop-loop sentinel", async () => {
    const link = fakeLink(async () => serializeToolResult(ToolResult.stop("halting")));
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      { toolExec: "worker", toolExecLink: link },
    );
    const { outcome, toolResults } = await executor.execute([call("planned")]);
    expect(outcome).toBe("return");
    expect(toolResults[0]!.stopLoop).toBe(true);
  });
});

// ── Config-surface validation ─────────────────────────────────────

describe("toolExecPlaneSettings", () => {
  it("treats unset as inline (hosts without the plane) and validates values loudly", () => {
    expect(toolExecPlaneSettings({})).toEqual({ mode: "inline", fence: "probe" });
    expect(toolExecPlaneSettings({ toolExec: "worker", execFence: "off" })).toEqual({
      mode: "worker",
      fence: "off",
    });
    expect(() => toolExecPlaneSettings({ toolExec: "workers" })).toThrow(/toolExec/);
    expect(() => toolExecPlaneSettings({ execFence: "require" })).toThrow(/execFence/);
  });

  it("labels the posture without silence: inline is 'unfenced', worker is 'fence: none' until increment 3", () => {
    expect(toolExecModeLabel({})).toBe("inline (unfenced)");
    expect(toolExecModeLabel({ toolExec: "inline" })).toBe("inline (unfenced)");
    expect(toolExecModeLabel({ toolExec: "worker" })).toBe("worker (fence: none)");
  });
});

// ── Pilot taxonomy ─────────────────────────────────────────────────

describe("pilot tool tags", () => {
  it("tags only the increment-1 pilots: bash, read, grep", () => {
    const read = new ReadTool({ readLimit: 10 });
    const grep = new GrepTool({ maxResults: 10, maxOutputLines: 10 });
    const bash = new BashTool({ timeoutMs: 1000, maxOutputLines: 10 });
    expect(bash.metadata.execution).toBe("worker");
    expect(read.metadata.execution).toBe("worker");
    expect(grep.metadata.execution).toBe("worker");
  });
});

// ── Cancellation ──────────────────────────────────────────────────

interface CancellingLink extends ToolExecLink {
  calls: Array<{ id: string; tool: string }>;
  cancels: string[];
  warmed: Array<{ session: string; cls: string; workspace?: { roots: string[] } }>;
}

/** Fake link whose invoke answers on a script you control, and records cancels. */
function cancellableLink(invoker?: (id: string | undefined) => Promise<WireToolResult>): CancellingLink {
  const link: CancellingLink = {
    calls: [],
    cancels: [],
    warmed: [],
    warm(session, cls, workspace) {
      link.warmed.push({ session, cls, workspace });
    },
    invoke(req) {
      link.calls.push({ id: req.id ?? "", tool: req.tool });
      if (invoker) return invoker(req.id);
      return new Promise<WireToolResult>(() => {}); // never settles
    },
    cancel(id) {
      link.cancels.push(id);
    },
    async close() {},
  };
  return link;
}

async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("ToolExecutor plane cancellation", () => {
  it("sends a cancel for the in-flight call id and settles as a cancelled error result", async () => {
    const controller = new AbortController();
    const link = cancellableLink();
    let localRan = false;
    const { executor } = setup(
      [makeTool("planned", async () => { localRan = true; return "local"; }, "worker")],
      { toolExec: "worker", toolExecLink: link, runSignal: () => controller.signal },
    );

    const running = executor.execute([call("planned")]);
    await settle(() => link.calls.length === 1, "the invoke to reach the link");
    controller.abort();
    const { toolResults } = await running;

    const part = toolContentText(toolResults[0]!.content);
    expect(part).toContain("[tool-exec cancelled]");
    expect(part).toContain("planned");
    expect(link.calls[0]!.id.length).toBeGreaterThan(0);
    expect(link.cancels).toEqual([link.calls[0]!.id]);
    // No inline fallback after the cancel.
    expect(localRan).toBe(false);
  });

  it("does not wait for the runner: an uninterruptible call settles on the abort", async () => {
    // Simulates read/grep: the runner ignores the cancel and answers 5s later.
    const controller = new AbortController();
    const link = cancellableLink(
      () => new Promise<WireToolResult>((resolve) => setTimeout(() => resolve({ kind: "value", value: "late" }), 5000)),
    );
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      { toolExec: "worker", toolExecLink: link, runSignal: () => controller.signal },
    );

    const running = executor.execute([call("planned")]);
    await settle(() => link.calls.length === 1, "the invoke to reach the link");
    const t0 = Date.now();
    controller.abort();
    const { toolResults } = await running;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(toolContentText(toolResults[0]!.content)).toContain("[tool-exec cancelled]");
    expect(link.cancels).toHaveLength(1);
  });

  it("a run already cancelled never dispatches", async () => {
    // Pre-aborted: no frame goes out at all (there is nothing left to run),
    // and the result is still the cancelled error result, never an inline
    // fallback to the local tool.
    const controller = new AbortController();
    controller.abort();
    const link = cancellableLink(async () => ({ kind: "value", value: "never" }) as WireToolResult);
    let localRan = false;
    const { executor } = setup(
      [makeTool("planned", async () => { localRan = true; return "local"; }, "worker")],
      { toolExec: "worker", toolExecLink: link, runSignal: () => controller.signal },
    );
    const { toolResults } = await executor.execute([call("planned")]);
    expect(toolContentText(toolResults[0]!.content)).toContain("[tool-exec cancelled]");
    expect(link.calls).toHaveLength(0);
    expect(link.cancels).toHaveLength(0);
    expect(localRan).toBe(false);
  });

  it("a cancelled call does not retry and does not leak the runner's late rejection", async () => {
    const controller = new AbortController();
    let invocations = 0;
    const link = cancellableLink(() => {
      invocations++;
      return new Promise<WireToolResult>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runner went away")), 50),
      );
    });
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      // maxRetries 1: a cancelled call must still be a single attempt.
      { toolExec: "worker", toolExecLink: link, runSignal: () => controller.signal, maxRetries: 1 },
    );
    const running = executor.execute([call("planned")]);
    await settle(() => invocations === 1, "the invoke to reach the link");
    controller.abort();
    const { toolResults } = await running;
    expect(toolContentText(toolResults[0]!.content)).toContain("[tool-exec cancelled]");
    // Let the late rejection land; it must not surface as unhandled and must
    // not consume a retry attempt.
    await new Promise((r) => setTimeout(r, 120));
    expect(invocations).toBe(1);
  });

  it("without a run signal nothing is cancelled and the reply is awaited", async () => {
    const link = cancellableLink(async () => serializeToolResult(ToolResult.ok("answered")));
    const { executor } = setup(
      [makeTool("planned", async () => "local", "worker")],
      { toolExec: "worker", toolExecLink: link },
    );
    const { toolResults } = await executor.execute([call("planned")]);
    expect(toolContentText(toolResults[0]!.content)).toContain("answered");
    expect(link.cancels).toHaveLength(0);
  });
});

// ── Inline cancellation seam (the same signal reaches in-process tools) ─────

describe("ToolExecutor inline abortSignal", () => {
  it("mounts the run signal on the inline tool context", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { executor } = setup(
      [
        makeTool("inliney", async (_input, ctx) => {
          seen = ctx?.get("abortSignal");
          return ToolResult.ok("ok");
        }),
      ],
      { runSignal: () => controller.signal },
    );
    await executor.execute([call("inliney")]);
    expect(seen).toBe(controller.signal);
  });

  it("leaves the key unset for hosts with no run signal (today's behavior)", async () => {
    let sawKey = true;
    const { executor } = setup([
      makeTool("inliney", async (_input, ctx) => {
        sawKey = ctx?.has("abortSignal") ?? false;
        return ToolResult.ok("ok");
      }),
    ], {});
    await executor.execute([call("inliney")]);
    expect(sawKey).toBe(false);
  });
});

// ── Degraded posture label ─────────────────────────────────────

describe("toolExecModeLabel degraded flag", () => {
  it("marks a degraded worker plane and keeps inline honest but unmarked", () => {
    expect(toolExecModeLabel({ toolExec: "worker" }, true)).toContain("degraded");
    expect(toolExecModeLabel({ toolExec: "worker" }, true)).toContain("worker (fence: none)");
    // Inline has no broker, so it can never be degraded.
    expect(toolExecModeLabel({ toolExec: "inline" }, true)).toBe("inline (unfenced)");
    expect(toolExecModeLabel({ toolExec: "worker" })).toBe("worker (fence: none)");
  });
});

// ── Run-start warm ────────────────────────────────────────────────

describe("run-start warm", () => {
  function warmAgent(toolExec: "worker" | "inline", link: CancellingLink, tools: Tool[] = []): Agent {
    const toolRegistry = createToolRegistry();
    for (const t of tools) {
      const def = t.toToolDef() as ToolDef;
      toolRegistry.register(def.function.name, t);
    }
    return new Agent({
      hooks: createHooks(),
      toolRegistry,
      llmClient: {
        chatStreamCancellable: () =>
          (async function* () {
            yield { type: "content", content: "done" };
            yield { type: "usage", data: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
          })(),
      } as unknown as Agent["llmClient"],
      model: "test-model",
      maxIterations: 2,
      contextLimit: 1000,
      config: { maxToolCallsPerIteration: 4, maxRetries: 0, toolRetryDelay: 0, maxEmptyRetries: 0 },
      sessionId: "warm-me",
      systemPromptTemplate: "test prompt",
      toolExec,
      toolExecLink: link,
    });
  }

  it("fires a fire-and-forget warm for (session, rw) when the plane is on", async () => {
    const link = cancellableLink();
    await warmAgent("worker", link, [makeTool("planned", async () => "x", "worker")]).run("hello");
    expect(link.warmed.length).toBe(1);
    expect(link.warmed[0]!.session).toBe("warm-me");
    expect(link.warmed[0]!.cls).toBe("rw");
    // The workspace rides along so the warmed entry gets the fence the first
    // invoke would plan (increment 3).
    expect(link.warmed[0]!.workspace?.roots.length).toBeGreaterThan(0);
    expect(link.calls).toHaveLength(0);
  });

  it("does not warm when nothing registered is tagged for the plane", async () => {
    // sandboxMode / tight whitelists / toolless profiles: warming would spawn
    // a broker and an entry that can never serve a call.
    const link = cancellableLink();
    await warmAgent("worker", link, [makeTool("localonly", async () => "x")]).run("hello");
    expect(link.warmed).toHaveLength(0);
  });

  it("never warms in inline mode (no pool exists there)", async () => {
    const link = cancellableLink();
    await warmAgent("inline", link).run("hello");
    expect(link.warmed).toHaveLength(0);
  });
});

// ── Shared broker posture pinning ───────────────────────────────────────────

describe("shared broker posture pinning", () => {
  it("computes drift from the pinned posture and ignores unset or matching knobs", () => {
    const pinned = { fence: "probe", envScrubbing: "true" };
    expect(postureDrift(pinned, {})).toEqual([]);
    expect(postureDrift(pinned, { fence: "probe", envScrubbing: true })).toEqual([]);
    expect(postureDrift(pinned, { fence: "off" })).toEqual(['fence: kept "probe", ignored "off"']);
    expect(postureDrift(pinned, { envScrubbing: false })).toEqual([
      "envScrubbing: kept true, ignored false",
    ]);
    expect(postureDrift(pinned, { fence: "off", envScrubbing: false })).toHaveLength(2);
  });

  it("one broker per process: later opts never mint a second instance", () => {
    // Construction starts no process (#ensureStarted is lazy), so this is a
    // cheap identity check on the shared singleton.
    const first = sharedToolExecBroker();
    expect(sharedToolExecBroker({ fence: "off" })).toBe(first);
    expect(sharedToolExecBroker()).toBe(first);
  });
});
