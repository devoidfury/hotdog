import { describe, it, expect } from "bun:test";
import { create as createModelSwitchExtension } from "../../src/extensions/model-switch/index.ts";
import { ModelTool } from "../../src/extensions/model-switch/model.ts";
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
    const result = await def.handler!(agent, null);

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
    const result = await def.handler!(agent, null);

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

describe("ModelTool", () => {
  it("has correct TOOL_NAME", () => {
    expect(ModelTool.TOOL_NAME).toBe("model");
  });

  it("generates tool definition with available models", () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    const def = tool.toToolDef();
    expect(def.function.name).toBe("model");
    expect(def.function.description).toContain("model-a");
    expect(def.function.description).toContain("model-b");
  });

  it("generates tool definition without models when registry is empty", () => {
    const tool = new ModelTool({});
    const def = tool.toToolDef();
    expect(def.function.description).toContain("list");
  });

  it("switches model successfully with onSwitchModel callback", async () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    let switchedModel = "";
    const ctx = {
      get(key: string) {
        if (key === "onSwitchModel") {
          return async (name: string) => { switchedModel = name; };
        }
        return undefined;
      },
    } as any;
    const result = await tool.execute(JSON.stringify({ name: "model-b" }), ctx);
    expect(result.output).toContain("Switched to model: model-b");
    expect(switchedModel).toBe("model-b");
  });

  it("returns message about callback when no onSwitchModel", async () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: "model-b" }), undefined);
    expect(result.output).toContain("Model tool requires a model switch callback");
  });

  it("returns error for unknown model", async () => {
    const registry = {
      "model-a": { name: "Model A" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: "unknown-model" }), {} as any);
    expect(result.error).toContain("Unknown model");
  });

  it("handles list command", async () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: "list" }), {} as any);
    expect(result.output).toContain("model-a");
    expect(result.output).toContain("model-b");
    expect(result.metadata!.get("model_count")).toBe("2");
  });

  it("handles list command with empty registry", async () => {
    const tool = new ModelTool({});
    const result = await tool.execute(JSON.stringify({ name: "list" }), {} as any);
    expect(result.output).toContain("No models registered");
    expect(result.metadata!.get("model_count")).toBe("0");
  });

  it("handles empty model name", async () => {
    const registry = {
      "model-a": { name: "Model A" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(JSON.stringify({ name: "" }), {} as any);
    expect(result.error).toContain("Error parsing arguments");
  });

  it("handles null input", async () => {
    const registry = {
      "model-a": { name: "Model A" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute(null, {} as any);
    expect(result.error).toContain("Error parsing arguments");
  });

  it("handles onSwitchModel callback error", async () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    const ctx = {
      get(key: string) {
        if (key === "onSwitchModel") {
          return async () => { throw new Error("switch failed"); };
        }
        return undefined;
      },
    } as any;
    const result = await tool.execute(JSON.stringify({ name: "model-b" }), ctx);
    expect(result.error).toContain("Error switching model");
  });

  it("handles object input directly", async () => {
    const registry = {
      "model-a": { name: "Model A" },
      "model-b": { name: "Model B" },
    };
    const tool = new ModelTool(registry);
    const result = await tool.execute({ name: "model-b" }, undefined);
    expect(result.output).toContain("model-b");
  });

  it("callDisplay formats correctly", () => {
    const tool = new ModelTool({});
    const display = tool.callDisplay(JSON.stringify({ name: "model-b" }));
    expect(display).toContain("model-b");
  });

  it("callDisplay handles null input", () => {
    const tool = new ModelTool({});
    const display = tool.callDisplay(null);
    expect(display).toBeDefined();
  });

  it("handles empty registry", () => {
    const tool = new ModelTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("model");
  });

  it("handles undefined registry", () => {
    const tool = new ModelTool(undefined as any);
    const def = tool.toToolDef();
    expect(def.function.name).toBe("model");
  });
});

describe("Model-switch extension > edge cases", () => {
  it("handles empty model registry in /models command", async () => {
    const core = createMockCore({
      modelRegistry: {},
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("models")!;
    const agent = createMockAgent({}) as any;
    const result = await def.handler!(agent, null);

    expect((result as any).content).toContain("No models configured");
  });

  it("/model command with extra whitespace in model name", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("model")!;
    const agent = createMockAgent(core.resolved.modelRegistry) as any;
    const result = await def.handler!(agent, "model   model-b  ");

    expect((result as any).content).toContain("Switched to model: model-b");
    expect(agent.model).toBe("model-b");
  });

  it("/model command with multiple spaces between words", async () => {
    const core = createMockCore({
      coreConfig: { modelSwitch: { commandEnabled: true } },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    const def = registry.get("model")!;
    const agent = createMockAgent(core.resolved.modelRegistry) as any;
    const result = await def.handler!(agent, "model  model  b");

    // split(/\s+/) splits on any whitespace, then join(" ") joins with single space
    expect((result as any).content).toContain("model b");
  });

  it("extension exposes modelTool for external use", () => {
    const core = createMockCore();
    const ext = createModelSwitchExtension(core);
    expect((ext as any).modelTool).toBeDefined();
    expect((ext as any).modelTool.constructor.TOOL_NAME).toBe("model");
  });

  it("uses empty modelRegistry when core.resolved is undefined", () => {
    const core = createMockCore({
      modelRegistry: undefined,
    });
    // Should not throw
    const ext = createModelSwitchExtension(core);
    expect(ext).not.toBeNull();
  });

  it("commandEnabled defaults to true (not false)", async () => {
    // When commandEnabled is not set, it should default to true
    // because the check is `if (config.commandEnabled === false) return;`
    const core = createMockCore({
      coreConfig: { modelSwitch: {} },
    });
    const ext = createModelSwitchExtension(core);

    const registry = createCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

    // Commands should be registered when commandEnabled is not explicitly false
    expect(registry.has("model")).toBe(true);
    expect(registry.has("models")).toBe(true);
  });
});
