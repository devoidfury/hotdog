/**
 * B5 -- the agent layer (design §4.2, §9 test 7): the live agent.config view.
 *
 * Unit half: liveAgentConfig over a REAL createConfigStore() -- overlay
 * wins, base lives across publishes, spread/keys/JSON see the union MINUS
 * AGENT_VIEW_EXCLUDED (get reads through), set lands in the overlay,
 * base-only deletes THROW (strict mode), overlay deletes fall to the base.
 *
 * Integration half: the DEFAULT (store-backed) factory path -- trust pins
 * (P5) do NOT move under a running agent through the REAL §2.4 transaction;
 * the unpinned scalars (maxRetries/toolRetryDelay/maxToolResultChars) DO;
 * cli-layer provenance (resolved-first); applyProfile writes survive base
 * publishes; MODEL_CHANGE unaffected; /tokens follows a mid-session pricing
 * publish; the ToolExecutor cap follows a mid-session knob change at the NEXT
 * finalize. Hosts passing explicit options.config/options.resolved stay
 * PINNED BY CONSTRUCTION (pins live in agent-factory.test.ts).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../../mocks/io.ts";
import { getDefaultConfig } from "@core/config/index.ts";
import { createConfigStore, type ConfigStore } from "@core/config/store.ts";
import { createCore, type CoreInfrastructure } from "@core/main.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import { createAgentFactory, type AgentBuildFn } from "@core/agent-factory.ts";
import { liveAgentConfig, AGENT_VIEW_EXCLUDED } from "@core/config/agent-view.ts";
import { createToolExecutor, type ToolExecutorDeps } from "@core/tool-executor.ts";
import { createToolRegistry, type Tool } from "@core/extensions/tool-registry.ts";
import { createHooks } from "@core/hooks.ts";
import { Agent } from "@core/agent.ts";
import { handleTokens } from "@core/command-handlers.ts";
import { Workspace, expandWorkspacePaths } from "@utils/workspace.ts";
import { applyConfigKeyEdit } from "@extensions/websocket/handlers-config.ts";
import { bootResolved, fsDeps, seedFile, withShadowEnvCleared } from "./probes.ts";

// ── unit: the proxy itself over a real store ────────────────────────────────

function unitStore(
  config: Record<string, unknown>,
  resolved: Record<string, unknown>,
): ConfigStore {
  const store = createConfigStore();
  store.adopt(config as never, resolved as never);
  return store;
}

function publish(
  store: ConfigStore,
  over: { config?: Record<string, unknown>; resolved?: Record<string, unknown> },
): void {
  const g = store.current();
  const commit = store.swap({
    config: { ...(g.config as object), ...(over.config ?? {}) } as never,
    resolved: { ...((g.resolved ?? {}) as object), ...(over.resolved ?? {}) } as never,
  });
  commit();
}

describe("agent-view proxy (unit, real ConfigStore)", () => {
  it("AGENT_VIEW_EXCLUDED is EXACTLY the §4.2/§9-test-7 set", () => {
    expect([...AGENT_VIEW_EXCLUDED].sort()).toEqual([
      "model",
      "modelRegistry",
      "profileDef",
      "profileManager",
      "profiles",
      "systemPromptTemplate",
    ]);
  });

  it("overlay own props win over base; unpinned keys ride the base", () => {
    const store = unitStore({ k: "bag" }, { k: "resolved", pin: "resolved-pin" });
    const view = liveAgentConfig(store, { pin: "overlay-pin" });
    expect(view.k).toBe("resolved"); // resolved-first provenance
    expect(view.pin).toBe("overlay-pin"); // overlay wins
  });

  it("base values live across a publish: unpinned reads NEW, pins do not move", () => {
    const store = unitStore({ n: 1 }, { pin: 1 });
    const view = liveAgentConfig(store, { pin: 1 });
    expect(view.n).toBe(1);
    publish(store, { config: { n: 2 }, resolved: { pin: 99, added: "new" } });
    expect(store.current().batchId).toBe(1);
    expect(view.n).toBe(2); // unpinned base key moved with the generation
    expect(view.added).toBe("new"); // NEW keys are visible too
    expect(view.pin).toBe(1); // the overlay pin does not move
  });

  it("has() means a value EXISTS: resolved's undefined slots fall to config, then absent", () => {
    const store = unitStore({ slotKey: "from-bag" }, { slotKey: undefined, hasVal: 2 });
    const view = liveAgentConfig(store, {});
    expect("slotKey" in view).toBe(true); // the undefined resolved slot falls to the bag
    expect(view.slotKey).toBe("from-bag");
    expect("hasVal" in view).toBe(true);
    expect("absent" in view).toBe(false);
  });

  it("spread/keys/JSON see the union MINUS AGENT_VIEW_EXCLUDED; get() still reads through", () => {
    const manager = { __profileManager: true };
    const registry = { "vendor/model": {} };
    const store = unitStore(
      { bagKey: 1, modelPricing: {} },
      {
        resolvedKey: 2,
        model: "m1",
        modelRegistry: registry,
        profileManager: manager,
        profileDef: { manager: false },
        profiles: { alt: {} },
        systemPromptTemplate: "T",
      },
    );
    const view = liveAgentConfig(store, { pinned: 1 });
    const keys = Object.keys(view);
    const spreadKeys = Object.keys({ ...view });
    const jsonKeys = Object.keys(JSON.parse(JSON.stringify(view)) as Record<string, unknown>);
    for (const set of [keys, spreadKeys, jsonKeys]) {
      expect(set).toContain("bagKey");
      expect(set).toContain("resolvedKey");
      expect(set).toContain("pinned");
      expect(set).toContain("modelPricing");
      for (const excluded of AGENT_VIEW_EXCLUDED) expect(set).not.toContain(excluded);
    }
    expect(keys.length).toBe(new Set(keys).size); // union, no duplicates
    // get() reads the excluded artifacts through (the factory consumes them
    // via its own resolved reads; nothing ENUMERATED ships live objects).
    expect(view.model).toBe("m1");
    expect(view.modelRegistry).toBe(registry);
    expect(view.profileManager).toBe(manager);
    expect(view.profileDef).toEqual({ manager: false });
    expect(view.systemPromptTemplate).toBe("T");
  });

  it("getOwnPropertyDescriptor: enumerable + configurable for union keys (spread survives)", () => {
    const store = unitStore({ bagKey: 1 }, { resolvedKey: 2 });
    const view = liveAgentConfig(store, {});
    const d = Object.getOwnPropertyDescriptor(view, "resolvedKey");
    expect(d).toBeDefined();
    expect(d!.enumerable).toBe(true);
    expect(d!.configurable).toBe(true);
    expect(d!.value).toBe(2);
  });

  it("set lands in the overlay and shadows the base through later publishes", () => {
    const store = unitStore({ custom: "boot" }, {});
    const view = liveAgentConfig(store, {});
    view.custom = "mine";
    expect(view.custom).toBe("mine");
    publish(store, { config: { custom: "next-gen" } });
    expect(view.custom).toBe("mine"); // the write pinned over the live base
    // The store's generation never saw the write.
    expect((store.current().config as Record<string, unknown>).custom).toBe("next-gen");
  });

  it("deleting a base-only key is REFUSED (strict-mode throw); deleting an overlay key works", () => {
    const store = unitStore({ baseOnly: "keep" }, {});
    const view = liveAgentConfig(store, { custom: "mine" });
    // ESM = strict mode: the trap's false makes the delete THROW, loud not silent.
    expect(() => {
      delete (view as Record<string, unknown>).baseOnly;
    }).toThrow(TypeError);
    expect(view.baseOnly).toBe("keep");
    delete (view as Record<string, unknown>).custom; // overlay keys delete
    expect("custom" in view).toBe(false);
  });

  it("a spread is a point-in-time copy (the migration rule): the view itself stays live", () => {
    const store = unitStore({ knob: 1 }, {});
    const view = liveAgentConfig(store, {});
    const snap = { ...view };
    publish(store, { config: { knob: 2 } });
    expect(snap.knob).toBe(1); // frozen, by definition
    expect(view.knob).toBe(2); // the live view follows the store
  });
});

// ── integration: the DEFAULT store-backed factory path ─────────────────────

/** Schema mirror of the websocket entry (the probes.ts pattern): gives the
 *  write gate + the re-resolve's extension tail a real row. */
const WEBSOCKET_ENTRY = {
  key: "websocket",
  description: "websocket config",
  defaults: {},
  schema: {
    type: "object",
    properties: {
      sessionTimeoutMin: { type: "number", default: 30, description: "Idle session cleanup timeout (minutes)" },
      questionTimeoutSecs: { type: "number", default: 300, description: "Default question timeout (seconds)" },
    },
    layers: [{ source: "config", key: "websocket" }, { default: {} }],
  },
  layers: [{ source: "config", key: "websocket" }, { default: {} }],
};

function fakeRegistry(): never {
  return {
    getConfigParams: () => [WEBSOCKET_ENTRY],
    getCliFlags: () => [],
    getConfigParamsRaw: () => [WEBSOCKET_ENTRY],
  } as never;
}

interface AgentHost {
  dir: string;
  core: CoreInfrastructure;
  store: ConfigStore;
  build: AgentBuildFn;
  cleanup(): void;
}

/** A live host without the ws server: real createCore (store-backed
 *  accessors) + the resolved-adopt + the DEFAULT factory (options pass
 *  neither config nor resolved -> the B5 live path). The resolved bag carries
 *  the agent-critical scalars the hand-built boot bag needs. */
async function bootAgentHost(
  over: { seed?: Record<string, unknown>; resolved?: Record<string, unknown> } = {},
): Promise<AgentHost> {
  const dir = mkdtempSync(join(TMP_PARENT, "hotdog-agentview-"));
  const seed: Record<string, unknown> = { ...seedFile(), workspace: { paths: [dir] }, ...over.seed };
  writeFileSync(join(dir, "defaults.json"), JSON.stringify(seed, null, 2) + "\n");
  const store = createConfigStore();
  const configBag = {
    ...getDefaultConfig(),
    ...seed,
    websocket: (seed.websocket as Record<string, unknown> | undefined) ?? { sessionTimeoutMin: 30 },
  };
  const core = createCore(configBag as never, fakeRegistry(), createSubcommandRegistry(), { store });
  core.resolved = bootResolved(dir, {
    maxToolCallsPerIteration: 4,
    maxEmptyRetries: 1,
    maxToolResultChars: 600,
    toolRetryDelay: 0,
    profileDef: null,
    profiles: {},
    profileManager: { __marker: true },
    systemPromptTemplate: "VIEW: {{ body }}",
    ...over.resolved,
  });
  const build = createAgentFactory(core, { llmClient: {} as never });
  return {
    dir,
    core,
    store,
    build,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function cfg(agent: Agent): Record<string, unknown> {
  return agent.config as Record<string, unknown>;
}

/** An executor wired EXACTLY like the Agent ctor wires its own (the deps
 *  scalars are the build-time reads of the same live view), on a private
 *  registry -- the observable seam without reaching into #toolExecutor. */
function mimicExecutor(
  agent: Agent,
  tools: Record<string, Tool>,
): { executor: ReturnType<typeof createToolExecutor>; run: (name: string, args?: Record<string, unknown>) => Promise<{ output: string }> } {
  const toolRegistry = createToolRegistry();
  for (const [name, tool] of Object.entries(tools)) toolRegistry.register(name, tool);
  const deps: ToolExecutorDeps = {
    toolRegistry,
    hooks: createHooks(),
    emitOutput: () => {},
    workspaceRoots: (cfg(agent).workspaceRoots as string[] | undefined) ?? null,
    workspaceDeny: (cfg(agent).workspaceDeny as readonly string[] | null | undefined) ?? null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent,
    // The Agent ctor passes the BUILD-TIME read of the same view; the
    // executor must still follow the view per finalize (the point of B5).
    maxToolResultChars: cfg(agent).maxToolResultChars as number | undefined,
  };
  const executor = createToolExecutor(deps);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await executor.executeSingle(
      { id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } } as never,
      new Set([name]),
    );
    const parts = r.content as Array<{ output: string }>;
    return { output: parts[0]!.output as string };
  };
  return { executor, run };
}

function textTool(name: string, text: string): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: () => ({
      type: "function",
      function: { name, description: "t", parameters: { type: "object", properties: {}, required: [] } },
    }),
    execute: async () => text,
  };
}

/** Returns "allowed"/"refused" for ctx.workspace.resolveSafe(input.path) --
 *  the P5 observable: which roots THIS agent's workspace accepts. */
function resolveProbeTool(name: string): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: () => ({
      type: "function",
      function: { name, description: "t", parameters: { type: "object", properties: {}, required: [] } },
    }),
    execute: async (input: string | Record<string, unknown> | null, ctx: unknown) => {
      // The executor hands tools the RAW arguments string (validation parses a
      // copy); accept both spellings.
      const args = typeof input === "string" ? (JSON.parse(input) as { path?: string }) : input;
      const target = String(args?.path ?? "");
      const workspace = (ctx as { get(key: string): Workspace }).get("workspace");
      try {
        workspace.resolveSafe(target);
        return "allowed";
      } catch {
        return "refused";
      }
    },
  };
}

async function runWorkspaceTransaction(
  host: AgentHost,
  dirB: string,
): Promise<void> {
  // The seed's workspace.paths holds exactly one element; the chrome grammar
  // edits the ELEMENT (a wholesale list write is refused -- honest gate).
  const res = await withShadowEnvCleared(() =>
    applyConfigKeyEdit(host.core, "workspace.paths[0]", { value: dirB }, { deps: fsDeps }),
  );
  if (!res.ok) throw new Error(`transaction refused: ${res.error}`);
}

describe("agent-view factory (B5 live path)", () => {
  let host: AgentHost | undefined;
  afterEach(() => {
    host?.cleanup();
    host = undefined;
  });

  it("agent.config on the default path IS the live view; excluded artifacts never ride spreads", async () => {
    host = await bootAgentHost({ seed: { modelPricing: {} } });
    const h = host;
    const agent = await h.build();
    const spreadKeys = Object.keys({ ...cfg(agent) });
    for (const excluded of AGENT_VIEW_EXCLUDED) expect(spreadKeys).not.toContain(excluded);
    expect(JSON.stringify(cfg(agent))).not.toContain("profileManager");
    expect(cfg(agent).modelPricing).toEqual({}); // config tier rides through
    // unpinned base movement vs pinned overlay (the pin set of §4.2)
    publish(h.store, { resolved: { maxRetries: 3 } });
    expect(cfg(agent).maxRetries).toBe(3);
    const roots = cfg(agent).workspaceRoots;
    publish(h.store, { resolved: { workspaceRoots: ["/moved"], maxRetries: 4 } });
    expect(cfg(agent).workspaceRoots).toBe(roots); // trust pin holds
    expect(cfg(agent).maxRetries).toBe(4);
  });

  it("P5 trust pin: a workspaceRoots write through the REAL transaction never moves a running agent; a new agent gets the new roots", async () => {
    host = await bootAgentHost();
    const h = host;
    const dirB = mkdtempSync(join(TMP_PARENT, "hotdog-agentview-b-"));
    writeFileSync(join(h.dir, "a.txt"), "a");
    writeFileSync(join(dirB, "b.txt"), "b");
    const agent1 = await h.build();
    const exec1 = mimicExecutor(agent1, { probe: resolveProbeTool("probe") });
    expect(await exec1.run("probe", { path: join(h.dir, "a.txt") })).toEqual({ output: "allowed" });
    expect(await exec1.run("probe", { path: join(dirB, "b.txt") })).toEqual({ output: "refused" });

    await runWorkspaceTransaction(h, dirB);

    // The store really moved.
    expect((h.store.current().resolved as Record<string, unknown>).workspaceRoots).toEqual(
      expandWorkspacePaths([dirB]),
    );
    // The EXISTING agent: config view AND its Workspace accept-set unchanged.
    expect(cfg(agent1).workspaceRoots).toEqual([h.dir]);
    expect(await exec1.run("probe", { path: join(h.dir, "a.txt") })).toEqual({ output: "allowed" });
    expect(await exec1.run("probe", { path: join(dirB, "b.txt") })).toEqual({ output: "refused" });
    // A NEW agent reflects the change (P5's exact probe shape).
    const agent2 = await h.build();
    expect(cfg(agent2).workspaceRoots).toEqual(expandWorkspacePaths([dirB]));
    const exec2 = mimicExecutor(agent2, { probe: resolveProbeTool("probe") });
    expect(await exec2.run("probe", { path: join(dirB, "b.txt") })).toEqual({ output: "allowed" });
    expect(await exec2.run("probe", { path: join(h.dir, "a.txt") })).toEqual({ output: "refused" });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("same-pinned: sandboxMode / maxToolDifficulty / maxIterations are next-session, never live promises", async () => {
    host = await bootAgentHost({ resolved: { sandboxMode: false, maxToolDifficulty: 2, maxIterations: 9 } });
    const h = host;
    const agent1 = await h.build();
    expect(cfg(agent1).sandboxMode).toBe(false);
    expect(cfg(agent1).maxToolDifficulty).toBe(2);
    expect(cfg(agent1).maxIterations).toBe(9);
    publish(h.store, {
      config: { sandboxMode: true, maxToolDifficulty: 5, maxIterations: 99 },
      resolved: { sandboxMode: true, maxToolDifficulty: 5, maxIterations: 99 },
    });
    expect(cfg(agent1).sandboxMode).toBe(false);
    expect(cfg(agent1).maxToolDifficulty).toBe(2);
    expect(cfg(agent1).maxIterations).toBe(9);
    expect(agent1.maxIterations).toBe(9); // the loop's ctor field, unchanged too
    const agent2 = await h.build();
    expect(cfg(agent2).sandboxMode).toBe(true);
    expect(cfg(agent2).maxToolDifficulty).toBe(5);
    expect(cfg(agent2).maxIterations).toBe(99);
    expect(agent2.maxIterations).toBe(99); // next-session
  });

  it("unpinned: a maxRetries write through the REAL transaction moves the existing agent's next read AND new builds", async () => {
    host = await bootAgentHost();
    const h = host;
    const agent1 = await h.build();
    expect(cfg(agent1).maxRetries).toBe(5);
    const res = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(h.core, "maxRetries", { value: 2 }, { deps: fsDeps }),
    );
    if (!res.ok) throw new Error(`transaction refused: ${res.error}`);
    expect(cfg(agent1).maxRetries).toBe(2); // live, unpinned
    const agent2 = await h.build();
    expect(cfg(agent2).maxRetries).toBe(2);
    // toolRetryDelay is the same class (store-level publish here): live too.
    publish(h.store, { config: { toolRetryDelay: 7 }, resolved: { toolRetryDelay: 7 } });
    expect(cfg(agent1).toolRetryDelay).toBe(7);
    expect(cfg(agent2).toolRetryDelay).toBe(7);
  });

  it("cli-layer provenance: the base chain answers the RESOLVED-layered value, not the config bag's", async () => {
    // The boot posture a bare config-bag base would silently drop: the file
    // says showTokenUse:false / maxIterations:99, the cli layer (--tokens,
    // --max-iterations) says true / 7.
    host = await bootAgentHost({
      seed: { showTokenUse: false, maxIterations: 99 },
      resolved: { showTokenUse: true, maxIterations: 7 },
    });
    const h = host;
    const bag = h.store.current().config as Record<string, unknown>;
    expect(bag.showTokenUse).toBe(false);
    expect(bag.maxIterations).toBe(99);
    const agent = await h.build();
    expect(cfg(agent).showTokenUse).toBe(true); // resolved-first through the view
    expect(cfg(agent).maxIterations).toBe(7);
    expect(agent.maxIterations).toBe(7); // the ctor field agrees
  });

  it("applyProfile writes land in the overlay and survive later base publishes", async () => {
    host = await bootAgentHost();
    const h = host;
    const agent = await h.build();
    agent.applyProfile("alt", {
      body: "alt-body",
      model: null,
      whitelistTools: null,
      blacklistTools: ["alt-black"],
      manager: false,
    });
    expect(cfg(agent).blacklistTools).toEqual(["alt-black"]); // the write pinned the overlay
    publish(h.store, { config: { blacklistTools: ["pub-black"] } });
    expect(cfg(agent).blacklistTools).toEqual(["alt-black"]); // survives the publish
    const fresh = await h.build(); // new agents see the new base... only if
    // the bag layer actually sources it -- the overlay pin for NEW agents
    // follows the profile/startup chain, and the raw bag feeds it (unchanged doctrine).
    expect((fresh.config as Record<string, unknown>).blacklistTools ?? null).not.toEqual(["alt-black"]);
  });

  it("MODEL_CHANGE is unaffected: agent.model is never config", async () => {
    host = await bootAgentHost();
    const h = host;
    const agent = await h.build();
    expect(agent.model).toBe("boot/model");
    agent.model = "switched/model"; // the /model path (agent.model setter)
    publish(h.store, { resolved: { model: "published/model" } });
    expect(agent.model).toBe("switched/model"); // untouched by the publish
    const fresh = await h.build();
    expect(fresh.model).toBe("published/model"); // new agents take the new default
  });

  it("options.profiles migrates: the default path reads resolved.profiles per build", async () => {
    host = await bootAgentHost();
    const h = host;
    publish(h.store, {
      resolved: {
        profiles: {
          alt: {
            body: "alt-body",
            model: null,
            whitelistTools: ["read"],
            blacklistTools: [],
            manager: false,
          },
        },
      },
    });
    const agent = await h.build({ profileName: "alt" }); // no options.profiles anywhere
    expect(agent.profileBody).toBe("alt-body");
    expect(agent.toolWhitelist).toEqual(["read"]);
  });

  it("consumer transparency: /tokens reads modelPricing through the view and follows a publish", async () => {
    const pricing = { "vendor/model": { input: 3, cachedInput: 0.3, output: 15 } };
    host = await bootAgentHost({
      seed: { modelPricing: pricing },
      resolved: { model: "vendor/model" },
    });
    const h = host;
    const agent = await h.build();
    agent.context.recordUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens: 200,
      total_tokens: 1200,
    });
    const before = handleTokens(agent).content ?? "";
    expect(before).toContain("$0.0049"); // 600/1e6*3 + 400/1e6*0.3 + 200/1e6*15
    publish(h.store, {
      config: { modelPricing: { "vendor/model": { input: 3, cachedInput: 0.3, output: 1500 } } },
    });
    const after = handleTokens(agent).content ?? "";
    // 600/1e6*3 + 400/1e6*0.3 + 200/1e6*1500 = $0.30 at the printer's scale.
    expect(after).toContain("$0.3"); // the config tier is live through the view
    expect(after).not.toBe(before);
  });

  it("ToolExecutor cap follows a mid-session maxToolResultChars change at the NEXT finalize", async () => {
    host = await bootAgentHost({ resolved: { maxToolResultChars: 600 } });
    const h = host;
    const agent = await h.build();
    const { run } = mimicExecutor(agent, { big: textTool("big", "x".repeat(5000)) });
    const first = await run("big");
    expect(first.output).toContain("[output truncated");
    expect(first.output.length).toBeLessThanOrEqual(600);
    publish(h.store, { config: { maxToolResultChars: 150 }, resolved: { maxToolResultChars: 150 } });
    const second = await run("big");
    expect(second.output.length).toBeLessThanOrEqual(150);
    expect(second.output.length).toBeLessThan(first.output.length);
  });
});
