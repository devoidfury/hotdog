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
 * @returns {Promise<string[]>} Array of error messages (empty if no errors).
 */
export async function emitConfigRegistration(extension, configRegistry) {
  if (!extension || !configRegistry) return [];

  const errors = [];

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
      errors.push(`CONFIG_CLI_FLAGS_REGISTER failed: ${e.message}`);
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
      errors.push(`CONFIG_PARAMS_REGISTER failed: ${e.message}`);
    }
  }

  return errors;
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
 * Check if a directory is a valid extension.
 * An extension must have an extension.json metadata file and an index.js entry point.
 *
 * @param {string} dirPath - Directory path to check.
 * @returns {boolean} True if the directory is a valid extension.
 */
export function isExtensionDirectory(dirPath) {
  const metaPath = path.join(dirPath, "extension.json");
  if (!fs.existsSync(metaPath)) {
    return false;
  }
  // Must also have an index.js entry point
  const indexPath = path.join(dirPath, "index.js");
  return fs.existsSync(indexPath);
}

/**
 * Read extension metadata from extension.json file.
 *
 * @param {string} dirPath - Extension directory path.
 * @returns {{name: string, provides: string[], loadOrder: number, description: string, dependsOn: string[]}} Extension metadata.
 */
function readExtensionMetadata(dirPath) {
  const metaPath = path.join(dirPath, "extension.json");
  if (!fs.existsSync(metaPath)) {
    return { name: "", provides: [], loadOrder: LOAD_ORDER.DEFAULT, description: "", dependsOn: [], autoload: true };
  }
  try {
    const content = fs.readFileSync(metaPath, "utf-8");
    const meta = JSON.parse(content);

    const provides = Array.isArray(meta.provides) ? meta.provides : [];
    const description = typeof meta.description === "string" ? meta.description : "";
    const dependsOn = Array.isArray(meta.dependsOn) ? meta.dependsOn : [];
    const autoload = meta.autoload !== false; // default true — false means "don't auto-discover"

    // Determine load order: explicit in JSON, or infer from capabilities
    let loadOrder = LOAD_ORDER.DEFAULT;
    if (meta.loadOrder !== undefined) {
      loadOrder = meta.loadOrder;
    } else if (provides.includes(EXTENSION_PROVIDES.CLI_SUBCOMMANDS)) {
      loadOrder = LOAD_ORDER.CLI;
    }

    return { name: meta.name || "", provides, loadOrder, description, dependsOn, autoload };
  } catch {
    return { name: "", provides: [], loadOrder: LOAD_ORDER.DEFAULT, description: "", dependsOn: [], autoload: true };
  }
}

/**
 * Discover extensions in a directory.
 * Walks subdirectories and returns those with extension.json metadata.
 * Uses extension.json as the primary discovery signal — an extension
 * is any directory containing extension.json + index.js.
 *
 * @param {string} dirPath - Directory to search.
 * @returns {Array<{name: string, path: string, provides: string[], loadOrder: number, dependsOn: string[], autoload: boolean}>} Array of discovered extensions.
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
      // Read extension metadata (includes name, provides, loadOrder, dependsOn)
      const { name, provides, loadOrder, dependsOn, autoload } = readExtensionMetadata(dirFull);

      extensions.push({
        name: name || entry.name,
        path: `../extensions/${entry.name}/index.js`,
        provides,
        loadOrder,
        dependsOn,
        autoload,
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
 * Resolve load order based on extension dependencies using topological sort.
 *
 * Extensions that declare `dependsOn` will be loaded after their dependencies,
 * regardless of their explicit `loadOrder` value. For extensions without
 * dependencies, the explicit `loadOrder` is used as a tiebreaker.
 *
 * @param {Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[]}>} extensions - Discovered extensions.
 * @returns {Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[]}>} Extensions sorted by dependency order.
 * @throws {Error} If a circular dependency is detected.
 */
export function resolveLoadOrder(extensions) {
  // Build dependency graph
  const nameSet = new Set(extensions.map(e => e.name));
  const deps = new Map();  // name -> [dependency names]

  for (const ext of extensions) {
    // Filter to only known dependencies (ignore unknown ones — they'll be caught later)
    const validDeps = ext.dependsOn.filter(d => nameSet.has(d));
    deps.set(ext.name, validDeps);
  }

  // Topological sort using Kahn's algorithm with loadOrder tiebreaker
  const inDegree = new Map();
  const adjList = new Map();  // dependency -> [dependents]

  for (const ext of extensions) {
    if (!inDegree.has(ext.name)) inDegree.set(ext.name, 0);
    if (!adjList.has(ext.name)) adjList.set(ext.name, []);
  }

  for (const [name, depList] of deps) {
    for (const dep of depList) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep).push(name);
      inDegree.set(name, (inDegree.get(name) || 0) + 1);
    }
  }

  // Start with nodes that have no dependencies
  const queue = extensions
    .filter(e => (inDegree.get(e.name) || 0) === 0)
    .sort((a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name));

  const result = [];

  while (queue.length > 0) {
    // Pick the node with the lowest loadOrder among available nodes
    queue.sort((a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name));
    const current = queue.shift();
    result.push(current);

    // Reduce in-degree for dependents
    for (const dependent of (adjList.get(current.name) || [])) {
      inDegree.set(dependent, inDegree.get(dependent) - 1);
      if (inDegree.get(dependent) === 0) {
        const depExt = extensions.find(e => e.name === dependent);
        if (depExt) queue.push(depExt);
      }
    }
  }

  // Check for cycles: if result doesn't include all extensions, there's a cycle
  if (result.length !== extensions.length) {
    const remaining = extensions.filter(e => !result.find(r => r.name === e.name));
    const cycleNames = remaining.map(e => e.name).join(", ");
    throw new Error(`Circular dependency detected among extensions: ${cycleNames}`);
  }

  return result;
}

/**
 * Discover all extensions from configured extension paths.
 * Reads extension capabilities (provides array), dependencies (dependsOn),
 * and autoload settings to determine load order via topological sort.
 *
 * @param {Array<string>} extensionPaths - Array of path specs (e.g., ["builtins", "/custom/extensions"]).
 * @returns {Promise<Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[], autoload: boolean}>>} Array of discovered extensions.
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
        dependsOn: ext.dependsOn,
        autoload: ext.autoload,
      });
    }
  }

  // Resolve load order using topological sort (respects dependsOn)
  return resolveLoadOrder(allExtensions);
}

/**
 * Get the list of extensions to load based on config settings.
 *
 * When extensionAutoload is true:
 *   Returns all discovered extensions EXCEPT those with `autoload: false`
 *   in their extension.json. Extensions with autoload: false must be
 *   explicitly listed in the `extensions` config to be loaded.
 *
 * When extensionAutoload is false:
 *   Returns only extensions whose names match entries in the `extensions`
 *   config array, plus their transitive dependencies (resolved via
 *   `dependsOn` in extension.json).
 *
 * @param {Array<string>} extensionPaths - Configured extension paths.
 * @param {boolean} extensionAutoload - Whether to auto-discover all extensions.
 * @param {Array<string>} extensions - Explicit list of extension names to load.
 * @returns {Promise<Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[], autoload: boolean}>>} Extensions to load.
 */
export async function getExtensionsToLoad(extensionPaths, extensionAutoload, extensions) {
  const discovered = await discoverExtensions(extensionPaths);

  if (extensionAutoload) {
    // Filter out extensions with autoload: false — they must be
    // explicitly listed to be loaded.
    return discovered.filter((ext) => ext.autoload !== false);
  }

  // Filter to only explicitly listed extensions
  if (extensions && extensions.length > 0) {
    const selected = discovered.filter((ext) => extensions.includes(ext.name));
    // Resolve transitive dependencies — if extension A depends on B,
    // and A is explicitly listed but B is not, include B.
    return resolveExtensionDependencies(selected, discovered);
  }

  // If autoload is false but no extensions list, return empty
  return [];
}

/**
 * Resolve extension dependencies: for each extension, also include its
 * transitive dependencies in the load list.
 *
 * This is used when an extension explicitly lists its dependencies but
 * the dependencies themselves aren't in the explicit extensions list.
 *
 * @param {Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[], autoload: boolean}>} extensions - Extensions to load.
 * @param {Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[], autoload: boolean}>} allDiscovered - All discovered extensions (for resolving dependency names).
 * @returns {Array<{name: string, path: string, loadOrder: number, provides: string[], dependsOn: string[], autoload: boolean}>} Extensions with dependencies included.
 */
export function resolveExtensionDependencies(extensions, allDiscovered) {
  if (extensions.length === 0) return extensions;

  const extMap = new Map(allDiscovered.map(e => [e.name, e]));
  const result = new Map();

  function addWithDeps(extName) {
    if (result.has(extName)) return;
    const ext = extMap.get(extName);
    if (!ext) return;

    // First add dependencies
    for (const dep of ext.dependsOn) {
      addWithDeps(dep);
    }
    result.set(extName, ext);
  }

  for (const ext of extensions) {
    addWithDeps(ext.name);
  }

  return Array.from(result.values());
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
    // Track extension metadata (provides, dependsOn) for capability queries.
    this._metadata = new Map();
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

    // Store extension metadata for capability queries
    if (createOptions.provides) {
      this._metadata.set(name, {
        provides: createOptions.provides,
        dependsOn: createOptions.dependsOn || [],
      });
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
    // Errors here are fatal — config registration is part of extension setup
    if (this._configRegistry) {
      const configErrors = await emitConfigRegistration(instance, this._configRegistry);
      if (configErrors.length > 0) {
        const msg = configErrors.join('; ');
        throw new Error(`Extension '${name}' config registration failed: ${msg}`);
      }
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
   * @throws {Error} If shutdown fails.
   */
  async unload(name) {
    const ext = this._extensions.get(name);
    if (ext) {
      // Call shutdown if available — rethrow on failure
      if (ext.shutdown) {
        try {
          await ext.shutdown();
        } catch (e) {
          throw new Error(`Extension '${name}' shutdown failed: ${e.message}`);
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
      this._metadata.delete(name);
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
   * Get the `provides` array for a loaded extension.
   * @param {string} name - Extension name.
   * @returns {string[]|undefined} Provides array, or undefined if not loaded.
   */
  getProvides(name) {
    const meta = this._metadata.get(name);
    return meta?.provides;
  }

  /**
   * Get the `dependsOn` array for a loaded extension.
   * @param {string} name - Extension name.
   * @returns {string[]|undefined} DependsOn array, or undefined if not loaded.
   */
  getDependsOn(name) {
    const meta = this._metadata.get(name);
    return meta?.dependsOn;
  }

  /**
   * Check if any loaded extension provides a given capability.
   * Capabilities are declared in extension.json `provides` array.
   * @param {string} capability - Capability name (e.g., "tools", "cli:subcommands").
   * @returns {boolean} True if at least one extension provides this capability.
   */
  hasCapability(capability) {
    for (const [, meta] of this._metadata) {
      if (meta.provides?.includes(capability)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all extensions that provide a given capability.
   * @param {string} capability - Capability name.
   * @returns {string[]} Extension names that provide this capability.
   */
  getProviders(capability) {
    const providers = [];
    for (const [name, meta] of this._metadata) {
      if (meta.provides?.includes(capability)) {
        providers.push(name);
      }
    }
    return providers;
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
