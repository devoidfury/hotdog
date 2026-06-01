// Extension loader — discovers, loads, and manages extensions.
// Extensions plug into the core via hooks and tool registration.

import { HookSystem, HOOKS } from '../hooks.js';

export { HookSystem, HOOKS };

/**
 * Extension loader — manages the lifecycle of extensions.
 */
export class ExtensionLoader {
  /**
   * @param {Object} core - The core object with hooks and toolRegistry.
   */
  constructor(core) {
    this._core = core;
    this._extensions = new Map();
    // Track removal functions per extension so we can cleanly deregister
    // only this extension's handlers on unload.
    this._handlerRemovers = new Map();
  }

  /**
   * Load an extension by name and entry point.
   *
   * Entry points can be:
   * - A string path (dynamic import)
   * - A module object with a `create(core)` function
   * - A module object that is itself an extension
   *
   * @param {string} name - Unique extension name.
   * @param {string|Object} entryPoint - Path or module object.
   * @returns {Promise<Object>} The loaded extension instance.
   */
  async load(name, entryPoint) {
    // Resolve the module
    let extModule;
    if (typeof entryPoint === 'string') {
      extModule = await import(entryPoint);
    } else {
      extModule = entryPoint;
    }

    // Create the extension instance
    const instance = extModule.create
      ? extModule.create(this._core)
      : extModule;

    if (!instance) {
      return null;
    }

    this._extensions.set(name, instance);

    // Track removal functions for this extension's hooks
    const removers = [];
    this._handlerRemovers.set(name, removers);

    // Auto-register hooks if the extension has them
    if (instance.hooks) {
      for (const [hookName, handler] of Object.entries(instance.hooks)) {
        const remove = this._core.hooks.on(hookName, handler);
        removers.push(remove);
      }
    }

    // Auto-register tools via the tools:register hook
    if (instance.registerTools) {
      await instance.registerTools(this._core.toolRegistry);
    }

    return instance;
  }

  /**
   * Hot-reload an extension: unload and reload.
   * @param {string} name
   * @param {string|Object} entryPoint
   * @returns {Promise<Object>}
   */
  async reload(name, entryPoint) {
    await this.unload(name);
    return await this.load(name, entryPoint);
  }

  /**
   * Unload an extension: call shutdown hook, remove from registry.
   * Only removes this extension's own handlers — other extensions'
   * handlers on the same hooks remain intact.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async unload(name) {
    const ext = this._extensions.get(name);
    if (ext) {
      // Call shutdown if available
      if (ext.shutdown) {
        try {
          await ext.shutdown();
        } catch (e) {
          console.error(`[extension:${name}] shutdown error: ${e.message}`);
        }
      }

      // Remove only this extension's handlers
      const removers = this._handlerRemovers.get(name);
      if (removers) {
        for (const remove of removers) {
          remove();
        }
        this._handlerRemovers.delete(name);
      }

      this._extensions.delete(name);
    }
  }

  /**
   * Get a loaded extension by name.
   * @param {string} name
   * @returns {Object|undefined}
   */
  get(name) {
    return this._extensions.get(name);
  }

  /**
   * Get all loaded extensions as [name, instance] pairs.
   * @returns {Array<[string, Object]>}
   */
  all() {
    return Array.from(this._extensions.entries());
  }

  /**
   * Check if an extension is loaded.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._extensions.has(name);
  }

  /**
   * Get the count of loaded extensions.
   * @returns {number}
   */
  size() {
    return this._extensions.size;
  }

  /**
   * Emit shutdown:cleanup hook — all extensions get a chance to clean up.
   * This is called before the process exits to ensure graceful shutdown.
   * @returns {Promise<void>}
   */
  async cleanup() {
    await this._core.hooks.emitAsync(HOOKS.SHUTDOWN_CLEANUP, null);
  }
}

/**
 * Create a new ExtensionLoader instance.
 * @param {Object} core - The core object.
 * @returns {ExtensionLoader}
 */
export function createExtensionLoader(core) {
  return new ExtensionLoader(core);
}
