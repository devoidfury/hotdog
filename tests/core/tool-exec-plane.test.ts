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
  type WireFence,
} from "@core/tool-exec-protocol.ts";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFenceBackend } from "@utils/exec-plan.ts";
import {
  createFencePlanner,
  postureDrift,
  registerLiveTmpDir,
  sharedToolExecBroker,
  sweepStaleTmpDirs,
  unregisterLiveTmpDir,
  toolExecPlaneSettings,
  toolExecModeLabel,
  ToolExecBroker,
} from "@core/tool-exec-broker.ts";
import { TMP_PARENT } from "../helpers.ts";
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
  it("requires the schema-owned keys and validates values loudly (no code-side defaults)", () => {
    // Unset keys are a resolution failure, not an opt-out: loud ConfigError.
    expect(() => toolExecPlaneSettings({})).toThrow(/toolExec/);
    expect(() => toolExecPlaneSettings({ toolExec: "inline" })).toThrow(/execFence/);
    expect(toolExecPlaneSettings({ toolExec: "worker", execFence: "off" })).toEqual({
      mode: "worker",
      fence: "off",
    });
    expect(toolExecPlaneSettings({ toolExec: "inline", execFence: "probe" })).toEqual({
      mode: "inline",
      fence: "probe",
    });
    expect(() => toolExecPlaneSettings({ toolExec: "workers", execFence: "probe" })).toThrow(/toolExec/);
    expect(() => toolExecPlaneSettings({ toolExec: "inline", execFence: "require" })).toThrow(/execFence/);
  });

  it("labels the posture without silence: inline is 'unfenced', worker is 'fence: none' until increment 3", () => {
    expect(toolExecModeLabel({ toolExec: "inline", execFence: "probe" })).toBe("inline (unfenced)");
    expect(toolExecModeLabel({ toolExec: "worker", execFence: "probe" })).toBe("worker (fence: none)");
  });
});

// ── Pilot taxonomy ─────────────────────────────────────────────────

describe("pilot tool tags", () => {
  it("tags only the increment-1 pilots: bash, read, grep", () => {
    const read = new ReadTool({ readLimit: 10, maxImageSize: 10485760 });
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
    expect(toolExecModeLabel({ toolExec: "worker", execFence: "probe" }, true)).toContain("degraded");
    expect(toolExecModeLabel({ toolExec: "worker", execFence: "probe" }, true)).toContain("worker (fence: none)");
    // Inline has no broker, so it can never be degraded.
    expect(toolExecModeLabel({ toolExec: "inline", execFence: "probe" }, true)).toBe("inline (unfenced)");
    expect(toolExecModeLabel({ toolExec: "worker", execFence: "probe" })).toBe("worker (fence: none)");
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
    const pinned = { fence: "probe", envScrubbing: "true", toolNames: ["bash", "read"] };
    expect(postureDrift(pinned, {})).toEqual([]);
    expect(postureDrift(pinned, { fence: "probe", envScrubbing: true })).toEqual([]);
    expect(postureDrift(pinned, { fence: "off" })).toEqual(['fence: kept "probe", ignored "off"']);
    expect(postureDrift(pinned, { envScrubbing: false })).toEqual([
      "envScrubbing: kept true, ignored false",
    ]);
    expect(postureDrift(pinned, { fence: "off", envScrubbing: false })).toHaveLength(2);
    // Descriptors: the same tool set in any order is no drift; a differing
    // one warns (the first build's list ships for the process lifetime).
    expect(
      postureDrift(pinned, {
        toolDescriptors: [
          { tool: "read", module: "file:///x.ts", factory: "WIRE_TOOL_FACTORIES" },
          { tool: "bash", module: "file:///y.ts", factory: "WIRE_TOOL_FACTORIES" },
        ],
      }),
    ).toEqual([]);
    expect(
      postureDrift(pinned, {
        toolDescriptors: [{ tool: "bash", module: "file:///y.ts", factory: "WIRE_TOOL_FACTORIES" }],
      }),
    ).toEqual(["toolDescriptors: kept [bash, read], ignored [bash]"]);
    expect(
      postureDrift(pinned, {
        toolDescriptors: [
          { tool: "bash", module: "file:///y.ts", factory: "WIRE_TOOL_FACTORIES" },
          { tool: "read", module: "file:///x.ts", factory: "WIRE_TOOL_FACTORIES" },
          { tool: "grep", module: "file:///z.ts", factory: "WIRE_TOOL_FACTORIES" },
        ],
      }),
    ).toEqual(["toolDescriptors: kept [bash, read], ignored [bash, read, grep]"]);
  });

  it("one broker per process: later opts never mint a second instance", () => {
    // Construction starts no process (#ensureStarted is lazy), so this is a
    // cheap identity check on the shared singleton.
    const first = sharedToolExecBroker();
    expect(sharedToolExecBroker({ fence: "off" })).toBe(first);
    expect(sharedToolExecBroker()).toBe(first);
  });
});

// ── Fence planning ──────────────────────────────────────────────────────────

describe("createFencePlanner", () => {
  it("off returns no planner at all", () => {
    expect(createFencePlanner("off")).toBeNull();
  });

  it("probe plans once per (session, class, roots) and memoizes the answer", () => {
    const plan = createFencePlanner("probe");
    expect(plan).not.toBeNull();
    const roots = [tmpdir()];
    const first = plan!("unit:probe", "rw", roots);
    expect(first === null || (first.id !== "" && first.prefix.length > 0)).toBe(true);
    expect(plan!("unit:probe", "rw", roots)).toBe(first); // memoized, same identity
    // A different class replans (null hosts stay null on every tuple).
    expect(plan!("unit:probe", "net", roots) === null || first !== null).toBe(true);
    plan!.releaseAll!(); // the test's scratch dirs die with the test
  });
});

// ── Scratch dir: ONE per session (defect pin) ───────────────────────────────
//
// Every plan tuple of a session shares one dir; dropSession replans a fresh
// one for ITS session; nothing rm()s. The pins run on ONE planner instance
// (per-class planners would differ for unrelated reasons); on a backend-less
// host the pin flips to "no dir at all" on stderr instead of passing
// silently.

describe("createFencePlanner scratch dir (one per session)", () => {
  const scratchOf = (fence: WireFence | null): string | null =>
    fence?.prefix.find((a) => a.startsWith(join(tmpdir(), "hotdog-exec-"))) ?? null;
  const scratchCount = (session: string): number =>
    readdirSync(tmpdir()).filter((d) => d.startsWith(`hotdog-exec-${session}-`)).length;

  it("one planner, two classes, two roots-sets: the SAME scratch path every time; no class in the name", () => {
    const plan = createFencePlanner("probe")!;
    const s = `unit-scratch-pin-${process.pid}`;
    const rootA = tmpdir();
    const rw = plan(s, "rw", [rootA]);
    const net = plan(s, "net", [rootA]);
    const rw2 = plan(s, "rw", [rootA, join(rootA, "extra-not-here")]);
    if (execFenceBackend() === null) {
      process.stderr.write(
        "[tool-exec-plane] no jail backend on this host: scratch path-equality is VACUOUS here; pinning the no-dir gate instead\n",
      );
      expect(rw).toBeNull();
      expect(net).toBeNull();
      expect(scratchCount(s)).toBe(0); // probe-first: no dir
      plan.releaseAll!();
      return;
    }
    const a = scratchOf(rw);
    expect(a).not.toBeNull();
    expect(scratchOf(net)).toBe(a); // PATH EQUALITY, same planner
    expect(scratchOf(rw2)).toBe(a); // roots-set change: still the session's one dir
    expect(a).not.toMatch(/-(rw|net)-/); // class never enters the name
    expect(existsSync(a!)).toBe(true);
    expect(scratchCount(s)).toBe(1);
    plan.releaseAll!(); // the test's scratch dirs die with the test
  });

  it("distinct sessions get distinct dirs; dropSession mints a fresh one for ITS session only; nothing is rm()d", () => {
    const plan = createFencePlanner("probe")!;
    const tag = `${process.pid}`;
    const s1 = `unit-scratch-d1-${tag}`;
    const s2 = `unit-scratch-d2-${tag}`;
    const roots = [tmpdir()];
    const f1 = plan(s1, "rw", roots);
    const f2 = plan(s2, "rw", roots);
    if (execFenceBackend() === null) {
      process.stderr.write(
        "[tool-exec-plane] no jail backend on this host: dropSession scratch freshness is VACUOUS here (both plans are null)\n",
      );
      expect(f1).toBeNull();
      expect(f2).toBeNull();
      plan.releaseAll!();
      return;
    }
    const a = scratchOf(f1)!;
    const b = scratchOf(f2)!;
    expect(a).not.toBe(b); // per-session: distinct dirs
    plan.dropSession!(s1);
    const f1b = plan(s1, "rw", roots); // replanned: fresh dir for s1
    const aFresh = scratchOf(f1b)!;
    expect(aFresh).not.toBe(a);
    expect(existsSync(a)).toBe(true); // the dropped dir is NEVER rm()d (live binds may reference it)
    const f2b = plan(s2, "net", roots); // s2 untouched: a new tuple still lands on ITS dir
    expect(scratchOf(f2b)).toBe(b);
    expect(existsSync(b)).toBe(true);
    expect(scratchCount(s1)).toBe(2); // old + fresh, neither removed
    expect(scratchCount(s2)).toBe(1);
    // dropSession orphans the old dir by design; the test cleans up after
    // both itself (releaseAll only tracks the current mappings).
    rmSync(a, { recursive: true, force: true });
    plan.releaseAll!();
    expect(scratchCount(s1)).toBe(0);
    expect(scratchCount(s2)).toBe(0);
  });
});

// ── Scratch reclaim (arm / finish / all) ──────────────────────────────────────
//
// SESSION_END arms a session's scratch reclaim (2026-11 ENOSPC hunt: dirs were
// left behind forever); the child's CONFIRMED entry death (finishRelease) is
// what licenses the rm. A resumed session's plan() disarms. The child's own
// death purges everything (releaseAll). On a backend-less host no dir is ever
// minted and the dance is a must-not-throw no-op.

describe("createFencePlanner scratch reclaim", () => {
  const scratchOf = (fence: WireFence | null): string | null =>
    fence?.prefix.find((a) => a.startsWith(join(tmpdir(), "hotdog-exec-"))) ?? null;

  it("finishRelease reclaims the armed session's dir; a resumed session mints a fresh one; siblings survive", () => {
    const plan = createFencePlanner("probe")!;
    const tag = `${process.pid}`;
    const s1 = `unit-rel-a-${tag}`;
    const s2 = `unit-rel-b-${tag}`;
    const roots = [tmpdir()];
    const f1 = plan(s1, "rw", roots);
    const f2 = plan(s2, "rw", roots);
    if (execFenceBackend() === null) {
      process.stderr.write(
        "[tool-exec-plane] no jail backend on this host: scratch reclaim is VACUOUS here (the arm/finish dance must merely not throw)\n",
      );
      plan.armRelease!(s1, 1);
      plan.finishRelease!(s1, 1);
      plan.releaseAll!();
      return;
    }
    const a = scratchOf(f1)!;
    const b = scratchOf(f2)!;
    expect(existsSync(a)).toBe(true);
    plan.armRelease!(s1, 1);
    plan.finishRelease!(s1, 1);
    expect(existsSync(a)).toBe(false); // the real mkdtemp'd dir is GONE
    expect(existsSync(b)).toBe(true); // unrelated session: its dir survives the teardown signal
    // The resumed session: the memo dropped with the mapping, so the next plan
    // mints a FRESH dir -- and a different fence id, which is what makes the
    // child's fence-mismatch replace rule respawn any entry still standing.
    const f1b = plan(s1, "rw", roots);
    const aFresh = scratchOf(f1b)!;
    expect(aFresh).not.toBe(a);
    expect(existsSync(aFresh)).toBe(true);
    expect(f1b!.id).not.toBe(f1!.id);
    plan.releaseAll!();
    expect(existsSync(b)).toBe(false);
    expect(existsSync(aFresh)).toBe(false);
  });

  it("re-arm vs stale ack: only the CURRENT arm's seq reclaims (double SESSION_END)", () => {
    // The re-fire shape: SESSION_END#1 arms seq 1, its ack drains LATE (a
    // runner still bound); SESSION_END#2 re-arms at seq 2. The stale seq-1
    // ack must not satisfy the newer arm, and the seq-2 ack (which the
    // child's FIFO drain only answers once every entry dropped at seq <= 2
    // is process-dead) reclaims exactly once.
    const plan = createFencePlanner("probe")!;
    const s = `unit-rel-gen-${process.pid}`;
    const roots = [tmpdir()];
    const f = plan(s, "rw", roots);
    if (execFenceBackend() === null) {
      plan.armRelease!(s, 1);
      plan.armRelease!(s, 2);
      plan.finishRelease!(s, 1);
      plan.finishRelease!(s, 2);
      plan.releaseAll!();
      return;
    }
    const d = scratchOf(f)!;
    expect(existsSync(d)).toBe(true);
    plan.armRelease!(s, 1);
    plan.armRelease!(s, 2); // re-fired SESSION_END
    plan.finishRelease!(s, 1); // the LATE stale ack
    expect(existsSync(d)).toBe(true); // generation gate: the dir lives
    plan.finishRelease!(s, 99); // any other unknown generation
    expect(existsSync(d)).toBe(true);
    plan.finishRelease!(s, 2); // the current generation's ack
    expect(existsSync(d)).toBe(false);
    // The double-delivery of the same generation must not rm twice (and the
    // forgotten mapping means there is nothing to rm).
    plan.finishRelease!(s, 2);
  });

  it("plan() disarms an armed release: a late ack must not rm a live session's dir", () => {
    const plan = createFencePlanner("probe")!;
    const s = `unit-rel-c-${process.pid}`;
    const roots = [tmpdir()];
    const f = plan(s, "rw", roots);
    plan.armRelease!(s, 1); // SESSION_END lands...
    const f2 = plan(s, "net", roots); // ...but the session revived before the ack
    if (execFenceBackend() === null) {
      plan.finishRelease!(s, 1);
      plan.releaseAll!();
      return;
    }
    const d = scratchOf(f)!;
    expect(scratchOf(f2)).toBe(d); // resume reuses the current dir
    plan.finishRelease!(s, 1); // the late ack: disarmed, a no-op
    expect(existsSync(d)).toBe(true); // the dir LIVES (a live plan outranks a stale ack)
    plan.releaseAll!();
    expect(existsSync(d)).toBe(false);
  });

  it("finishRelease without arm is a no-op; releaseAll purges every session (the broker-death shape)", () => {
    const plan = createFencePlanner("probe")!;
    const tag = `${process.pid}`;
    const s1 = `unit-rel-d-${tag}`;
    const s2 = `unit-rel-e-${tag}`;
    const roots = [tmpdir()];
    const d1 = scratchOf(plan(s1, "rw", roots));
    const d2 = scratchOf(plan(s2, "rw", roots));
    plan.finishRelease!(s1, 1); // never armed: touches nothing
    if (execFenceBackend() === null) {
      plan.releaseAll!();
      return;
    }
    expect(existsSync(d1!)).toBe(true);
    expect(existsSync(d2!)).toBe(true);
    plan.armRelease!(s2, 1);
    plan.releaseAll!(); // death purges armed AND unarmed sessions
    expect(existsSync(d1!)).toBe(false);
    expect(existsSync(d2!)).toBe(false);
    const d1b = scratchOf(plan(s1, "rw", roots))!; // the next broker plans fresh
    expect(d1b).not.toBe(d1);
    expect(existsSync(d1b)).toBe(true);
    plan.releaseAll!();
  });
});

// ── Stale tmp sweep (the boot janitor) ────────────────────────────────────────

describe("sweepStaleTmpDirs", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("removes old own-prefix dirs; keeps young own-prefix ones, foreign prefixes, and files", () => {
    const base = mkdtempSync(join(TMP_PARENT, "hotdog-sweep-unit-"));
    try {
      const oldExec = join(base, "hotdog-exec-unit-old-AAA");
      const youngExec = join(base, "hotdog-exec-unit-young-BBB");
      const oldBrowser = join(base, "hotdog-agent-browser-unit-old-CCC");
      const foreign = join(base, "someone-elses-stuff");
      for (const d of [oldExec, youngExec, oldBrowser, foreign]) mkdirSync(d);
      writeFileSync(join(oldExec, "tmpfile"), "x"); // the rm is recursive
      const old = new Date(Date.now() - 4 * DAY_MS);
      for (const d of [oldExec, oldBrowser, foreign]) utimesSync(d, old, old);
      // Re-age oldExec AFTER the child write: the entry-creation bumped its
      // dir mtime; without the re-age the freshness pass would (correctly)
      // spare it. The entry file is aged too -- a fully abandoned dir.
      const oldChild = join(oldExec, "tmpfile");
      utimesSync(oldChild, old, old);
      utimesSync(oldExec, old, old);
      writeFileSync(join(base, "hotdog-exec-unit-afile"), "not a dir");
      expect(sweepStaleTmpDirs("hotdog-exec-", base)).toBe(1);
      expect(existsSync(oldExec)).toBe(false);
      expect(existsSync(youngExec)).toBe(true); // young = possibly live: NEVER sweep (multi-process safety)
      expect(existsSync(oldBrowser)).toBe(true); // foreign to THIS prefix (the browser sweep's job)
      expect(existsSync(foreign)).toBe(true);
      expect(existsSync(join(base, "hotdog-exec-unit-afile"))).toBe(true); // files are not ours
      expect(sweepStaleTmpDirs("hotdog-agent-browser-", base)).toBe(1);
      expect(existsSync(oldBrowser)).toBe(false);
      expect(existsSync(youngExec)).toBe(true);
      // An unreadable base logs and returns 0, never throws.
      expect(sweepStaleTmpDirs("hotdog-exec-", join(base, "never-existed"))).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("live-dir immunity: registered dirs survive at any age; entry freshness rescues stale-mtime dirs", () => {
    const base = mkdtempSync(join(TMP_PARENT, "hotdog-sweep-immune-"));
    try {
      const DAY = 24 * 60 * 60 * 1000;
      const old = new Date(Date.now() - 4 * DAY);
      const mkOld = (name: string): string => {
        const d = join(base, name);
        mkdirSync(d);
        utimesSync(d, old, old);
        return d;
      };
      const registered = mkOld("hotdog-exec-unit-registered");
      registerLiveTmpDir(registered); // the owner checked it in before any sweep ran
      const unregistered = mkOld("hotdog-exec-unit-unregistered");
      const freshEntry = mkOld("hotdog-exec-unit-freshentry");
      // The dir mtime says dead; an entry append-style touch says alive.
      const child = join(freshEntry, "runner-tmp");
      writeFileSync(child, "x");
      utimesSync(freshEntry, old, old); // creating the entry bumped the DIR mtime; re-age it
      expect(sweepStaleTmpDirs("hotdog-exec-", base)).toBe(1);
      expect(existsSync(unregistered)).toBe(false);
      expect(existsSync(registered)).toBe(true); // registered? age never applies
      expect(existsSync(freshEntry)).toBe(true); // entry-level freshness pass
      const protected2 = mkOld("hotdog-exec-unit-protected2");
      registerLiveTmpDir(protected2); // registered AFTER the first sweep
      const other = mkOld("hotdog-exec-unit-other");
      expect(sweepStaleTmpDirs("hotdog-exec-", base)).toBe(1); // only `other`
      expect(existsSync(other)).toBe(false);
      expect(existsSync(protected2)).toBe(true); // immunity at any age
      unregisterLiveTmpDir(protected2);
      expect(sweepStaleTmpDirs("hotdog-exec-", base)).toBe(1);
      expect(existsSync(protected2)).toBe(false); // owner released it: food again
      expect(existsSync(registered)).toBe(true); // still immune
    } finally {
      // registered dirs are immune to the sweep by design; the test is the owner.
      unregisterLiveTmpDir(join(base, "hotdog-exec-unit-registered"));
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a live planner's mapped dir survives a default-base sweep at any age", () => {
    // The reachability from the review: another `new ToolExecBroker()` (or a
    // second planner) janitor-sweeping the REAL tmpdir must never eat this
    // planner's live `scratchDirs` mapping, even with an old mtime.
    const plan = createFencePlanner("probe")!;
    const s = `unit-rel-sweepimmune-${process.pid}`;
    const f = plan(s, "rw", [tmpdir()]);
    if (execFenceBackend() === null) {
      process.stderr.write(
        "[tool-exec-plane] no jail backend on this host: live-dir planner sweep immunity is VACUOUS here\n",
      );
      return;
    }
    const d = f!.prefix.find((a) => a.startsWith(join(tmpdir(), "hotdog-exec-")))!;
    const DAY = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 4 * DAY);
    utimesSync(d, old, old);
    sweepStaleTmpDirs("hotdog-exec-"); // default base, default now
    expect(existsSync(d)).toBe(true); // registered by the planner: immune
    // releaseAll unregisters AND rm's (its own dirs, its own decision).
    plan.releaseAll!();
    expect(existsSync(d)).toBe(false);
  });

  it("broker construction sweeps old own-prefix dirs off the critical path", async () => {
    // The janitor runs in an unref'd deferred timer reading tmpdir() AT FIRE
    // TIME, so TMPDIR points at the sandbox for the construction window only;
    // inside it, only old `hotdog-exec-*` entries are food.
    const base = mkdtempSync(join(TMP_PARENT, "hotdog-sweep-boot-"));
    const savedTmpDir = process.env.TMPDIR;
    const oldExec = join(base, `hotdog-exec-unit-boot-${process.pid}`);
    const young = join(base, `hotdog-exec-unit-bootyoung-${process.pid}`);
    try {
      mkdirSync(oldExec);
      mkdirSync(young);
      const old = new Date(Date.now() - 4 * DAY_MS);
      utimesSync(oldExec, old, old);
      process.env.TMPDIR = base;
      try {
        // Capture the janitor instead of racing it: the deferred unref'd
        // timer starved past even the 3 s poll under coverage
        // instrumentation (flaked 2026-11-24 at the full window). The
        // setTimeout swap covers the synchronous constructor only, so
        // `captured` holds exactly what construction scheduled -- and no
        // real timer is armed, so a late fire can never sweep the real
        // tmpdir on a slow host either.
        const realSetTimeout = globalThis.setTimeout;
        const captured: Array<() => void> = [];
        let unrefd = 0;
        globalThis.setTimeout = ((fn: unknown, ms?: unknown, ...rest: unknown[]) =>
          ms === 0
            ? ((captured.push(fn as () => void),
               { unref: () => { unrefd++; } }) as never)
            : (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest)) as unknown as typeof globalThis.setTimeout;
        let broker: ToolExecBroker;
        try {
          broker = new ToolExecBroker({ fence: "off" });
        } finally {
          globalThis.setTimeout = realSetTimeout;
        }
        expect(captured.length).toBe(1); // construction defers exactly one sweep
        expect(unrefd).toBe(1); // ...unref'd: never a reason the host stays alive
        expect(existsSync(oldExec)).toBe(true); // ...and off the construction path
        captured[0]!(); // fire it while TMPDIR still points at the sandbox
        expect(existsSync(oldExec)).toBe(false); // the janitor's sweep lands
        expect(existsSync(young)).toBe(true);
        await broker.close();
      } finally {
        if (savedTmpDir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmpDir;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
