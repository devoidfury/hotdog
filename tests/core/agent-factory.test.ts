import { describe, expect, it } from "bun:test";
import { createAgentFactory, wireSessionEndReap } from "@core/agent-factory.ts";
import { handleTokens } from "@core/command-handlers.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { ProfileManager } from "@core/config/profiles.ts";
import { createConfigStore } from "@core/config/store.ts";

function makeCore(overrides: Record<string, unknown> = {}) {
  const calls: [string, unknown][] = [];
  const core = {
    hooks: {
      notifyHooks: (...args: [string, unknown]) => {
        calls.push(args);
      },
      on: () => () => {},
      runHookPipeline: async () => ({
        results: [],
        stopped: false,
        data: {},
      }),
    },
    toolRegistry: {},
    config: { coreOnly: true },
    ...overrides,
  };
  return { core: core as never, calls };
}

const resolved = {
  model: "resolved-model",
  maxIterations: 50,
  contextLimit: 128000,
  profileName: "resolved-profile",
  profileBody: "resolved-body",
  hideTools: true,
  hideThinking: false,
  showTokenUse: true,
  modelRegistry: {},
  maxToolCallsPerIteration: 10,
  maxRetries: 5,
  toolRetryDelay: 1,
  workspaceRoots: ["/tmp"],
  workspaceDeny: ["secrets*"],
  // Tool-exec plane keys are schema-owned and required on the resolved bag
  // (production resolveAll always carries them); hand-built bags set them.
  toolExec: "inline",
  execFence: "probe",
};

describe("createAgentFactory", () => {
  it("assembles an agent from resolved config", async () => {
    const { core, calls } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory();

    expect(agent.model).toBe("resolved-model");
    expect(agent.maxIterations).toBe(50);
    expect(agent.contextLimit).toBe(128000);
    expect(agent.profileName).toBe("resolved-profile");
    expect(agent.profileBody).toBe("resolved-body");
    expect(agent.sessionId).toBeTruthy();
    expect(agent.sink).toBeNull();
    // config bag: raw config spread + resolved numeric overrides
    expect((agent.config as Record<string, unknown>).coreOnly).toBe(true);
    expect((agent.config as Record<string, unknown>).maxToolCallsPerIteration).toBe(10);
    expect((agent.config as Record<string, unknown>).workspaceDeny).toEqual(["secrets*"]);
    // COMMANDS_REGISTER fires on every construction
    expect(calls.some((c) => c[0] === HOOKS.COMMANDS_REGISTER)).toBe(true);
  });

  it("carries a user-configured workspace.deny into agent config (regression)", async () => {
    // workspace.deny is resolved into resolved.workspaceDeny, but the factory
    // previously only forwarded workspaceRoots, so ToolExecutor fell back to
    // the built-in DEFAULT_DENY_PATTERNS and the user's deny list was
    // silently ignored in every factory-based UI.
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory();
    expect((agent.config as Record<string, unknown>).workspaceDeny).toEqual(["secrets*"]);
  });

  it("survives an explicit empty workspaceDeny (denylist disabled)", async () => {
    // docs/config-reference.md: an explicit [] disables the denylist. [] must
    // reach the agent as [], not be coerced to null (built-in defaults).
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: { ...resolved, workspaceDeny: [] } as never,
      llmClient: {} as never,
    });
    const agent = await factory();
    expect((agent.config as Record<string, unknown>).workspaceDeny).toEqual([]);
  });

  it("passes the resolved system prompt template into the agent (regression)", async () => {
    // buildConfig loads the template once and resolves it to text; the
    // factory must forward it so the prompt never depends on process-global
    // template caching (multi-session hosts resolve config per entry point).
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: { ...resolved, systemPromptTemplate: "FACTORY: {{ body }}" } as never,
      llmClient: {} as never,
    });
    const agent = await factory();
    await agent.ensureSystemPrompt();
    expect(agent.context.getSystemPrompt()).toContain("FACTORY: resolved-body");
  });

  it("yields null workspaceDeny when unresolved (built-in defaults apply)", async () => {
    // Custom hosts may pass a partial resolved bag; null signals "unconfigured"
    // so ToolExecutor applies the built-in DEFAULT_DENY_PATTERNS.
    const { core } = makeCore();
    const rest = { ...resolved } as Record<string, unknown>;
    delete rest.workspaceDeny;
    const factory = createAgentFactory(core, { resolved: rest as never, llmClient: {} as never });
    const agent = await factory();
    expect((agent.config as Record<string, unknown>).workspaceDeny).toBeNull();
  });

  it("agentConfig overrides win over resolved", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory({
      model: "override-model",
      maxIterations: 3,
      contextLimit: 999,
      profileName: "override-profile",
      profileBody: "override-body",
      hideTools: false,
      hideThinking: true,
      sessionId: "fixed-session",
      toolWhitelist: ["read"],
    });

    expect(agent.model).toBe("override-model");
    expect(agent.maxIterations).toBe(3);
    expect(agent.contextLimit).toBe(999);
    expect(agent.profileName).toBe("override-profile");
    expect(agent.profileBody).toBe("override-body");
    expect(agent.hideTools).toBe(false);
    expect(agent.hideThinking).toBe(true);
    expect(agent.sessionId).toBe("fixed-session");
    expect(agent.toolWhitelist).toEqual(["read"]);
  });

  it("passes agentConfig.sink through (task-result delivery regression)", async () => {
    // TaskManager.spawnTask hands a silent sink with onTaskComplete through
    // buildAgent; dropping it silently breaks delegate_task result delivery.
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    let completed = "";
    const sink = { emit: () => {}, onTaskComplete: (r: string) => { completed = r; } };

    const agent = await factory({ sink });
    expect(agent.sink).toBe(sink);
    agent.notifyCompletion("task result");
    expect(completed).toBe("task result");
  });

  it("an explicit empty profileBody stays empty (frontmatter-only worker profile)", async () => {
    // Regression: `||` fallthrough grafted the session profile's body onto
    // workers whose profile declared no body (meta prompt in a task-default worker).
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory({ profileName: "task-default", profileBody: "" });
    expect(agent.profileBody).toBe("");
  });

  it("profile overlays apply under agentConfig overrides, over resolved", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: resolved as never,
      llmClient: {} as unknown as never,
      profiles: {
        worker: {
          body: "worker-body",
          model: null,
          whitelistTools: ["read", "bash-tool"],
          blacklistTools: [],
          manager: false,
        },
      },
    });

    const fromProfile = await factory({ profileName: "worker" });
    expect(fromProfile.profileBody).toBe("worker-body");
    expect(fromProfile.toolWhitelist).toEqual(["read", "bash-tool"]);

    const explicitBody = await factory({ profileName: "worker", profileBody: "explicit-body" });
    expect(explicitBody.profileBody).toBe("explicit-body");

    // Unknown profile name: resolved values apply, no whitelist
    const unknown = await factory({ profileName: "nope" });
    expect(unknown.profileBody).toBe("resolved-body");
    expect(unknown.toolWhitelist).toBeNull();
  });

  it("defaults resolved/config from core when not provided", async () => {
    const { core } = makeCore({ resolved });
    const factory = createAgentFactory(core, { llmClient: {} as never });
    const agent = await factory();
    expect(agent.model).toBe("resolved-model");
    expect((agent.config as Record<string, unknown>).coreOnly).toBe(true);
  });

  it("empty agentConfig is valid", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory();
    expect(agent).toBeDefined();
  });

  it("carries modelPricing from the config bag through to the /tokens cost line", async () => {
    // The pricing table rides the raw config bag (no dedicated Agent option);
    // this pins that chain end to end: config -> Agent.config -> handleTokens.
    const pricing = { "vendor/model": { input: 3, cachedInput: 0.3, output: 15 } };
    const { core } = makeCore({ config: { modelPricing: pricing } });
    const factory = createAgentFactory(core, {
      resolved: { ...resolved, model: "vendor/model" } as never,
      llmClient: {} as never,
    });
    const agent = await factory();

    // 1,000 raw prompt tokens of which 400 were cache hits: the tracker nets
    // them, so the cost must bill 600 input + 400 cached, never 1,000 input.
    agent.context.recordUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens: 200,
      total_tokens: 1200,
    });
    const costLines = (handleTokens(agent).content ?? "")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("cost:"));
    // 600/1e6*3 + 400/1e6*0.3 + 200/1e6*15 = 0.00492 (same numbers for the only call)
    expect(costLines).toHaveLength(2);
    expect(costLines[0]).toContain("$0.0049");

    // Same table, unmapped model: honest unpriced line, no invented rate.
    const otherFactory = createAgentFactory(
      makeCore({ config: { modelPricing: pricing } }).core,
      { resolved: { ...resolved, model: "vendor/other" } as never, llmClient: {} as never },
    );
    const other = await otherFactory();
    other.context.recordUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(handleTokens(other).content).toContain("model 'vendor/other' has no modelPricing entry");
  });
});

describe("createAgentFactory startup profile filters (regression: --profile ran unfiltered)", () => {
  const withProfileDef = {
    ...resolved,
    profileName: "meta",
    profileDef: {
      whitelistTools: ["read", "delegate_task"],
      blacklistTools: ["overwrite"],
      manager: true,
    },
  };

  it("applies resolved profileDef whitelist when no overlay is passed (CLI shape)", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: withProfileDef as never,
      llmClient: {} as never,
    });
    const agent = await factory();
    expect(agent.toolWhitelist).toEqual(["read", "delegate_task"]);
    expect((agent.config as Record<string, unknown>).blacklistTools).toEqual(["overwrite"]);
    expect(agent.managerProfile).toBe(true);
  });

  it("an explicit toolWhitelist null (task worker) does NOT inherit the session whitelist", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: withProfileDef as never,
      llmClient: {} as never,
    });
    const worker = await factory({ toolWhitelist: null, blacklistTools: null });
    expect(worker.toolWhitelist).toBeNull();
    expect((worker.config as Record<string, unknown>).blacklistTools ?? null).toBeNull();
  });

  it("an explicitly requested profile never inherits startup profileDef filters", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: withProfileDef as never,
      llmClient: {} as never,
    });
    const agent = await factory({ profileName: "other" });
    expect(agent.toolWhitelist).toBeNull();
    expect(agent.managerProfile).toBe(false);
  });

  it("profile overlay wins over profileDef and a null overlay whitelist stays null", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: withProfileDef as never,
      llmClient: {} as never,
      profiles: {
        meta: { body: "", model: null, whitelistTools: null, blacklistTools: [], manager: false },
        auditor: {
          body: "",
          model: null,
          whitelistTools: ["read"],
          blacklistTools: ["bash"],
          manager: false,
        },
      },
    });
    const switched = await factory({ profileName: "meta" });
    expect(switched.toolWhitelist).toBeNull();
    expect(switched.managerProfile).toBe(false);

    const auditor = await factory({ profileName: "auditor" });
    expect(auditor.toolWhitelist).toEqual(["read"]);
    expect((auditor.config as Record<string, unknown>).blacklistTools).toEqual(["bash"]);
  });
});

// ── M-5: the worker plane wires SESSION_END to the pool reaper ──────────────

describe("wireSessionEndReap", () => {
  /** A recording link: the pool side is the broker's job, here it is a mock. */
  function fakeLink() {
    const reaped: (string | undefined)[] = [];
    const link = {
      invoke: async () => {
        throw new Error("not used");
      },
      close: async () => {},
      reap: (session?: string) => {
        reaped.push(session);
      },
    };
    return { link: link as never, reaped };
  }

  it("reaps exactly the session that ended, on every SESSION_END", async () => {
    const hooks = new HookSystem();
    const { link, reaped } = fakeLink();
    wireSessionEndReap(hooks, link);

    await hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: "gone" });
    expect(reaped).toEqual(["gone"]);

    // A missing or empty id reaps nothing (an unscoped reap would drop
    // every session's runners).
    await hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: undefined } as never);
    await hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: "" });
    expect(reaped).toEqual(["gone"]);
  });

  it("registers once per hook system, however many factories share it", () => {
    const hooks = new HookSystem();
    const { link: a, reaped: reapedA } = fakeLink();
    const { link: b, reaped: reapedB } = fakeLink();
    wireSessionEndReap(hooks, a);
    wireSessionEndReap(hooks, b); // second factory: no second handler
    expect(hooks.handlerCount(HOOKS.SESSION_END)).toBe(1);

    hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: "x" });
    expect(reapedA).toEqual(["x"]);
    expect(reapedB).toEqual([]);
  });

  it("a worker-plane build registers the handler on the host hooks; inline does not", async () => {
    const buildWith = async (toolExec: "worker" | "inline") => {
      const hooks = new HookSystem();
      const core = {
        hooks,
        toolRegistry: {},
        config: {},
      } as never;
      const factory = createAgentFactory(core, {
        resolved: { ...resolved, toolExec } as never,
        llmClient: {} as never,
      });
      const agent = await factory();
      return { hooks, agent };
    };

    const inline = await buildWith("inline");
    expect(inline.hooks.handlerCount(HOOKS.SESSION_END)).toBe(0);

    const worker = await buildWith("worker");
    expect(worker.hooks.handlerCount(HOOKS.SESSION_END)).toBe(1);
  });
});

// ── B3: the profile overlay is read PER BUILD through the live surface ──────
// The reader shape websocket/server.ts wires: the map comes from the manager
// carried by the store's CURRENT resolved generation, so a profile added
// after boot lands on the next build instead of never.

describe("profile overlays through the live store (B3 generation swap)", () => {
  it("the next build sees a profile added by a swapped generation", async () => {
    const store = createConfigStore();
    store.adopt(
      { coreOnly: true } as never,
      { ...resolved, profileManager: new ProfileManager("/nonexistent-profiles", {}) } as never,
    );
    const core = {
      hooks: { notifyHooks: async () => ({}), on: () => () => {} },
      toolRegistry: {},
      config: {},
      get resolved() {
        return store.current().resolved;
      },
    } as never;
    const factory = createAgentFactory(core, {
      profiles: () =>
        store.current().resolved?.profileManager?.getProfilesForSwitch() ?? {},
      llmClient: {} as never,
    });

    // Generation 1: 'late' does not exist -- the build carries no overlay.
    const before = await factory({ profileName: "late" });
    expect(before.toolWhitelist).toBeNull();

    // Swap: the manager on the new generation declares 'late'.
    store.swap({
      config: { coreOnly: true } as never,
      resolved: {
        ...resolved,
        profileManager: new ProfileManager("/nonexistent-profiles", {
          late: {
            name: "late",
            description: "",
            body: "",
            model: null,
            whitelistTools: ["read"],
            blacklistTools: [],
            manager: false,
            visibleWorker: false,
          },
        }),
      } as never,
    })();

    // Next build reads the new map (the previous build's field stays what it
    // was -- build-pinned per the 4.2 invariant).
    const after = await factory({ profileName: "late" });
    expect(after.toolWhitelist).toEqual(["read"]);
    expect(before.toolWhitelist).toBeNull();
  });
});

// ── B5: the live view on the default path; explicit hosts pin by construction

describe("createAgentFactory live view (B5, design §4.2)", () => {
  it("a host passing explicit config/resolved stays PINNED even when the core carries a store", async () => {
    const store = createConfigStore();
    store.adopt({ pinnedOnly: true } as never, resolved as never);
    const { core } = makeCore({ configStore: store });
    const factory = createAgentFactory(core, {
      resolved: resolved as never,
      config: { bagOnly: 1 } as never,
      llmClient: {} as never,
    });
    const agent = await factory();
    expect((agent.config as Record<string, unknown>).maxRetries).toBe(5);

    store.swap({
      config: { pinnedOnly: true, changedBag: 1 } as never,
      resolved: { ...resolved, maxRetries: 99 } as never,
    })();

    // No proxy on this path: the construction-time copy is the agent's truth.
    expect((agent.config as Record<string, unknown>).maxRetries).toBe(5);
    expect((agent.config as Record<string, unknown>).changedBag).toBeUndefined();
  });

  it("the default core.* path with a store builds the live view: unpinned base keys move, pins and exclusions hold", async () => {
    const store = createConfigStore();
    const bag = { coreOnly: true, maxRetries: 5 };
    store.adopt(bag as never, resolved as never);
    const { core } = makeCore({ resolved, config: bag, configStore: store });
    const factory = createAgentFactory(core, { llmClient: {} as never });
    const agent = await factory();
    expect((agent.config as Record<string, unknown>).coreOnly).toBe(true);
    expect((agent.config as Record<string, unknown>).maxRetries).toBe(5);

    store.swap({
      config: { ...bag, maxRetries: 2, changedBag: 1 } as never,
      resolved: { ...resolved, maxRetries: 8, workspaceRoots: ["/moved"] } as never,
    })();

    // maxRetries rides the resolved-aware base (unpinned): live read NEW,
    // resolved-first (the bag's 2 loses to the resolved layer's 8).
    expect((agent.config as Record<string, unknown>).maxRetries).toBe(8);
    // Config-tier keys are visible through the bag tier of the chain.
    expect((agent.config as Record<string, unknown>).changedBag).toBe(1);
    // workspaceRoots is an overlay trust pin (P5): it does NOT move.
    expect((agent.config as Record<string, unknown>).workspaceRoots).toEqual(["/tmp"]);
    // The derived resolved artifacts never enumerate (get still reads them).
    const spreadKeys = Object.keys({ ...(agent.config as Record<string, unknown>) });
    expect(spreadKeys).not.toContain("modelRegistry");
    expect(spreadKeys).not.toContain("model");
    expect((agent.config as Record<string, unknown>).model).toBe("resolved-model");
  });
});
