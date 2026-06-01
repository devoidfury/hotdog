// Tests for the core extension loader.

import { ExtensionLoader, createExtensionLoader, HOOKS } from '../../src/core/extensions.js';
import { HookSystem, createHooks } from '../../src/hooks.js';
import { ToolRegistry, createToolRegistry } from '../../src/core/tool-registry.js';
import { describe, it, expect, beforeEach } from 'bun:test';

describe('ExtensionLoader', () => {
  let core;
  let loader;

  beforeEach(() => {
    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    core = { hooks, toolRegistry };
    loader = new ExtensionLoader(core);
  });

  describe('load()', () => {
    it('should load an extension with a create function', async () => {
      const extModule = {
        create: (c) => ({
          name: 'test-ext',
          hooks: {
            'test:hook': (data) => {},
          },
        }),
      };

      const ext = await loader.load('test', extModule);
      expect(ext.name).toBe('test-ext');
      expect(loader.has('test')).toBe(true);
      expect(loader.size()).toBe(1);
    });

    it('should register hooks from the extension', async () => {
      const hookCalled = [];
      const extModule = {
        create: (c) => ({
          hooks: {
            'test:hook': (data) => hookCalled.push(data),
          },
        }),
      };

      await loader.load('test', extModule);
      core.hooks.emit('test:hook', { value: 1 });
      expect(hookCalled).toEqual([{ value: 1 }]);
    });

    it('should register tools via registerTools callback', async () => {
      let registryRef = null;
      const extModule = {
        create: (c) => ({
          registerTools: (registry) => {
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
      expect(ext.name).toBe('minimal');
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

    it('should handle shutdown errors gracefully', async () => {
      const extModule = {
        create: () => ({
          shutdown: async () => { throw new Error('shutdown fail'); },
        }),
      };

      await loader.load('test', extModule);
      // Should not throw
      await loader.unload('test');
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
      const extACalls = [];
      const extBCalls = [];

      // Load extension A with a handler on 'shared:hook'
      const extAModule = {
        create: () => ({
          name: 'extA',
          hooks: {
            'shared:hook': (data) => extACalls.push(data),
          },
        }),
      };

      // Load extension B with a handler on the same 'shared:hook'
      const extBModule = {
        create: () => ({
          name: 'extB',
          hooks: {
            'shared:hook': (data) => extBCalls.push(data),
          },
        }),
      };

      await loader.load('extA', extAModule);
      await loader.load('extB', extBModule);

      // Both handlers should fire
      core.hooks.emit('shared:hook', { from: 'emit' });
      expect(extACalls).toEqual([{ from: 'emit' }]);
      expect(extBCalls).toEqual([{ from: 'emit' }]);

      // Unload extension A
      await loader.unload('extA');
      expect(loader.has('extA')).toBe(false);
      expect(loader.has('extB')).toBe(true);

      // Only extension B's handler should fire now
      extACalls.length = 0;
      extBCalls.length = 0;
      core.hooks.emit('shared:hook', { from: 'emit2' });
      expect(extACalls).toEqual([]); // A's handler removed
      expect(extBCalls).toEqual([{ from: 'emit2' }]); // B's handler still works
    });

    it('should allow reloading an extension without leaking handlers', async () => {
      let callCount = 0;
      const makeModule = (count) => ({
        create: () => ({
          name: 'test',
          hooks: {
            'reload:hook': () => { callCount += count; },
          },
        }),
      });

      await loader.load('test', makeModule(1));
      core.hooks.emit('reload:hook');
      expect(callCount).toBe(1);

      // Reload
      await loader.reload('test', makeModule(2));
      core.hooks.emit('reload:hook');
      expect(callCount).toBe(3); // 1 + 2 (no double registration)

      // Unload
      await loader.unload('test');
      core.hooks.emit('reload:hook');
      expect(callCount).toBe(3); // no change
    });
  });

  describe('reload()', () => {
    it('should unload and reload an extension', async () => {
      let counter = 0;
      const makeModule = () => ({
        create: () => ({
          name: 'test',
          counter: ++counter,
          shutdown: async () => {},
        }),
      });

      await loader.load('test', makeModule());
      const first = loader.get('test');
      expect(first.counter).toBe(1);

      await loader.reload('test', makeModule());
      const second = loader.get('test');
      expect(second.counter).toBe(2);
      expect(loader.size()).toBe(1);
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
