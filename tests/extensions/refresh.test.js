/**
 * Tests for the refresh extension.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { RefreshTool } from '../../extensions/refresh/refresh-tool.js';
import {
  importModule,
  getLoadedModules,
  clearModuleCache,
} from '../../extensions/refresh/module-loader.js';

describe('RefreshTool', () => {
  let tool;
  let mockCore;
  let mockExtensionLoader;
  let unloadCalls = [];
  let loadCalls = [];
  let reRegisterCalls = 0;

  beforeEach(() => {
    unloadCalls = [];
    loadCalls = [];
    reRegisterCalls = 0;

    mockExtensionLoader = {
      unload: (name) => { unloadCalls.push(name); },
      load: (name, mod) => { loadCalls.push({ name, mod }); },
    };
    mockCore = {};

    tool = new RefreshTool({
      core: mockCore,
      extensionLoader: mockExtensionLoader,
      reRegisterTools: () => { reRegisterCalls++; },
    });
  });

  describe('constructor', () => {
    it('should register extension paths', () => {
      tool.registerExtensionPath('test-ext', './path/to/test.js');
      expect(tool._extensionPaths.get('test-ext')).toBe('./path/to/test.js');
    });
  });

  describe('toToolDef', () => {
    it('should return a valid tool definition', () => {
      const def = tool.toToolDef();
      expect(def).toBeDefined();
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('refresh');
      expect(def.function.parameters).toBeDefined();
    });

    it('should include refresh action enum', () => {
      const def = tool.toToolDef();
      const actionProp = def.function.parameters.properties.action;
      expect(actionProp.enum).toContain('reload');
      expect(actionProp.enum).toContain('list');
      expect(actionProp.enum).toContain('cache-clear');
    });
  });

  describe('callDisplay', () => {
    it('should generate display string for reload action', () => {
      const display = tool.callDisplay(JSON.stringify({ action: 'reload', target: 'core-tools' }));
      expect(display).toContain('refresh: reload core-tools');
    });

    it('should generate display string for list action', () => {
      const display = tool.callDisplay(JSON.stringify({ action: 'list', target: 'list' }));
      expect(display).toContain('refresh: list');
    });

    it('should handle invalid input', () => {
      const display = tool.callDisplay('not json');
      expect(display).toBe('not json');
    });
  });

  describe('execute - list', () => {
    it('should return module list', async () => {
      const result = await tool.execute(
        JSON.stringify({ action: 'list', target: 'list' }),
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('## Loaded Modules');
    });
  });

  describe('execute - cache-clear', () => {
    it('should clear module cache', async () => {
      // First, load a module to have something in cache
      await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');

      const result = await tool.execute(
        JSON.stringify({ action: 'cache-clear', target: 'cache-clear' }),
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Module cache cleared');
    });
  });

  describe('execute - reload', () => {
    it('should return error when target is empty', async () => {
      const result = await tool.execute(
        JSON.stringify({ action: 'reload', target: '   ' }),
        {}
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target is required');
    });

    it('should return error for unknown extension', async () => {
      const result = await tool.execute(
        JSON.stringify({ action: 'reload', target: 'nonexistent' }),
        {}
      );
      expect(result.success).toBe(true); // Returns ok with error info
      expect(result.output).toContain('not registered for reload');
    });
  });
});

describe('Module Loader', () => {
  beforeEach(() => {
    clearModuleCache();
  });

  describe('importModule', () => {
    it('should import a module', async () => {
      const mod = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      expect(mod).toBeDefined();
    });

    it('should cache modules', async () => {
      const mod1 = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      const mod2 = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      expect(mod1).toBe(mod2); // Same cached instance
    });

    it('should force reload when requested', async () => {
      // First import
      const mod1 = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      expect(mod1).toBeDefined();

      // Force reload - this should clear our cache and attempt a new import
      // Note: The underlying JS module system may still cache at a higher level,
      // but our loader's cache should be bypassed
      const mod2 = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js', true);
      expect(mod2).toBeDefined();

      // Verify the cache was cleared by checking that a subsequent non-force
      // import gets the new module
      const mod3 = await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      expect(mod3).toBe(mod2); // mod3 should be the same as mod2 (force-reloaded version)
    });
  });

  describe('getLoadedModules', () => {
    it('should return empty array initially', () => {
      const modules = getLoadedModules();
      expect(modules).toEqual([]);
    });

    it('should return loaded modules', async () => {
      await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      const modules = getLoadedModules();
      expect(modules.length).toBeGreaterThan(0);
      expect(modules[0]).toHaveProperty('path');
      expect(modules[0]).toHaveProperty('timestamp');
    });
  });

  describe('clearModuleCache', () => {
    it('should clear all cached modules', async () => {
      await importModule('/workspace/oa-js/tests/extensions/refresh.test.js');
      expect(getLoadedModules().length).toBeGreaterThan(0);

      clearModuleCache();
      expect(getLoadedModules().length).toBe(0);
    });
  });
});
