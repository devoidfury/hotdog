// Integration tests for hooks + extension loader working together.

import { HookSystem, createHooks, HOOKS } from '../src/core/hooks.js';
import { ExtensionLoader, createExtensionLoader } from '../src/core/extensions.js';
import { ToolRegistry, createToolRegistry } from '../src/core/tool-registry.js';
import { describe, it, expect } from 'bun:test';

describe('Hook + Extension Integration', () => {
  it('should wire up an extension to the hook system', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const core = { hooks, toolRegistry };
    const loader = new ExtensionLoader(core);

    const events = [];

    // Simulate a compaction-like extension
    const compactionExt = {
      create: (c) => ({
        name: 'compaction',
        hooks: {
          [HOOKS.CONTEXT_FULL]: async ({ contextSize }) => {
            events.push({ hook: 'context:full', contextSize });
          },
        },
      }),
    };

    await loader.load('compaction', compactionExt);
    expect(loader.has('compaction')).toBe(true);

    // Emit the hook — the extension should receive it
    await hooks.emitAsync(HOOKS.CONTEXT_FULL, { contextSize: 100 });
    expect(events).toEqual([{ hook: 'context:full', contextSize: 100 }]);
  });

  it('should support multiple extensions on the same hook', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const core = { hooks, toolRegistry };
    const loader = new ExtensionLoader(core);

    const results = [];

    // Extension 1: logging
    const logExt = {
      create: () => ({
        name: 'logger',
        hooks: {
          [HOOKS.TOOL_BEFORE_EXECUTE]: ({ toolName }) => {
            results.push(`log:${toolName}`);
          },
        },
      }),
    };

    // Extension 2: metrics
    const metricsExt = {
      create: () => ({
        name: 'metrics',
        hooks: {
          [HOOKS.TOOL_BEFORE_EXECUTE]: ({ toolName }) => {
            results.push(`metrics:${toolName}`);
          },
        },
      }),
    };

    await loader.load('logger', logExt);
    await loader.load('metrics', metricsExt);

    await hooks.emitAsync(HOOKS.TOOL_BEFORE_EXECUTE, { toolName: 'bash' });
    expect(results).toEqual(['log:bash', 'metrics:bash']);
  });

  it('should register tools from an extension', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const core = { hooks, toolRegistry };
    const loader = new ExtensionLoader(core);

    const myTool = {
      toToolDef: () => ({ type: 'function', function: { name: 'my-tool' } }),
      execute: async () => 'hello',
    };

    const toolsExt = {
      create: () => ({
        name: 'my-tools',
        registerTools: (registry) => {
          registry.register('my-tool', myTool);
        },
      }),
    };

    await loader.load('my-tools', toolsExt);
    expect(toolRegistry.has('my-tool')).toBe(true);
    expect(toolRegistry.getToolDefs()).toEqual([
      { type: 'function', function: { name: 'my-tool' } },
    ]);
  });

  it('should handle extension lifecycle: load -> use -> unload', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const core = { hooks, toolRegistry };
    const loader = new ExtensionLoader(core);

    let cleanupCalled = false;
    const ext = {
      create: () => ({
        name: 'lifecycle',
        hooks: {
          [HOOKS.OUTPUT_EVENT]: () => {},
        },
        shutdown: async () => {
          cleanupCalled = true;
        },
      }),
    };

    // Load
    await loader.load('lifecycle', ext);
    expect(loader.has('lifecycle')).toBe(true);
    expect(hooks.handlerCount(HOOKS.OUTPUT_EVENT)).toBe(1);

    // Use
    await hooks.emitAsync(HOOKS.OUTPUT_EVENT, { type: 'test' });

    // Unload
    await loader.unload('lifecycle');
    expect(cleanupCalled).toBe(true);
    expect(loader.has('lifecycle')).toBe(false);
    expect(hooks.handlerCount(HOOKS.OUTPUT_EVENT)).toBe(0);
  });

  it('should support disabled extensions (create returns null)', async () => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const core = { hooks, toolRegistry };
    const loader = new ExtensionLoader(core);

    const disabledExt = {
      create: () => null, // Disabled via config
    };

    const result = await loader.load('disabled', disabledExt);
    expect(result).toBeNull();
    expect(loader.has('disabled')).toBe(false);
    expect(loader.size()).toBe(0);
  });
});
