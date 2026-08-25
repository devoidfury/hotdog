import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { ExtensionLoader, type LoaderCore } from "../../src/core/extensions/extensions.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";
import { ServiceRegistry } from "../../src/core/extensions/service-registry.ts";
import type { ConfigRegistry } from "../../src/core/extensions/config.ts";
import type { CliSubcommandRegistry } from "../../src/core/extensions/registries.ts";
import { createCompletionService } from "../../src/core/completion.ts";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.ts";
import { create as createCoreToolsExtension } from "../../src/extensions/core-tools/index.ts";
import { create as createSkillsExtension } from "../../src/extensions/skills/index.ts";
import { create as createSessionLogExtension } from "../../src/extensions/session-log/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCore(): CoreContext {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const serviceRegistry = new ServiceRegistry();
  return {
    hooks,
    config: {
      compaction: { enabled: true, keepRecentMessages: 3, strategy: "summarize" },
      skills: { path: "/tmp/skills-test" },
      promptsPath: "/tmp/prompts-test",
    } as Record<string, unknown>,
    modelRegistry: {},
    toolRegistry,
    services: serviceRegistry,
    completion: createCompletionService(),
    configRegistry: {
      validateConfigByKey: (_key: string, _config: unknown) => ({ valid: true, errors: [] }),
    } as unknown as ConfigRegistry,
    cliSubcommandRegistry: {} as unknown as CliSubcommandRegistry,
    extensions: {} as unknown as ExtensionLoader,
    service: (name: string) => serviceRegistry.get(name),
  } as unknown as CoreContext;
}

// Helper to wrap factory functions for ExtensionLoader
function wrapFactory(factory: (core: CoreContext) => unknown) {
  return { create: factory };
}

// ExtensionLoader mechanics (load/unload/hook registration) are covered
// generically in tests/core/core-extensions.test.ts. These tests exercise the
// loader with REAL extensions, which is the integration seam the generic
// tests cannot reach.

// ── Loader + real extensions ────────────────────────────────────────────────

describe("Loader with real extensions", () => {
  it("registers core tools from the core-tools extension during load", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core as unknown as LoaderCore);

    await loader.load("core-tools", wrapFactory(createCoreToolsExtension));

    // The loader invokes the extension's TOOLS_REGISTER handler directly
    // during load() (it is never registered on the HookSystem).
    const toolNames = core.toolRegistry.getAll().map(([name]) => name);
    expect(toolNames).toContain("overwrite");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find");
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
});

// ── Full Extension Chain ─────────────────────────────────────────────────────

describe("Full Extension Chain", () => {
  it("loads multiple real extensions together without conflicts", async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core as unknown as LoaderCore);

    await loader.load("compaction", wrapFactory(createCompactionExtension));
    await loader.load("core-tools", wrapFactory(createCoreToolsExtension));
    await loader.load("skills", wrapFactory(createSkillsExtension));
    await loader.load("session-log", wrapFactory(createSessionLogExtension));

    expect(loader.size()).toBe(4);

    // HookSystem wiring: skills registers SYSTEM_PROMPT_BUILD, TOOLS_REGISTER
    // is invoked directly by the loader during load() and never lands here.
    const hookNames = core.hooks.hookNames();
    expect(hookNames).toContain(HOOKS.SYSTEM_PROMPT_BUILD);
    expect(hookNames).not.toContain(HOOKS.TOOLS_REGISTER);

    // Tools from both tool-registering extensions landed in the registry.
    expect(core.toolRegistry.has("load_skill")).toBe(true);
    expect(core.toolRegistry.has("overwrite")).toBe(true);
  });
});
