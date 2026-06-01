/**
 * Refresh tool — hot-reload extensions and modules at runtime.
 *
 * This tool allows the agent to reload its own code without restarting,
 * enabling real-time debugging and self-modification.
 *
 * Features:
 * - Selective reload of specific extensions by name
 * - Full reload of all extensions
 * - Module cache inspection
 * - Preserves agent state (context, messages, model, etc.)
 * - Auto-re-registers tools after reload
 */

import { toolDef, param, ToolResult, toolResult, parseToolInput } from '../core-tools/registry.js';
import { importModule, getLoadedModules, clearModuleCache } from './module-loader.js';

export class RefreshTool {
  static TOOL_NAME = 'refresh';

  /**
   * @param {Object} options
   * @param {Object} options.core - The core object (hooks, extensions, etc.)
   * @param {Object} options.extensionLoader - The ExtensionLoader instance
   * @param {Function} options.reRegisterTools - Callback to re-register all tools
   */
  constructor({ core, extensionLoader, reRegisterTools }) {
    this.core = core;
    this.extensionLoader = extensionLoader;
    this.reRegisterTools = reRegisterTools;
    this._extensionPaths = new Map(); // name → path for tracking
  }

  /**
   * Register extension paths for tracking.
   * Call this during initialization so we know which paths to reload.
   * @param {string} name - Extension name
   * @param {string} path - Module path
   */
  registerExtensionPath(name, path) {
    this._extensionPaths.set(name, path);
  }

  toToolDef() {
    const extensions = Array.from(this._extensionPaths.keys()).sort();
    const desc = extensions.length > 0
      ? `Hot-reload extensions and modules without restarting. Use "list" to see loaded modules, "all" to reload everything, or provide specific extension names to reload only those. Preserves agent state (context, messages, model, etc.).`
      : 'Hot-reload extensions and modules without restarting. Use "list" to see loaded modules, "all" to reload everything, or provide specific extension names to reload only those.';

    return toolDef(RefreshTool.TOOL_NAME, desc, {
      schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        action: param('string', 'The action to perform', {
          enum: ['reload', 'list', 'cache-clear'],
        }),
        target: param('string', 'Extension name to reload, or "all" for everything, or "list" to see loaded modules, or "cache-clear" to clear the module cache.'),
        force: param('boolean', 'Force reload even if module is cached (default: false)'),
      },
      required: ['action', 'target'],
    });
  }

  callDisplay(input) {
    const args = parseArgs(input);
    if (!args) {
      return typeof input === 'string' ? input : '';
    }
    return `-> refresh: ${args.action} ${args.target || ''}${args.force ? ' (force)' : ''}`;
  }

  /**
   * Execute the refresh tool.
   * @param {string|Object} input - Tool input
   * @param {Object} ctx - Tool context
   * @returns {Promise<ToolResult>}
   */
  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return ToolResult.err('Invalid JSON input');
    }

    const { action, target, force = false } = args;

    switch (action) {
      case 'list':
        return this._handleList();
      case 'cache-clear':
        return this._handleCacheClear();
      case 'reload':
        return this._handleReload(target, force);
      default:
        return ToolResult.err(
          `Unknown action: ${action}. Use "reload", "list", or "cache-clear".`
        );
    }
  }

  /**
   * Handle the "list" action — show loaded modules.
   */
  async _handleList() {
    const modules = getLoadedModules();
    const extensions = Array.from(this._extensionPaths.entries());

    const lines = [];

    // Extension paths
    if (extensions.length > 0) {
      lines.push('## Registered Extensions');
      for (const [name, path] of extensions) {
        lines.push(`  ${name}: ${path}`);
      }
      lines.push('');
    }

    // Loaded modules
    if (modules.length > 0) {
      lines.push('## Loaded Modules');
      for (const { path, timestamp } of modules) {
        const age = Math.round((Date.now() - timestamp) / 1000);
        lines.push(`  ${path} (loaded ${age}s ago)`);
      }
    } else {
      lines.push('## Loaded Modules');
      lines.push('  (none)');
    }

    return ToolResult.ok(lines.join('\n')).withEntries({
      module_count: String(modules.length),
      extension_count: String(extensions.length),
    });
  }

  /**
   * Handle the "cache-clear" action — clear the module cache.
   */
  async _handleCacheClear() {
    const count = getLoadedModules().length;
    clearModuleCache();
    return ToolResult.ok(`Module cache cleared (${count} entries removed).`).withEntry(
      'entries_cleared', String(count)
    );
  }

  /**
   * Handle the "reload" action — reload specific or all extensions.
   * @param {string} target - Extension name or "all"
   * @param {boolean} force - Force reload
   */
  async _handleReload(target, force) {
    if (!target || target.trim() === '') {
      return ToolResult.err('Target is required. Provide an extension name or "all".');
    }

    const targets = target.trim().toLowerCase() === 'all'
      ? Array.from(this._extensionPaths.keys())
      : [target.trim().toLowerCase()];

    const results = [];
    const errors = [];

    for (const name of targets) {
      const path = this._extensionPaths.get(name);

      if (!path) {
        errors.push(`Extension "${name}" not registered for reload`);
        continue;
      }

      try {
        await this._reloadExtension(name, path, force);
        results.push(`✓ Reloaded: ${name}`);
      } catch (e) {
        errors.push(`✗ Failed to reload "${name}": ${e.message}`);
      }
    }

    // Re-register tools after reload
    if (results.length > 0) {
      try {
        await this.reRegisterTools();
        results.push('✓ Tools re-registered');
      } catch (e) {
        errors.push(`✗ Failed to re-register tools: ${e.message}`);
      }
    }

    const output = results.join('\n');
    const errorOutput = errors.length > 0 ? `\nErrors:\n${errors.join('\n')}` : '';

    return ToolResult.ok(output + errorOutput).withEntries({
      reloaded: String(results.length),
      errors: String(errors.length),
    });
  }

  /**
   * Reload a single extension by name and path.
   * @param {string} name - Extension name
   * @param {string} path - Module path
   * @param {boolean} force - Force reload
   */
  async _reloadExtension(name, path, force) {
    // 1. Unload the extension (cleanup hooks, etc.)
    await this.extensionLoader.unload(name);

    // 2. Force reload the module (bust cache)
    const mod = await importModule(path, true);

    // 3. Recreate the extension instance
    if (mod.create) {
      const instance = mod.create(this.core);
      if (instance) {
        // Re-load into the extension loader (which re-registers hooks)
        await this.extensionLoader.load(name, mod);

        // Also update the path tracking in case the path changed
        this._extensionPaths.set(name, path);
      }
    }
  }
}

/**
 * Parse refresh tool arguments.
 */
function parseArgs(input) {
  const json = parseToolInput(input);
  if (!json) return null;

  const action = json.action;
  const target = json.target;
  const force = json.force;

  if (!action || typeof action !== 'string') {
    return null;
  }

  if (!target || typeof target !== 'string') {
    return null;
  }

  return { action, target, force: force === true };
}
