import { describe, it, expect, beforeEach } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { ExtensionLoader } from "../../src/core/extensions/extensions.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.ts";
import { create as createCoreToolsExtension } from "../../src/extensions/core-tools/index.ts";
import { create as createSkillsExtension } from "../../src/extensions/skills/index.ts";
import { create as createPromptsExtension } from "../../src/extensions/prompts/index.ts";
import { create as createSessionLogExtension } from "../../src/extensions/session-log/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCore(config = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const serviceRegistry = {
    _services: new Map(),
    register(name, impl) {
      this._services.set(name, impl);
    },
    get(name) {
      const impl = this._services.get(name);
      if (impl === undefined) throw new Error(`Service "${name}" is not registered.`);
      return impl;
    },
    has(name) {
      return this._services.has(name);
    },
    names() {
      return Array.from(this._services.keys());
    },
    checkContract(name, expectedMethods) {
      const impl = this._services.get(name);
      if (!impl) return { valid: false, missing: expectedMethods };
      const missing = expectedMethods.filter((m) => typeof impl[m] !== "function");
      return { valid: missing.length === 0, missing };
    },
  };
  return {
    hooks,
    config: {
      compaction: config.compaction || {
        enabled: true,
        keepRecentMessages: 3,
        strategy: "summarize",
      },
      skills: config.skills || { path: "/tmp/skills-test" },
      promptsPath: config.promptsPath || "/tmp/prompts-test",
      ...config,
    },
    modelRegistry: {},
    toolRegistry,
    services: serviceRegistry,
  };
}

// Helper to wrap factory functions for ExtensionLoader
function wrapFactory(factory) {
  return { create: factory };
}

// ── Hook + Extension Integration ─────────────────────────────────────────────

describe("Hook + Extension Integration", () => {
  it("should wire up an extension to the hook system", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    const ext = await loader.load(
      "compaction",
      wrapFactory(createCompactionExtension),
    );
    expect(ext).not.toBeNull();
    expect(core.hooks.hookNames()).toContain(HOOKS.COMMANDS_REGISTER);
  });

  it("should support multiple extensions on the same hook", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load("compaction", wrapFactory(createCompactionExtension));
    await loader.load("session-log", wrapFactory(createSessionLogExtension));

    // Both should have registered their hooks
    const hookNames = core.hooks.hookNames();
    expect(hookNames).toContain(HOOKS.COMMANDS_REGISTER);
    // session-log returns hooks object but doesn't register via hooks.on()
    // The hooks are handled internally by the extension
  });

  it("should register tools from an extension", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load("core-tools", wrapFactory(createCoreToolsExtension));

    // Trigger the tools:register hook
    await core.hooks.notifyHooksAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);

    // Core tools should be registered (bash is now in bash-tool extension, fetch is in fetch-tool extension)
    const toolNames = core.toolRegistry.getAll().map(([name]) => name);
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find");
    expect(toolNames).toContain("pager");
    // bash is now registered by bash-tool extension, not core-tools
    expect(toolNames).not.toContain("bash");
    // question is now registered by question-tool extension, not core-tools
    expect(toolNames).not.toContain("question");
    // explore is disabled by default
    expect(toolNames).not.toContain("explore");
    // model is registered by model-switch extension, not core-tools
    expect(toolNames).not.toContain("model");
    // load_skill is registered by skills extension, not core-tools
    expect(toolNames).not.toContain("load_skill");
    // review is registered by session-review extension, not core-tools
    expect(toolNames).not.toContain("review");
    // project_info is registered (enabled by default)
    expect(toolNames).toContain("project_info");
  });

  it("should handle extension lifecycle: load -> use -> unload", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    // Load
    const ext = await loader.load(
      "compaction",
      wrapFactory(createCompactionExtension),
    );
    expect(ext).not.toBeNull();
    expect(loader.has("compaction")).toBe(true);
    expect(loader.size()).toBe(1);

    // Use (hooks are registered)
    expect(core.hooks.hookNames()).toContain(HOOKS.COMMANDS_REGISTER);

    // Unload
    await loader.unload("compaction");
    expect(loader.has("compaction")).toBe(false);
    expect(loader.size()).toBe(0);
  });

  it("should support disabled extensions (create returns null)", async () => {
    const core = createMockCore({ compaction: { enabled: false } });
    const loader = new ExtensionLoader(core);

    const ext = await loader.load(
      "compaction",
      wrapFactory(createCompactionExtension),
    );
    expect(ext).toBeNull();
    expect(loader.has("compaction")).toBe(false);
  });
});

// ── Skills Extension ─────────────────────────────────────────────────────────

describe("Skills Extension", () => {
  it("should create extension and expose loader", async () => {
    const core = createMockCore();
    const ext = await createSkillsExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.loader).toBeDefined();
  });

  it("should register load_skill tool", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("skills", wrapFactory(createSkillsExtension));

    // Tools are registered during load() - no need to emit hook again
    expect(core.toolRegistry.has("load_skill")).toBe(true);
  });
});

// ── Prompts Extension ────────────────────────────────────────────────────────

describe("Prompts Extension", () => {
  it("should create extension and expose loader", async () => {
    const core = createMockCore();
    const ext = await createPromptsExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.loader).toBeDefined();
  });
});

// ── Session Log Extension ────────────────────────────────────────────────────

describe("Session Log Extension", () => {
  it("should create extension with hooks", async () => {
    const core = createMockCore();
    const ext = await createSessionLogExtension(core);
    expect(ext).not.toBeNull();
    // Session log extension has hooks but sessionId/logPath are dynamic
    expect(ext.hooks).toBeDefined();
  });

  it("should register hooks for message logging", async () => {
    const core = createMockCore();
    const ext = await createSessionLogExtension(core);
    expect(ext.hooks[HOOKS.CONTEXT_MESSAGE]).toBeDefined();
    // Tool results are logged via CONTEXT_MESSAGE (for tool role messages)
  });
});

// ── Full Extension Chain ─────────────────────────────────────────────────────

describe("Full Extension Chain", () => {
  it("should load all extensions and have them all registered", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load("compaction", wrapFactory(createCompactionExtension));
    await loader.load("core-tools", wrapFactory(createCoreToolsExtension));
    await loader.load("skills", wrapFactory(createSkillsExtension));
    await loader.load("session-log", wrapFactory(createSessionLogExtension));

    expect(loader.size()).toBe(4);

    // Check that all expected hooks are registered
    const hookNames = core.hooks.hookNames();
    expect(hookNames).toContain(HOOKS.COMMANDS_REGISTER);
    expect(hookNames).not.toContain(HOOKS.TOOLS_REGISTER); // called directly in load()
    expect(hookNames).toContain(HOOKS.SYSTEM_PROMPT_BUILD); // skills
    expect(hookNames).toContain(HOOKS.COMMANDS_REGISTER); // commands
  });
});
