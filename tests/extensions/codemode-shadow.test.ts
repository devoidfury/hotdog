// The full-tilt shadow layer. Real machinery end to end: the shipped
// extension loaded through the ./testing kit onto a real HookSystem +
// ToolRegistry shared with real fixture Agents driven by MockLLMClient, plus
// the real ToolExecutor's nested entry for the dispatch-authority side.
// Nothing here stubs the hook: the filter runs exactly where core runs it
// (post policy chain, pre wire).

import { describe, expect, it } from "bun:test";

import { createTestCore, ExtensionLoader } from "@read-receipt/hotdog/testing";
import { HOOKS, type HookSystem } from "@core/hooks.ts";
import { createToolExecutor } from "@core/tool-executor.ts";
import type { Agent } from "@core/agent.ts";
import type {
  ToolDef,
  ToolMetadata,
  ToolRegistry,
} from "@core/extensions/tool-registry.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { toolContentText } from "@utils/tool-content.ts";
import { MockLLMClient, MockTool, buildStreamResponse, createFixture } from "../helpers.ts";

const EXT_SPEC = "@experimental/codemode/index.ts";

// The keep-direct table (the same list shadow.ts and the prompt chunk consume
// via catalog.ts), kept literal here so this test fails if the extension list
// drifts.
const KEEP_DIRECT = [
  "question",
  "wait",
  "handoff",
  "load_skill",
  "model",
  "delegate_task",
  "task_status",
  "task_followup",
  "task_interrupt",
  "plan_status",
  "workflow_validate",
  "workflow_dispatch",
  "workflow_status",
  "workflow_followup",
  "workflow_control",
  "review",
  "edit",
  "overwrite",
  "append",
];

// The shadow inventory, incl. head/tail (the filter is list-based, so
// registering them later shadows them automatically) and an MCP-shaped name
// (other extensions' / servers' tools wholesale).
const SHADOWED = [
  "read",
  "bash",
  "grep",
  "find",
  "explore",
  "project_info",
  "fetch",
  "web_search",
  "agent_browser",
  "string_length",
  "show_me",
  "head",
  "tail",
  "srv__remote_tool",
];

function fixtureTool(name: string, metadata: Partial<ToolMetadata> = {}): MockTool {
  return new MockTool({
    name,
    metadata: { sideEffects: false, difficulty: 1, tags: [], ...metadata },
    execute: async () => `${name} result`,
  });
}

async function bootCodemode() {
  const core = createTestCore();
  const loader = new ExtensionLoader(core);
  const inst = await loader.load("codemode", EXT_SPEC);
  expect(inst).not.toBeNull();
  return { core, loader };
}

/** Full population: keep-direct class, one pinned contract tool, one
 *  shadowed name that fuzzy-matches a kept name (the bounce's candidate
 *  list must come from the OFFERED set, never the registry), and the
 *  shadow inventory. Returns the MockTools by name. */
function populate(registry: ToolRegistry): Map<string, MockTool> {
  const tools = new Map<string, MockTool>();
  const add = (name: string, metadata?: Partial<ToolMetadata>) => {
    const t = fixtureTool(name, metadata);
    tools.set(name, t);
    registry.register(name, t);
  };
  for (const n of KEEP_DIRECT) add(n);
  add("contract_out", { pinned: true });
  add("handoff2"); // shadowed; one edit from the kept "handoff"
  for (const n of SHADOWED) add(n);
  return tools;
}

function wireNames(mockLLM: MockLLMClient): string[] {
  return (mockLLM.lastToolDefs ?? []).map(
    (d) => (d as { function?: { name?: string } }).function?.name ?? "",
  );
}

function policyNames(agent: Agent): Promise<string[]> {
  return agent.getToolDefs().then((defs) => defs.map((d) => d.function.name));
}

function textResponse(content: string) {
  return buildStreamResponse({ content, usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
}

function toolCallResponse(calls: Array<{ name: string; id: string }>) {
  return buildStreamResponse({
    content: "working",
    toolCalls: calls.map((c, i) => ({ index: i, name: c.name, arguments: "{}", id: c.id })),
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

/** The nested-call entry over a real fixture agent (mirrors
 * tests/core/nested-tool-call.test.ts): availability re-derives through
 * agent.getToolDefs(), i.e. the PRE-shadow policy view. */
function nestedDispatcher(agent: Agent, hooks: HookSystem, toolRegistry: ToolRegistry) {
  return createToolExecutor({
    toolRegistry,
    hooks,
    emitOutput: () => {},
    workspaceRoots: null,
    workspaceDeny: null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent,
  });
}

function toolTexts(agent: Agent): string[] {
  return agent.context.log
    .getAll()
    .filter((m) => m.role === "tool")
    .map((m) => toolContentText(m.content));
}

interface Chunk {
  name: string;
  priority: number;
  content: string;
}

async function codemodeChunk(core: ReturnType<typeof createTestCore>, agent: unknown): Promise<Chunk | undefined> {
  const payload = { agent } as HookPayloads["systemPrompt:build"];
  const { results } = await core.hooks.runHookPipeline(HOOKS.SYSTEM_PROMPT_BUILD, payload);
  return results
    .map((r) => r.result as Chunk | undefined)
    .find((r) => r && typeof r === "object" && r.name === "codemode");
}

describe("shadow wire filter (§3.7 trigger + scope)", () => {
  it("keep-direct stays declared, pinned exempt, everything else off the wire", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("hi");

    const wire = wireNames(mockLLM);
    expect(wire).toContain("codemode");
    for (const kept of KEEP_DIRECT) expect(wire).toContain(kept);
    expect(wire).toContain("contract_out"); // pinned exemption, hook leg
    // Exact set: nothing shadowed leaked (incl. head/tail, the MCP-shaped
    // name, and the fuzzy handoff2), nothing kept was dropped.
    expect([...wire].sort()).toEqual(
      [...KEEP_DIRECT, "codemode", "contract_out"].sort(),
    );
  });

  it("fires iff the request's own defs carry codemode; shared hooks leave codemode-less agents untouched", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);

    // Same shared hooks + registry, two agents: A's profile blacklists
    // codemode (its defs lack the trigger name), B's offers it.
    const llmA = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const agentA = createFixture({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      mockLLM: llmA,
      config: { blacklistTools: ["codemode"] },
    }).agent;
    await agentA.run("hi");
    const wireA = wireNames(llmA);
    expect(wireA).not.toContain("codemode");
    for (const n of SHADOWED) expect(wireA).toContain(n); // untouched
    // Byte-identical to the untouched policy set: the hook returned nothing.
    expect(JSON.stringify(llmA.lastToolDefs)).toBe(JSON.stringify(await agentA.getToolDefs()));

    const llmB = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const agentB = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM: llmB }).agent;
    await agentB.run("hi");
    const wireB = wireNames(llmB);
    expect(wireB).toContain("codemode");
    for (const n of SHADOWED) expect(wireB).not.toContain(n);
  });

  it("successive iterations on a steady registry produce identical toolDefs (prompt-cache stability)", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);
    const snapshots: string[] = [];
    // Runs AFTER shadow (priority -1 < 0): records the payload the wire gets.
    core.hooks.on(
      HOOKS.PROVIDER_REQUEST,
      (payload: HookPayloads["provider:request"]) => {
        snapshots.push(JSON.stringify(payload.toolDefs));
      },
      { source: "wire-spy", priority: -1 },
    );
    const mockLLM = new MockLLMClient({
      responseSequences: [toolCallResponse([{ name: "question", id: "c-q" }]), textResponse("done")],
    });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("go");

    expect(snapshots.length).toBe(2);
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(JSON.stringify(mockLLM.lastToolDefs)).toBe(snapshots[1]!);
  });
});

describe("shadow bounce + dispatch-authority pair (§3.7 recovery)", () => {
  it("shadowed model call bounces (executeCount 0); candidates come only from the offered set", async () => {
    const { core } = await bootCodemode();
    const tools = populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({
      responseSequences: [
        toolCallResponse([
          { name: "bash", id: "c-bash" },
          { name: "handoff2", id: "c-h2" }, // fuzzy near the kept "handoff"
        ]),
        textResponse("recovered"),
      ],
    });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("go");

    expect(tools.get("bash")!.executeCount).toBe(0);
    expect(tools.get("handoff2")!.executeCount).toBe(0);
    const texts = toolTexts(agent);
    const bashMsg = texts.find((t) => t.includes("Tool 'bash'"));
    expect(bashMsg).toBeTruthy();
    expect(bashMsg).toContain("is not available for this agent");

    // The generic candidates error IS the recovery surface: verify it fired
    // and that no candidate is a shadowed name.
    const h2Msg = texts.find((t) => t.includes("Tool 'handoff2'"));
    expect(h2Msg).toContain("not available");
    const candidates = /Did you mean: (.+)\?/.exec(h2Msg ?? "")?.[1]?.split(", ") ?? [];
    expect(candidates).toContain("handoff"); // non-vacuous: kept + near-match
    const wire = new Set(wireNames(mockLLM));
    for (const c of candidates) expect(wire.has(c)).toBe(true);
    expect(candidates.some((c) => SHADOWED.includes(c) || c === "handoff2")).toBe(false);
  });

  it("the same shadowed tool IS callable inside a script via the nested entry (D1)", async () => {
    const { core } = await bootCodemode();
    const tools = populate(core.toolRegistry);
    const bash = tools.get("bash")!;
    const mockLLM = new MockLLMClient({
      responseSequences: [toolCallResponse([{ name: "bash", id: "c-bash" }]), textResponse("done")],
    });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("go");
    expect(bash.executeCount).toBe(0); // model surface: shadowed, bounced

    // Script surface: the nested entry re-derives availability from
    // getToolDefs() (pre-shadow), so the SAME tool runs through the real
    // pipeline.
    const exec = nestedDispatcher(agent, core.hooks, core.toolRegistry);
    const res = await exec.executeToolCall("bash", { command: "ls" }, { parentToolCallId: "codemode-1" });
    expect(res.ok).toBe(true);
    expect(bash.executeCount).toBe(1);
    // And the nested result never entered the conversation.
    expect(toolTexts(agent).some((t) => t.includes("bash result"))).toBe(false);
  });
});

describe("precedence law: policy filters first, shadow narrows after (§3.7)", () => {
  it("sandboxed + difficulty-capped + blacklist profile: wire ⊆ getToolDefs ⊆ registry; policy-filtered names unreachable from BOTH surfaces", async () => {
    const { core } = await bootCodemode();
    const tools = populate(core.toolRegistry);
    const add = (name: string, metadata?: Partial<ToolMetadata>) => {
      const t = fixtureTool(name, metadata);
      tools.set(name, t);
      core.toolRegistry.register(name, t);
    };
    add("sidey", { sideEffects: true });
    add("hardy", { difficulty: 5 });
    add("blacked");
    add("contract_pinned_sidey", { pinned: true, sideEffects: true });

    const mockLLM = new MockLLMClient({
      responseSequences: [toolCallResponse([{ name: "sidey", id: "c-s" }]), textResponse("done")],
    });
    const { agent } = createFixture({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      mockLLM,
      config: { sandboxMode: true, maxToolDifficulty: 1, blacklistTools: ["blacked"] },
    });

    await agent.run("go");

    const wire = wireNames(mockLLM);
    const policy = await policyNames(agent);
    const registry = [...core.toolRegistry.tools.keys()];
    expect(wire.every((n) => policy.includes(n))).toBe(true);
    expect(policy.every((n) => registry.includes(n))).toBe(true);

    // Each policy leg wins: gone from the wire.
    for (const gone of ["sidey", "hardy", "blacked"]) {
      expect(wire).not.toContain(gone);
    }
    // Pinned does NOT defeat filterByMetadata: the sandboxed sideEffects
    // pinned tool is absent (the shadow exemption covers the hook leg only,
    // and there is no hook leg to exempt it from -- see the trigger note
    // below), while the side-effect-free pinned tool survives policy.
    expect(wire).not.toContain("contract_pinned_sidey");
    expect(wire).toContain("contract_out");
    // The trigger beats narrowing HERE: codemode itself is sideEffects:true,
    // so sandboxMode filters it out of the policy set, the defs lack the
    // trigger name, and the shadow does not fire at all. A sandboxed agent
    // therefore keeps its (side-effect-free) tools declared -- it never
    // loses a tool without being offered the alternative.
    expect(wire).not.toContain("codemode");
    expect(wire).toContain("bash");

    // Model surface: the filtered call bounces without executing.
    expect(tools.get("sidey")!.executeCount).toBe(0);
    const texts = toolTexts(agent);
    expect(texts.find((t) => t.includes("Tool 'sidey'"))).toContain("not available");

    // Script surface: the SAME names are unreachable through the nested
    // entry too.
    const exec = nestedDispatcher(agent, core.hooks, core.toolRegistry);
    for (const name of ["sidey", "hardy", "blacked", "contract_pinned_sidey"]) {
      const res = await exec.executeToolCall(name, {}, { parentToolCallId: "codemode-2" });
      expect(res.ok, `nested ${name}`).toBe(false);
      expect(`${res.output}${res.error ?? ""}`).toContain("not available");
    }
    // And codemode is unreachable from both here (sandbox removed it from
    // policy) -- the whole alternative is gone, not just shadowed.
    expect((await exec.executeToolCall("codemode", { code: "return 1" }, { parentToolCallId: "codemode-2b" })).ok).toBe(false);
  });

  it("a pinned sideEffects tool on a sandboxMode profile: absent from the wire, unreachable from both surfaces (exemption covers the hook leg only)", async () => {
    const { core } = await bootCodemode();
    const pinny = fixtureTool("pinny", { pinned: true, sideEffects: true });
    core.toolRegistry.register("pinny", pinny);
    core.toolRegistry.register("bash", fixtureTool("bash"));

    const mockLLM = new MockLLMClient({
      responseSequences: [toolCallResponse([{ name: "pinny", id: "c-p" }]), textResponse("done")],
    });
    const { agent } = createFixture({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      mockLLM,
      config: { sandboxMode: true },
    });

    await agent.run("go");

    expect(wireNames(mockLLM)).not.toContain("pinny"); // hook leg did not re-add
    expect(pinny.executeCount).toBe(0);
    const exec = nestedDispatcher(agent, core.hooks, core.toolRegistry);
    expect((await exec.executeToolCall("pinny", {}, { parentToolCallId: "codemode-4" })).ok).toBe(false);
    // And the same tool, unshadowed-policy-wise, WOULD survive the hook leg:
    // a non-sandboxed agent keeps it declared (the exemption's real job).
    const openLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent: openAgent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM: openLLM });
    await openAgent.run("hi");
    expect(wireNames(openLLM)).toContain("pinny");
  });

  it("a profile whitelist cannot smuggle a shadowed name back onto the wire (it stays script-reachable)", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent } = createFixture({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      mockLLM,
      toolWhitelist: ["codemode", "bash", "question", "wait"],
      config: { blacklistTools: ["wait"] },
    });

    await agent.run("hi");

    const policy = await policyNames(agent);
    expect(policy).toContain("bash"); // the whitelist admitted it (policy level)
    const wire = wireNames(mockLLM);
    expect(wire).not.toContain("bash"); // shadow subtracts AFTER the whitelist
    expect([...wire].sort()).toEqual(["codemode", "contract_out", "question"]); // pinned still bypasses
    // The blacklist leg also wins DOWNWARD against the keep-direct list:
    // keep-direct never re-adds, the hook only sees what policy left.
    expect(policy).not.toContain("wait");
    expect(wire).not.toContain("wait");
    const exec = nestedDispatcher(agent, core.hooks, core.toolRegistry);
    expect((await exec.executeToolCall("wait", {}, { parentToolCallId: "codemode-7" })).ok).toBe(false);
    expect((await exec.executeToolCall("bash", {}, { parentToolCallId: "codemode-5" })).ok).toBe(true);
    // With the shadow ACTIVE on this profile, the whitelist leg still wins
    // downward: a name the whitelist removed is unreachable from both
    // surfaces (shadow adds nothing to dispatch authority).
    expect(await policyNames(agent).then((p) => p.includes("read"))).toBe(false);
    expect(wire).not.toContain("read");
    expect((await exec.executeToolCall("read", {}, { parentToolCallId: "codemode-6" })).ok).toBe(false);
  });
});

describe("containment + prompt-chunk agreement", () => {
  it("unloaded extension: byte-identical toolDefs, request payload untouched (no handler registered)", async () => {
    const core = createTestCore(); // NOT loaded
    populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("hi");

    expect(core.toolRegistry.has("codemode")).toBe(false);
    expect(JSON.stringify(mockLLM.lastToolDefs)).toBe(JSON.stringify(await agent.getToolDefs()));
    // Everything the loaded posture hides is plainly declared without it.
    for (const n of SHADOWED) expect(wireNames(mockLLM)).toContain(n);
  });

  it("the loaded chunk's shadow inventory == the names the wire actually lost", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent } = createFixture({ hooks: core.hooks, toolRegistry: core.toolRegistry, mockLLM });

    await agent.run("hi");

    const wire = new Set(wireNames(mockLLM));
    const actuallyShadowed = (await policyNames(agent)).filter((n) => !wire.has(n)).sort();
    expect(actuallyShadowed.length).toBeGreaterThan(0);

    const chunk = await codemodeChunk(core, agent);
    if (!chunk) throw new Error("codemode chunk missing");
    const m = /Shadowed now: ([^.]+)\./.exec(chunk.content);
    if (!m) throw new Error(`no shadow inventory in chunk: ${chunk.content}`);
    expect(m[1]!.split(", ").sort()).toEqual(actuallyShadowed);
    // The recovery directive rides with the inventory: the substitution and
    // the bounce wording the model will actually see.
    expect(chunk.content).toContain("tools.<name>({...})");
    expect(chunk.content).toContain('"not available"');
  });

  it("chunk names no inventory for an agent whose defs lack codemode (trigger-consistent, never a lie)", async () => {
    const { core } = await bootCodemode();
    populate(core.toolRegistry);
    const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
    const { agent } = createFixture({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      mockLLM,
      config: { blacklistTools: ["codemode"] },
    });
    await agent.run("hi");

    const chunk = await codemodeChunk(core, agent);
    if (!chunk) throw new Error("codemode chunk missing");
    expect(chunk.content).not.toContain("Shadowed now:");
    const defs: ToolDef[] = await agent.getToolDefs();
    expect(defs.map((d) => d.function.name)).not.toContain("codemode");
  });
});
