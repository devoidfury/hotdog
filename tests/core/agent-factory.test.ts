import { describe, expect, it } from "bun:test";
import { createAgentFactory } from "../../src/core/agent-factory.ts";
import { HOOKS } from "../../src/core/hooks.ts";

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
        lastResult: undefined,
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
  role: "resolved-role",
  profileBody: "resolved-body",
  hideTools: true,
  hideThinking: false,
  showTokenUse: true,
  stream: true,
  modelRegistry: {},
  maxToolCallsPerIteration: 10,
  maxRetries: 5,
  toolRetryDelay: 1,
  workspaceRoots: ["/tmp"],
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
    expect(agent.role).toBe("resolved-role");
    expect(agent.profileBody).toBe("resolved-body");
    expect(agent.sessionId).toBeTruthy();
    expect(agent.sink).toBeNull();
    // config bag: raw config spread + resolved numeric overrides
    expect((agent.config as Record<string, unknown>).coreOnly).toBe(true);
    expect((agent.config as Record<string, unknown>).maxToolCallsPerIteration).toBe(10);
    // COMMANDS_REGISTER fires on every construction
    expect(calls.some((c) => c[0] === HOOKS.COMMANDS_REGISTER)).toBe(true);
  });

  it("agentConfig overrides win over resolved", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, { resolved: resolved as never, llmClient: {} as never });
    const agent = await factory({
      model: "override-model",
      maxIterations: 3,
      contextLimit: 999,
      profileName: "override-profile",
      role: "override-role",
      profileBody: "override-body",
      hideTools: false,
      hideThinking: true,
      stream: false,
      sessionId: "fixed-session",
      toolWhitelist: ["read"],
    });

    expect(agent.model).toBe("override-model");
    expect(agent.maxIterations).toBe(3);
    expect(agent.contextLimit).toBe(999);
    expect(agent.profileName).toBe("override-profile");
    expect(agent.role).toBe("override-role");
    expect(agent.profileBody).toBe("override-body");
    expect(agent.hideTools).toBe(false);
    expect(agent.hideThinking).toBe(true);
    expect(agent.stream).toBe(false);
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

  it("profile overlays apply under agentConfig overrides, over resolved", async () => {
    const { core } = makeCore();
    const factory = createAgentFactory(core, {
      resolved: resolved as never,
      llmClient: {} as unknown as never,
      profiles: {
        worker: {
          role: "worker-role",
          body: "worker-body",
          model: null,
          whitelistTools: ["read", "bash-tool"],
          blacklistTools: [],
        },
      },
    });

    const fromProfile = await factory({ profileName: "worker" });
    expect(fromProfile.role).toBe("worker-role");
    expect(fromProfile.profileBody).toBe("worker-body");
    expect(fromProfile.toolWhitelist).toEqual(["read", "bash-tool"]);

    const explicitRole = await factory({ profileName: "worker", role: "explicit-role" });
    expect(explicitRole.role).toBe("explicit-role");
    expect(explicitRole.profileBody).toBe("worker-body");

    // Unknown profile name: resolved values apply, no whitelist
    const unknown = await factory({ profileName: "nope" });
    expect(unknown.role).toBe("resolved-role");
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
});
