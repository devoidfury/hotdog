import { describe, it, expect } from "bun:test";
import { create as createModelSwitchExtension } from "../../src/extensions/model-switch/index.ts";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { createCommandRegistry } from "../../src/core/extensions/registries.ts";

function createMockCore(config: any = {}) {
  return {
    hooks: new HookSystem(),
    config: config.coreConfig || {},
    resolved: {
      modelRegistry: config.modelRegistry || {
        "model-a": { name: "Model A" },
        "model-b": { name: "Model B" },
      },
    },
    toolRegistry: new ToolRegistry(),
  } as any;
}

function createMockAgent(modelRegistry = {}) {
  return {
    modelRegistry: modelRegistry,
    model: "model-a",
    context: [],
    clearContext: async function () {
      this.context = [];
    },
  };
}

describe("Model-switch extension", () => {
  it("registers model tool when toolEnabled is true", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);
    expect(ext).not.toBeNull();

    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("model")).toBe(true);
  });

  it("does not register model tool when toolEnabled is false", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: false } },
    });
    const ext = createModelSwitchExtension(core);

    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("model")).toBe(false);
  });

  it("does not register model tool when toolEnabled is undefined (defaults to false)", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: {} },
    });
    const ext = createModelSwitchExtension(core);

    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("model")).toBe(false);
  });

  it("registers commands when commandEnabled is true", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    expect(registry.has("model")).toBe(true);
    expect(registry.has("models")).toBe(true);
  });

  it("does not register commands when commandEnabled is false", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: false } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    expect(registry.has("model")).toBe(false);
    expect(registry.has("models")).toBe(false);
  });

  it("can enable tool but disable command", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: true, commandEnabled: false } },
    });
    const ext = createModelSwitchExtension(core);

    // Tool should be registered
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("model")).toBe(true);

    // Commands should not be registered
    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);
    expect(registry.has("model")).toBe(false);
    expect(registry.has("models")).toBe(false);
  });

  it("can disable tool but enable command", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { toolEnabled: false, commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    // Tool should not be registered
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("model")).toBe(false);

    // Commands should be registered
    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);
    expect(registry.has("model")).toBe(true);
    expect(registry.has("models")).toBe(true);
  });

  it("/models command lists available models", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("models")!;
    const agent = createMockAgent(core.resolved.modelRegistry) as any;
    const result = await def.handler!(agent);

    expect((result as any).content).toContain("Available models:");
    expect((result as any).content).toContain("model-a");
    expect((result as any).content).toContain("model-b");
    expect((result as any).content).toContain("Currently using: model-a");
  });

  it("/models command shows message when no models configured", async () => {
    const core = createMockCore({
      modelRegistry: {},
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("models")!;
    const agent = createMockAgent({}) as any;
    const result = await def.handler!(agent);

    expect((result as any).content).toContain("No models configured");
  });

  it("/model command switches model", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("model")!;
    const agent = createMockAgent(core.resolved.modelRegistry) as any;
    const result = await def.handler!(agent, "model model-b");

    expect((result as any).content).toContain("Switched to model: model-b");
    expect(agent.model).toBe("model-b");
  });

  it("/model command without name shows available models", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("model")!;
    const agent = createMockAgent(core.resolved.modelRegistry) as any;
    const result = await def.handler!(agent, "model");

    expect((result as any).content).toContain("Available models:");
    expect((result as any).content).toContain("model-a");
    expect((result as any).content).toContain("model-b");
  });

  it("does not have imperative config hooks (config comes from extension.json)", () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);

    // Config params come from extension.json configSchema, not from imperative hooks
    expect(ext.hooks).not.toHaveProperty("config:cliFlagsRegister");
    expect(ext.hooks).not.toHaveProperty("config:paramsRegister");
  });
});
