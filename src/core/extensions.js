// Extension loader — discovers, loads, and manages extensions.
// Extensions plug into the core via hooks and tool registration.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HookSystem, HOOKS, EXTENSION_PROVIDES } from '../hooks.js';

export { HookSystem, HOOKS, EXTENSION_PROVIDES };

// ── Config Registration ────────────────────────────────────────────────────

/**
 * Emit config registration hooks for an extension.
 * This collects CLI flags and config parameters from the extension.
 *
 * @param {Object} extension - The extension instance.
 * @param {Object} configRegistry - The config registry to register with.
 * @returns {Promise<void>}
 */
export async function emitConfigRegistration(extension, configRegistry) {
  if (!extension || !configRegistry) return;

  // Emit CLI flags registration hook
  const cliFlagsResult = extension.hooks?.[HOOKS.CONFIG_CLI_FLAGS_REGISTER];
  if (cliFlagsResult) {
    try {
      const result = typeof cliFlagsResult === 'function'
        ? await cliFlagsResult(configRegistry)
        : await cliFlagsResult;
      // If the handler returns flags, register them
      if (result && Array.isArray(result)) {
        configRegistry.registerCliFlags(result);
      }
    } catch (e) {
      console.error(`[extension] Error in CONFIG_CLI_FLAGS_REGISTER: ${e.message}`);
    }
  }

  // Emit config params registration hook
  const configParamsResult = extension.hooks?.[HOOKS.CONFIG_PARAMS_REGISTER];
  if (configParamsResult) {
    try {
      const result = typeof configParamsResult === 'function'
        ? await configParamsResult(configRegistry)
        : await configParamsResult;
      // If the handler returns params, register them
      if (result && Array.isArray(result)) {
        configRegistry.registerConfigParams(result);
      }
    } catch (e) {
      console.error(`[extension] Error in CONFIG_PARAMS_REGISTER: ${e.message}`);
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../");

// ── Extension Discovery ──────────────────────────────────────────────────────

/**
 * Resolve an extension path spec to an absolute directory path.
 *
 * Special values:
 * - "builtins" → resolves to the repo's extensions/ directory
 * - Relative paths → resolved relative to CWD
 * - Absolute paths → used as-is
 *
 * @param {string} spec - Path specification.
 * @returns {string} Absolute directory path.
 */
export function resolveExtensionPath(spec) {
  if (spec === "builtins") {
    return path.join(ROOT_DIR, "extensions");
  }
  if (path.isAbsolute(spec)) {
    return spec;
  }
  return path.resolve(process.cwd(), spec);
}

/**
 * Check if a directory looks like an extension (has index.js with a create function).
 *
 * @param {string} dirPath - Directory path to check.
 * @returns {boolean} True if the directory appears to be an extension.
 */
export function isExtensionDirectory(dirPath) {
  const indexPath = path.join(dirPath, "index.js");
  if (!fs.existsSync(indexPath)) {
    return false;
  }
  // Quick check: file should contain "export function create" or "export {"
  try {
    const content = fs.readFileSync(indexPath, "utf-8");
    return /export\s+(function\s+create|{)/.test(content);
  } catch {
    return false;
  }
}

/**
 * Read extension metadata from extension.json file.
 *
 * @param {string} dirPath - Extension directory path.
 * @returns {{provides: string[], loadOrder: number}} Extension capabilities.
 */
function readExtensionMetadata(dirPath) {
  const metaPath = path.join(dirPath, "extension.json");
  if (!fs.existsSync(metaPath)) {
    return { provides: [], loadOrder: LOAD_ORDER.DEFAULT };
  }
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(content);
    const provides = Array.isArray(meta.provides) ? meta.provides : [];

    // Determine load order based on capabilities
    let loadOrder = LOAD_ORDER.DEFAULT;
    if (provides.includes(EXTENSION_PROVIDES.CLI_SUBCOMMANDS)) {
      loadOrder = LOAD_ORDER.CLI;
    }

    return { provides, loadOrder };
  } catch {
    return { provides: [], loadOrder: LOAD_ORDER.DEFAULT };
  }
}

/**
 * Discover extensions in a directory.
 * Walks subdirectories and returns those that look like extensions.
 * Reads extension.json metadata for capabilities.
 *
 * @param {string} dirPath - Directory to search.
 * @returns {Array<{name: string, path: string, provides: string[], loadOrder: number}>} Array of discovered extensions.
 */
export function discoverExtensionsInDir(dirPath) {
  const extensions = [];

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return extensions;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirFull = path.join(dirPath, entry.name);
    if (isExtensionDirectory(dirFull)) {
      // Read extension metadata
      const { provides, loadOrder } = readExtensionMetadata(dirFull);

      extensions.push({
        name: entry.name,
        path: `../extensions/${entry.name}/index.js`,
        provides,
        loadOrder,
      });
    }
  }

  return extensions;
}

/**
 * Load order constants for extensions.
 * Extensions with lower loadOrder values are loaded first.
 */
export const LOAD_ORDER = {
  REFRESH: 0,        // Must be loaded first (tracks other extensions)
  CORE_TOOLS: 1,     // Core tools needed by other extensions
  CLI: 2,            // CLI extensions loaded early (before config)
  DEFAULT: 10,       // Default load order for other extensions
};

/**
 * Discover all extensions from configured extension paths.
 * Reads extension capabilities (provides array) to determine load order.
 * CLI extensions (provides: ['cli:subcommands']) get higher priority.
 *
 * @param {Array<string>} extensionPaths - Array of path specs (e.g., ["builtins", "/custom/extensions"]).
 * @returns {Promise<Array<{name: string, path: string, loadOrder: number, provides: string[]}>>} Array of discovered extensions.
 */
export async function discoverExtensions(extensionPaths) {
  const allExtensions = [];

  for (const spec of extensionPaths) {
    const resolved = resolveExtensionPath(spec);
    const discovered = discoverExtensionsInDir(resolved);

    // Adjust relative paths based on resolution
    for (const ext of discovered) {
      let basePath;
      if (spec === "builtins") {
        basePath = `../../extensions/${ext.name}/index.js`;
      } else {
        const relPath = path.relative(ROOT_DIR, path.join(resolved, ext.name, "index.js"));
        basePath = relPath.startsWith("..") ? relPath : `./${relPath}`;
      }

      // Use metadata already read by discoverExtensionsInDir
      allExtensions.push({
        name: ext.name,
        path: basePath,
        loadOrder: ext.loadOrder,
        provides: ext.provides,
      });
    }
  }

  // Sort by load order (lower values first), then alphabetically for same order
  allExtensions.sort((a, b) => {
    if (a.loadOrder !== b.loadOrder) return a.loadOrder - b.loadOrder;
    return a.name.localeCompare(b.name);
  });

  return allExtensions;
}

/**
 * Get the list of extensions to load based on config settings.
 *
 * If extensionAutoload is true, returns all discovered extensions.
 * If extensionAutoload is false, returns only extensions whose names
 * match entries in the extensions config array.
 *
 * @param {Array<string>} extensionPaths - Configured extension paths.
 * @param {boolean} extensionAutoload - Whether to auto-discover all extensions.
 * @param {Array<string>} extensions - Explicit list of extension names to load.
 * @returns {Promise<Array<{name: string, path: string, loadOrder: number, provides: string[]}>>} Extensions to load.
 */
export async function getExtensionsToLoad(extensionPaths, extensionAutoload, extensions) {
  const discovered = await discoverExtensions(extensionPaths);

  if (extensionAutoload) {
    return discovered;
  }

  // Filter to only explicitly listed extensions
  if (extensions && extensions.length > 0) {
    return discovered.filter((ext) => extensions.includes(ext.name));
  }

  // If autoload is false but no extensions list, return empty
  return [];
}

// ── Extension Loader ─────────────────────────────────────────────────────────

/**
 * Extension loader — manages the lifecycle of extensions.
 */
export class ExtensionLoader {
  /**
   * @param {Object} core - The core object with hooks and toolRegistry.
   * @param {Object} [core.configRegistry] - Optional config registry for extension config registration.
   * @param {Object} [core.cliSubcommandRegistry] - Optional CLI subcommand registry for CLI extensions.
   */
  constructor(core) {
    this._core = core;
    this._extensions = new Map();
    // Track removal functions per extension so we can cleanly deregister
    // only this extension's handlers on unload.
    this._handlerRemovers = new Map();
    // Track the entry point (module path) used to load each extension.
    // Used by the refresh tool to know which paths to re-import.
    this._entryPoints = new Map();
    // Config registry for extension CLI flags and config params
    this._configRegistry = core.configRegistry || null;
    // CLI subcommand registry for CLI extensions
    this._cliSubcommandRegistry = core.cliSubcommandRegistry || null;
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
   * @param {Object} [createOptions] - Options to pass to the extension's `create()` function.
   * @returns {Promise<Object>} The loaded extension instance.
   */
  async load(name, entryPoint, createOptions = {}) {
    // Resolve the module — add cache-busting query string so hot-reloads
    // bypass the JS engine's native module cache
    let extModule;
    if (typeof entryPoint === 'string') {
      extModule = await import(`${entryPoint}?t=${Date.now()}`);
    } else {
      extModule = entryPoint;
    }

    // Create the extension instance
    const instance = extModule.create
      ? extModule.create(this._core, createOptions)
      : extModule;

    if (!instance) {
      return null;
    }

    this._extensions.set(name, instance);

    // Store the entry point path for hot-reload support
    if (typeof entryPoint === 'string') {
      this._entryPoints.set(name, entryPoint);
    }

    // Track removal functions for this extension's hooks
    const removers = [];
    this._handlerRemovers.set(name, removers);

    // Auto-register hooks if the extension has them
    // Skip TOOLS_REGISTER — tool registration is handled separately below
    // to avoid double emission (the hook was previously emitted in main.js
    // AND here, causing tools to be registered twice).
    if (instance.hooks) {
      for (const [hookName, handler] of Object.entries(instance.hooks)) {
        if (hookName === HOOKS.TOOLS_REGISTER) continue;
        const remove = this._core.hooks.on(hookName, handler);
        removers.push(remove);
      }
    }

    // Tool registration: call tools:register handlers directly during load().
    // Extensions can register via hooks: { [HOOKS.TOOLS_REGISTER]: ... }
    // OR via registerTools() — both paths are handled here so tool
    // registration happens exactly once per extension, during load().
    if (instance.hooks?.[HOOKS.TOOLS_REGISTER]) {
      await instance.hooks[HOOKS.TOOLS_REGISTER](this._core.toolRegistry);
    } else if (instance.registerTools) {
      await instance.registerTools(this._core.toolRegistry);
    }

    // Emit config registration hooks for CLI flags and config params
    if (this._configRegistry) {
      await emitConfigRegistration(instance, this._configRegistry);
    }

    return instance;
  }

  /**
   * Hot-reload an extension: unload and reload.
   * @param {string} name
   * @param {string|Object} entryPoint
   * @param {Object} [createOptions] - Options to pass to the extension's `create()` function.
   * @returns {Promise<Object>}
   */
  async reload(name, entryPoint, createOptions = {}) {
    await this.unload(name);
    return await this.load(name, entryPoint, createOptions);
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
      this._entryPoints.delete(name);
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
   * Get all entry point paths as [name, path] pairs.
   * Returns only extensions that were loaded via a string path (not inline modules).
   * @returns {Map<string, string>}
   */
  entryPoints() {
    return this._entryPoints;
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
