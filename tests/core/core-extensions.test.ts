// Tests for the core extension loader.

import { ExtensionLoader, HOOKS } from '../../src/core/extensions/extensions.ts';
import { createHooks } from '../../src/core/hooks.ts';
import { createToolRegistry } from '../../src/core/extensions/tool-registry.ts';
import { createServiceRegistry } from '../../src/core/extensions/service-registry.ts';
import { createConfigRegistry } from '../../src/core/extensions/config-registry.ts';
import { createSubcommandRegistry } from '../../src/core/extensions/registries.ts';
import type { LoaderCore } from '../../src/core/extensions/extensions.ts';
import { describe, it, expect, beforeEach } from 'bun:test';

describe('ExtensionLoader', () => {
  let core: LoaderCore;
  let loader: ExtensionLoader;

  beforeEach(() => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const services = createServiceRegistry();
    const configRegistry = createConfigRegistry();
    const cliSubcommandRegistry = createSubcommandRegistry();
    core = { hooks, toolRegistry, services, configRegistry, cliSubcommandRegistry };
    loader = new ExtensionLoader(core);
  });

  describe('load()', () => {
    it('should load an extension with a create function', async () => {
      const extModule = {
        create: (c: LoaderCore) => ({
          name: 'test-ext',
          hooks: {
            'test:hook': (data: unknown) => {},
          },
        }),
      };

      const ext = await loader.load('test', extModule);
      expect((ext as any).name).toBe('test-ext');
      expect(loader.has('test')).toBe(true);
      expect(loader.size()).toBe(1);
    });

    it('should register hooks from the extension', async () => {
      const hookCalled: unknown[] = [];
      const extModule = {
        create: (c: LoaderCore) => ({
          hooks: {
            'test:hook': (data: unknown) => hookCalled.push(data),
          },
        }),
      };

      await loader.load('test', extModule);
      core.hooks.notifyHooks('test:hook', { value: 1 });
      expect(hookCalled).toEqual([{ value: 1 }]);
    });

    it('should register tools via registerTools callback', async () => {
      let registryRef: any = null;
      const extModule = {
        create: (c: LoaderCore) => ({
          registerTools: (registry: any) => {
            registryRef = registry;
            registry.register('my-tool', { execute: () => 'result' });
          },
        }),
      };

      await loader.load('test', extModule);
      expect(registryRef).toBe(core.toolRegistry);
      expect(core.toolRegistry.has('my-tool')).toBe(true);
    });

    it('should handle extensions without create function', async () => {
      const extInstance = { name: 'flat-ext', hooks: {} };
      const extModule = extInstance;

      const ext = await loader.load('flat', extModule);
      expect(ext).toBe(extInstance);
    });

    it('should return null when create returns null', async () => {
      const extModule = {
        create: () => null,
      };

      const ext = await loader.load('disabled', extModule);
      expect(ext).toBeNull();
      expect(loader.has('disabled')).toBe(false);
    });

    it('should handle extensions without hooks or registerTools', async () => {
      const extModule = {
        create: () => ({ name: 'minimal' }),
      };

      const ext = await loader.load('minimal', extModule);
      expect((ext as any).name).toBe('minimal');
    });
  });

  describe('unload()', () => {
    it('should call shutdown on unload', async () => {
      let shutdownCalled = false;
      const extModule = {
        create: () => ({
          name: 'test',
          shutdown: async () => { shutdownCalled = true; },
        }),
      };

      await loader.load('test', extModule);
      await loader.unload('test');
      expect(shutdownCalled).toBe(true);
      expect(loader.has('test')).toBe(false);
    });

    it('should propagate shutdown errors', async () => {
      const extModule = {
        create: () => ({
          shutdown: async () => { throw new Error('shutdown fail'); },
        }),
      };

      await loader.load('test', extModule);
      // Should throw
      await expect(loader.unload('test')).rejects.toThrow(
        "Extension 'test' shutdown failed: shutdown fail",
      );
    });

    it('should handle extensions without shutdown', async () => {
      const extModule = {
        create: () => ({ name: 'no-shutdown' }),
      };

      await loader.load('test', extModule);
      await loader.unload('test');
      expect(loader.has('test')).toBe(false);
    });

    it('should only remove this extension\'s handlers, not others on the same hook', async () => {
      const extACalls: unknown[] = [];
      const extBCalls: unknown[] = [];

      // Load extension A with a handler on 'shared:hook'
      const extAModule = {
        create: () => ({
          name: 'extA',
          hooks: {
            'shared:hook': (data: unknown) => extACalls.push(data),
          },
        }),
      };

      // Load extension B with a handler on the same 'shared:hook'
      const extBModule = {
        create: () => ({
          name: 'extB',
          hooks: {
            'shared:hook': (data: unknown) => extBCalls.push(data),
          },
        }),
      };

      await loader.load('extA', extAModule);
      await loader.load('extB', extBModule);

      // Both handlers should fire
      core.hooks.notifyHooks('shared:hook', { from: 'emit' });
      expect(extACalls).toEqual([{ from: 'emit' }]);
      expect(extBCalls).toEqual([{ from: 'emit' }]);

      // Unload extension A
      await loader.unload('extA');
      expect(loader.has('extA')).toBe(false);
      expect(loader.has('extB')).toBe(true);

      // Only extension B's handler should fire now
      extACalls.length = 0;
      extBCalls.length = 0;
      core.hooks.notifyHooks('shared:hook', { from: 'emit2' });
      expect(extACalls).toEqual([]); // A's handler removed
      expect(extBCalls).toEqual([{ from: 'emit2' }]); // B's handler still works
    });

    it('removes tools from registry on unload', async () => {
      const extModule = {
        create: () => ({
          name: 'tool-ext',
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (registry: any) => {
              registry.register('my-tool', { execute: () => 'result' });
              registry.register('another-tool', { execute: () => 'result2' });
            },
          },
        }),
      };

      await loader.load('tool-ext', extModule);
      expect(core.toolRegistry.has('my-tool')).toBe(true);
      expect(core.toolRegistry.has('another-tool')).toBe(true);

      // Pre-existing tool should survive unload
      core.toolRegistry.register('shared-tool', { execute: async () => 'shared' });
      expect(core.toolRegistry.has('shared-tool')).toBe(true);

      await loader.unload('tool-ext');

      // Tools from unloaded extension should be removed
      expect(core.toolRegistry.has('my-tool')).toBe(false);
      expect(core.toolRegistry.has('another-tool')).toBe(false);
      // Pre-existing tool should still be there
      expect(core.toolRegistry.has('shared-tool')).toBe(true);
    });

    it('does not track tools for extensions that did not register any', async () => {
      const extModule = {
        create: () => ({
          name: 'no-tools',
          hooks: {},
        }),
      };

      await loader.load('no-tools', extModule);
      // Should not throw or cause issues
      await loader.unload('no-tools');
      expect(loader.has('no-tools')).toBe(false);
    });
  });

  describe('all()', () => {
    it('should return all loaded extensions', async () => {
      await loader.load('a', { create: () => ({ name: 'a' }) });
      await loader.load('b', { create: () => ({ name: 'b' }) });

      const all = loader.all();
      expect(all.length).toBe(2);
      expect(all.map(([name]) => name)).toEqual(['a', 'b']);
    });
  });

  describe('get()', () => {
    it('should return undefined for unloaded extensions', () => {
      expect(loader.get('nonexistent')).toBeUndefined();
    });

    it('should return the extension instance', async () => {
      const expected = { name: 'test' };
      await loader.load('test', { create: () => expected });
      expect(loader.get('test')).toBe(expected);
    });
  });
});
