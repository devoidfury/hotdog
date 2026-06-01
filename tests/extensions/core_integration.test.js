import { describe, it, expect, beforeEach } from 'bun:test';
import { HookSystem, HOOKS } from '../../src/hooks.js';
import { ExtensionLoader } from '../../src/core/extensions.js';
import { ToolRegistry } from '../../src/core/tool-registry.js';
import { create as createCompactionExtension } from '../../extensions/compaction/index.js';
import { create as createCoreToolsExtension } from '../../extensions/core-tools/index.js';
import { create as createSkillsExtension } from '../../extensions/skills/index.js';
import { create as createPromptsExtension } from '../../extensions/prompts/index.js';
import { create as createSessionLogExtension } from '../../extensions/session-log/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCore(config = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  return {
    hooks,
    config: {
      compaction: config.compaction || { enabled: true, keepRecentMessages: 3, strategy: 'summarize' },
      skillsPath: config.skillsPath || '/tmp/skills-test',
      promptsPath: config.promptsPath || '/tmp/prompts-test',
      ...config,
    },
    modelRegistry: {},
    toolRegistry,
  };
}

// Helper to wrap factory functions for ExtensionLoader
function wrapFactory(factory) {
  return { create: factory };
}

// ── Hook + Extension Integration ─────────────────────────────────────────────

describe('Hook + Extension Integration', () => {
  it('should wire up an extension to the hook system', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    const ext = await loader.load('compaction', wrapFactory(createCompactionExtension));
    expect(ext).not.toBeNull();
    expect(core.hooks.hookNames()).toContain(HOOKS.CONTEXT_FULL);
  });

  it('should support multiple extensions on the same hook', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load('compaction', wrapFactory(createCompactionExtension));
    await loader.load('session-log', wrapFactory(createSessionLogExtension));

    // Both should have registered their hooks
    const hookNames = core.hooks.hookNames();
    expect(hookNames).toContain(HOOKS.CONTEXT_FULL);
    expect(hookNames).toContain(HOOKS.CONTEXT_MESSAGE);
  });

  it('should register tools from an extension', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load('core-tools', wrapFactory(createCoreToolsExtension));

    // Trigger the tools:register hook
    await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);

    // Core tools should be registered
    const toolNames = core.toolRegistry.getAll().map(([name]) => name);
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('write');
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('edit');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('find');
    expect(toolNames).toContain('fetch');
    expect(toolNames).toContain('question');
    expect(toolNames).toContain('pager');
    // explore is disabled by default
    expect(toolNames).not.toContain('explore');
    expect(toolNames).toContain('model');
    // load_skill is registered by skills extension, not core-tools
    expect(toolNames).not.toContain('load_skill');
    expect(toolNames).toContain('review');
    // project_info should NOT be registered (disabled)
    expect(toolNames).not.toContain('project_info');
  });

  it('should handle extension lifecycle: load -> use -> unload', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    // Load
    const ext = await loader.load('compaction', wrapFactory(createCompactionExtension));
    expect(ext).not.toBeNull();
    expect(loader.has('compaction')).toBe(true);
    expect(loader.size()).toBe(1);

    // Use (hooks are registered)
    expect(core.hooks.hookNames()).toContain(HOOKS.CONTEXT_FULL);

    // Unload
    await loader.unload('compaction');
    expect(loader.has('compaction')).toBe(false);
    expect(loader.size()).toBe(0);
  });

  it('should support disabled extensions (create returns null)', async () => {
    const core = createMockCore({ compaction: { enabled: false } });
    const loader = new ExtensionLoader(core);

    const ext = await loader.load('compaction', wrapFactory(createCompactionExtension));
    expect(ext).toBeNull();
    expect(loader.has('compaction')).toBe(false);
  });
});

// ── Skills Extension ─────────────────────────────────────────────────────────

describe('Skills Extension', () => {
  it('should create extension and expose loader', () => {
    const core = createMockCore();
    const ext = createSkillsExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.loader).toBeDefined();
  });

  it('should register load_skill tool', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load('skills', wrapFactory(createSkillsExtension));

    // Trigger the tools:register hook
    await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);

    expect(core.toolRegistry.has('load_skill')).toBe(true);
  });
});

// ── Prompts Extension ────────────────────────────────────────────────────────

describe('Prompts Extension', () => {
  it('should create extension and expose loader', () => {
    const core = createMockCore();
    const ext = createPromptsExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.loader).toBeDefined();
  });
});

// ── Session Log Extension ────────────────────────────────────────────────────

describe('Session Log Extension', () => {
  it('should create extension with session ID and log path', () => {
    const core = createMockCore();
    const ext = createSessionLogExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.sessionId).toBeDefined();
    expect(ext.logPath).toBeDefined();
  });

  it('should register hooks for message logging', () => {
    const core = createMockCore();
    const ext = createSessionLogExtension(core);
    expect(ext.hooks[HOOKS.CONTEXT_MESSAGE]).toBeDefined();
    // Tool results are now logged via CONTEXT_MESSAGE (for tool role messages),
    // not via TOOL_AFTER_EXECUTE hook
  });
});

// ── Full Extension Chain ─────────────────────────────────────────────────────

describe('Full Extension Chain', () => {
  it('should load all extensions and have them all registered', async () => {
    const core = createMockCore();
    const loader = new ExtensionLoader(core);

    await loader.load('compaction', wrapFactory(createCompactionExtension));
    await loader.load('core-tools', wrapFactory(createCoreToolsExtension));
    await loader.load('skills', wrapFactory(createSkillsExtension));
    await loader.load('session-log', wrapFactory(createSessionLogExtension));

    expect(loader.size()).toBe(4);

    // Check that all expected hooks are registered
    // Note: TOOLS_REGISTER is NOT registered via hooks.on() — it's called
    // directly in ExtensionLoader.load() to avoid double emission.
    const hookNames = core.hooks.hookNames();
    expect(hookNames).toContain(HOOKS.CONTEXT_FULL);        // compaction
    expect(hookNames).toContain(HOOKS.CONTEXT_MESSAGE);     // session-log
    expect(hookNames).toContain(HOOKS.OUTPUT_EVENT);        // session-log (compaction)
    expect(hookNames).not.toContain(HOOKS.TOOLS_REGISTER);  // called directly in load()
    expect(hookNames).toContain(HOOKS.SYSTEM_PROMPT_BUILD);  // skills
    expect(hookNames).toContain(HOOKS.SLASH_COMMANDS_REGISTER); // skills
  });
});
