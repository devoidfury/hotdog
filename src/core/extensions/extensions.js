// Extension loader — discovers, loads, and manages extensions.
// Extensions plug into the core via hooks and tool registration.

import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS, EXTENSION_PROVIDES } from "../hooks.js";

export { HOOKS, EXTENSION_PROVIDES };

// ── Schema Defaults Extraction ─────────────────────────────────────────────

/**
 * Convert extension name (kebab-case) to config key (camelCase).
 * e.g., "core-tools" → "coreTools", "model-switch" → "modelSwitch"
 */
export function extensionNameToConfigKey(name) {
  return name
    .split("-")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

/**
 * Extract default values from a JSON Schema's properties.
 * Returns a single config param entry with all defaults merged into one object.
 * This format is compatible with ConfigRegistry.registerConfigParams().
 *
 * @param {Object} schema - JSON Schema with properties containing defaults.
 * @param {string} [configKey] - Optional config key override. If not provided,
 *   defaults are returned with individual property keys.
 * @returns {Array<{key: string, description?: string, defaults: Object, schema?: Object, layers?: Object}>}
 */
export function extractSchemaDefaults(schema, configKey) {
  if (!schema) return [];

  // For object-type schemas: collect all defaults into a single entry
  if (schema.type === "object" && schema.properties) {
    const defaults = {};
    const layers = {};

    for (const [propName, prop] of Object.entries(schema.properties)) {
      if (prop.default !== undefined) {
        defaults[propName] = prop.default;
      } else if (prop.type === "object" && prop.properties) {
        // Collect nested defaults
        for (const [nestedKey, nestedProp] of Object.entries(prop.properties)) {
          if (nestedProp.default !== undefined) {
            defaults[nestedKey] = nestedProp.default;
          }
        }
      }

      // Extract layers if defined (extension layer support)
      if (prop.layers) {
        layers[propName] = prop.layers;
      }
    }

    const result = [
      {
        key: configKey || schema.$id || "config",
        description: schema.description || "",
        defaults,
        schema,
      },
    ];

    // Attach layers if any were found
    if (Object.keys(layers).length > 0) {
      result[0].layers = layers;
    }

    return Object.keys(defaults).length > 0 || Object.keys(layers).length > 0
      ? result
      : [];
  }

  // For array-type schemas: check for top-level default
  if (schema.type === "array" && schema.default !== undefined) {
    return [
      {
        key: configKey || schema.$id || "config",
        description: schema.description || "",
        defaults: { items: schema.default },
      },
    ];
  }

  return [];
}

/**
 * Get extension config defaults from extension.json schemas.
 * Returns config params in the format expected by ConfigRegistry.registerConfigParams().
 */
export async function getExtensionConfigDefaults(extensionPaths) {
  const params = [];

  for (const spec of extensionPaths || ["builtins"]) {
    const resolved = resolveExtensionPath(spec);
    const discovered = await discoverExtensionsInDir(resolved);

    for (const ext of discovered) {
      if (ext.configSchema) {
        const configKey = extensionNameToConfigKey(ext.name);
        const defaults = extractSchemaDefaults(ext.configSchema, configKey);
        params.push(...defaults);
      }
    }
  }

  return params;
}

// ── Config Registration ────────────────────────────────────────────────────

/**
 * Emit config registration hooks for an extension.
 */
export async function emitConfigRegistration(extension, configRegistry) {
  if (!extension || !configRegistry) return [];

  const errors = [];

  const cliFlagsResult = extension.hooks?.[HOOKS.CONFIG_CLI_FLAGS_REGISTER];
  if (cliFlagsResult) {
    try {
      const result =
        typeof cliFlagsResult === "function"
          ? await cliFlagsResult(configRegistry)
          : await cliFlagsResult;
      if (result && Array.isArray(result)) {
        configRegistry.registerCliFlags(result);
      }
    } catch (e) {
      errors.push(`CONFIG_CLI_FLAGS_REGISTER failed: ${e.message}`);
    }
  }

  const configParamsResult = extension.hooks?.[HOOKS.CONFIG_PARAMS_REGISTER];
  if (configParamsResult) {
    try {
      const result =
        typeof configParamsResult === "function"
          ? await configParamsResult(configRegistry)
          : await configParamsResult;
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
 */
export async function isExtensionDirectory(dirPath) {
  const metaPath = path.join(dirPath, "extension.json");
  try {
    await fsPromises.access(metaPath);
  } catch {
    return false;
  }
  const indexPath = path.join(dirPath, "index.js");
  try {
    await fsPromises.access(indexPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read extension metadata from extension.json file.
 */
async function readExtensionMetadata(dirPath) {
  const metaPath = path.join(dirPath, "extension.json");
  try {
    await fsPromises.access(metaPath);
  } catch {
    return {
      name: "",
      provides: [],
      loadOrder: LOAD_ORDER.DEFAULT,
      description: "",
      dependsOn: [],
      autoload: true,
      configSchema: null,
      cliSubcommands: [],
      cliFlags: [],
    };
  }
  try {
    const content = await fsPromises.readFile(metaPath, "utf-8");
    const meta = JSON.parse(content);

    const provides = Array.isArray(meta.provides) ? meta.provides : [];
    const description =
      typeof meta.description === "string" ? meta.description : "";
    const dependsOn = Array.isArray(meta.dependsOn) ? meta.dependsOn : [];
    const autoload = meta.autoload !== false;
    const configSchema =
      meta.configSchema &&
      typeof meta.configSchema === "object" &&
      !Array.isArray(meta.configSchema)
        ? meta.configSchema
        : null;

    const cliSubcommands = Array.isArray(meta["cli:subcommands"])
      ? meta["cli:subcommands"].map((sc) => ({
          name: sc.name || "",
          description: sc.description || "",
          options: Array.isArray(sc.options) ? sc.options : [],
        }))
      : [];

    const cliFlags = Array.isArray(meta["cli:flags"])
      ? meta["cli:flags"].map((flag) => ({
          short: flag.short || null,
          long: flag.long || "",
          description: flag.description || "",
          type: flag.type || "string",
          default: flag.default !== undefined ? flag.default : null,
        }))
      : [];

    let loadOrder = LOAD_ORDER.DEFAULT;
    if (meta.loadOrder !== undefined) {
      loadOrder = meta.loadOrder;
    } else if (provides.includes(EXTENSION_PROVIDES.CLI_SUBCOMMANDS)) {
      loadOrder = LOAD_ORDER.CLI;
    }

    return {
      name: meta.name || "",
      provides,
      loadOrder,
      description,
      dependsOn,
      autoload,
      configSchema,
      cliSubcommands,
      cliFlags,
    };
  } catch {
    return {
      name: "",
      provides: [],
      loadOrder: LOAD_ORDER.DEFAULT,
      description: "",
      dependsOn: [],
      autoload: true,
      configSchema: null,
      cliSubcommands: [],
      cliFlags: [],
    };
  }
}

/**
 * Discover extensions in a directory recursively.
 */
export async function discoverExtensionsInDir(dirPath) {
  const extensions = [];

  try {
    const stats = await fsPromises.stat(dirPath);
    if (!stats.isDirectory()) {
      return extensions;
    }
  } catch {
    return extensions;
  }

  async function scanDirectory(currentDir, relativeBase = "") {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirFull = path.join(currentDir, entry.name);
      const relativePath = relativeBase
        ? `${relativeBase}/${entry.name}`
        : entry.name;

      if (await isExtensionDirectory(dirFull)) {
        const {
          name,
          provides,
          loadOrder,
          dependsOn,
          autoload,
          configSchema,
          cliSubcommands,
          cliFlags,
        } = await readExtensionMetadata(dirFull);

        extensions.push({
          name: name || entry.name,
          path: `./extensions/${relativePath}/index.js`,
          dirPath: dirFull,
          provides,
          loadOrder,
          dependsOn,
          autoload,
          configSchema,
          cliSubcommands,
          cliFlags,
        });
      }

      // Recurse into subdirectories regardless of whether this one is an extension
      await scanDirectory(dirFull, relativePath);
    }
  }

  await scanDirectory(dirPath);

  return extensions;
}

/**
 * Load order constants for extensions.
 */
export const LOAD_ORDER = {
  REFRESH: 0,
  CORE_TOOLS: 1,
  CLI: 2,
  DEFAULT: 10,
};

/**
 * Resolve load order based on extension dependencies using topological sort.
 */
export function resolveLoadOrder(extensions) {
  const nameSet = new Set(extensions.map((e) => e.name));
  const deps = new Map();

  for (const ext of extensions) {
    const validDeps = ext.dependsOn.filter((d) => nameSet.has(d));
    deps.set(ext.name, validDeps);
  }

  const inDegree = new Map();
  const adjList = new Map();

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

  const queue = extensions
    .filter((e) => (inDegree.get(e.name) || 0) === 0)
    .sort((a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name));

  const result = [];

  while (queue.length > 0) {
    queue.sort(
      (a, b) => a.loadOrder - b.loadOrder || a.name.localeCompare(b.name),
    );
    const current = queue.shift();
    result.push(current);

    for (const dependent of adjList.get(current.name) || []) {
      inDegree.set(dependent, inDegree.get(dependent) - 1);
      if (inDegree.get(dependent) === 0) {
        const depExt = extensions.find((e) => e.name === dependent);
        if (depExt) queue.push(depExt);
      }
    }
  }

  if (result.length !== extensions.length) {
    const remaining = extensions.filter(
      (e) => !result.find((r) => r.name === e.name),
    );
    const cycleNames = remaining.map((e) => e.name).join(", ");
    throw new Error(
      `Circular dependency detected among extensions: ${cycleNames}`,
    );
  }

  return result;
}

/**
 * Discover all extensions from configured extension paths.
 */
export async function discoverExtensions(extensionPaths) {
  const allExtensions = [];

  for (const spec of extensionPaths) {
    const resolved = resolveExtensionPath(spec);
    const discovered = await discoverExtensionsInDir(resolved);

    for (const ext of discovered) {
      let basePath;
      if (spec === "builtins") {
        basePath = `../../extensions/${ext.name}/index.js`;
      } else {
        const relPath = path.relative(
          ROOT_DIR,
          path.join(resolved, ext.name, "index.js"),
        );
        basePath = relPath.startsWith("..") ? relPath : `./${relPath}`;
      }

      allExtensions.push({
        name: ext.name,
        path: basePath,
        loadOrder: ext.loadOrder,
        provides: ext.provides,
        dependsOn: ext.dependsOn,
        autoload: ext.autoload,
        configSchema: ext.configSchema,
        cliSubcommands: ext.cliSubcommands || [],
        cliFlags: ext.cliFlags || [],
      });
    }
  }

  return resolveLoadOrder(allExtensions);
}

/**
 * Get all extension config schemas as an object keyed by extension name.
 */
export async function getExtensionConfigSchemas(extensionPaths) {
  const schemas = {};

  for (const spec of extensionPaths) {
    const resolved = resolveExtensionPath(spec);
    const discovered = await discoverExtensionsInDir(resolved);

    for (const ext of discovered) {
      if (ext.configSchema !== null) {
        schemas[ext.name] = ext.configSchema;
      }
    }
  }

  return schemas;
}

/**
 * Check if an extension is enabled based on its config.
 * An extension is disabled when its config section has `enabled: false`.
 * If the config section doesn't exist or `enabled` is not set, the extension
 * is considered enabled (defaults to true).
 *
 * @param {string} extName - Extension name (kebab-case, e.g., "bash-tool").
 * @param {Object} config - The resolved config object.
 * @returns {boolean} true if the extension should be loaded.
 */
export function isExtensionEnabled(extName, config) {
  if (!config) return true;
  const configKey = extensionNameToConfigKey(extName);
  const extConfig = config[configKey];
  if (extConfig && typeof extConfig === "object") {
    return extConfig.enabled !== false;
  }
  return true;
}

/**
 * Get the list of extensions to load based on config settings.
 * Filters out extensions whose config has `enabled: false`.
 *
 * @param {string[]} extensionPaths - Paths to search for extensions.
 * @param {boolean} extensionAutoload - Whether to autoload extensions.
 * @param {string[]} extensions - Explicit list of extensions to load (when autoload is false).
 * @param {Object} [config] - Resolved config object for checking `enabled` settings.
 * @returns {Promise<Array>} Extensions to load, sorted by dependency order.
 */
export async function getExtensionsToLoad(
  extensionPaths,
  extensionAutoload,
  extensions,
  config,
) {
  const discovered = await discoverExtensions(extensionPaths);

  // Filter out extensions disabled via config (enabled: false)
  const enabledExtensions = config
    ? discovered.filter((ext) => isExtensionEnabled(ext.name, config))
    : discovered;

  if (extensionAutoload) {
    const autoloaded = enabledExtensions.filter((ext) => ext.autoload !== false);
    return resolveExtensionDependencies(autoloaded, enabledExtensions);
  }

  if (extensions && extensions.length > 0) {
    const selected = enabledExtensions.filter((ext) => extensions.includes(ext.name));
    return resolveExtensionDependencies(selected, enabledExtensions);
  }

  return [];
}

/**
 * Resolve extension dependencies.
 */
export function resolveExtensionDependencies(extensions, allDiscovered) {
  if (extensions.length === 0) return extensions;

  const extMap = new Map(allDiscovered.map((e) => [e.name, e]));
  const result = new Map();

  function addWithDeps(extName) {
    if (result.has(extName)) return;
    const ext = extMap.get(extName);
    if (!ext) return;

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

// ── Metadata Registration (consolidated from main.js) ────────────────────────

/**
 * Discover extensions and register their CLI flags, subcommands, and config params
 * from metadata. This reads extension.json files without loading any extension code.
 *
 * Config params are extracted from configSchema and registered automatically,
 * making extension.json the single source of truth for extension configuration.
 * Extensions can still use CONFIG_PARAMS_REGISTER for programmatic control,
 * but the common case is schema-only.
 *
 * @param {Object} config - Configuration with extension paths and autoload settings.
 * @param {Object} configRegistry - Config registry to register CLI flags and config params.
 * @param {Object} cliSubcommandRegistry - Subcommand registry to register subcommands.
 * @returns {Promise<Array>} Array of discovered extension metadata.
 */
export async function registerExtensionMetadata(
  config,
  configRegistry,
  cliSubcommandRegistry,
) {
  const extensionPaths = config?.extensionPaths || ["builtins"];
  const extensionAutoload = config?.extensionAutoload ?? false;
  const extensionsList = config?.extensions || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
  );

  // Register CLI flags from extension metadata
  for (const ext of extensionsToLoad) {
    if (ext.cliFlags && ext.cliFlags.length > 0) {
      const flags = ext.cliFlags.map((flag) => ({
        short: flag.short,
        long: flag.long,
        description: flag.description,
        type: flag.type,
        default: flag.default,
      }));
      configRegistry.registerCliFlags(flags);
    }
  }

  // Register config params from configSchema (single source of truth)
  // This makes extension.json the canonical config definition.
  // Extensions can still use CONFIG_PARAMS_REGISTER for additional/programmatic params.
  for (const ext of extensionsToLoad) {
    if (ext.configSchema) {
      const configKey = extensionNameToConfigKey(ext.name);
      const params = extractSchemaDefaults(ext.configSchema, configKey);
      if (params.length > 0) {
        configRegistry.registerConfigParams(params);
      }
    }
  }

  // Register subcommands from extension metadata (for help/discovery without loading)
  for (const ext of extensionsToLoad) {
    if (ext.cliSubcommands && ext.cliSubcommands.length > 0) {
      for (const sc of ext.cliSubcommands) {
        cliSubcommandRegistry.register(sc.name, {
          description: sc.description || "",
          options: sc.options || [],
          handler: null,
        });
      }
    }
  }

  return extensionsToLoad;
}

// ── Extension Loader ─────────────────────────────────────────────────────────

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
    this._handlerRemovers = new Map();
    this._entryPoints = new Map();
    this._metadata = new Map();
    this._configRegistry = core.configRegistry || null;
    this._cliSubcommandRegistry = core.cliSubcommandRegistry || null;
  }

  /**
   * Load an extension by name and entry point.
   */
  async load(name, entryPoint, createOptions = {}) {
    let extModule;
    if (typeof entryPoint === "string") {
      extModule = await import(`${entryPoint}?t=${Date.now()}`);
    } else {
      extModule = entryPoint;
    }

    const instance = extModule.create
      ? await extModule.create(this._core, createOptions)
      : extModule;

    if (!instance) {
      return null;
    }

    this._extensions.set(name, instance);

    if (typeof entryPoint === "string") {
      this._entryPoints.set(name, entryPoint);
    }

    if (createOptions.provides) {
      this._metadata.set(name, {
        provides: createOptions.provides,
        dependsOn: createOptions.dependsOn || [],
      });
    }

    const removers = [];
    this._handlerRemovers.set(name, removers);

    if (instance.hooks) {
      for (const [hookName, handler] of Object.entries(instance.hooks)) {
        if (hookName === HOOKS.TOOLS_REGISTER) continue;
        // Pass extension name as source for name prefixing (e.g., chunk names)
        const remove = this._core.hooks.on(hookName, handler, name);
        removers.push(remove);
      }
    }

    if (instance.hooks?.[HOOKS.TOOLS_REGISTER]) {
      await instance.hooks[HOOKS.TOOLS_REGISTER](this._core.toolRegistry);
    } else if (instance.registerTools) {
      await instance.registerTools(this._core.toolRegistry);
    }

    if (this._configRegistry) {
      const configErrors = await emitConfigRegistration(
        instance,
        this._configRegistry,
      );
      if (configErrors.length > 0) {
        const msg = configErrors.join("; ");
        throw new Error(
          `Extension '${name}' config registration failed: ${msg}`,
        );
      }
    }

    return instance;
  }

  /**
   * Hot-reload an extension: unload and reload.
   */
  async reload(name, entryPoint, createOptions = {}) {
    await this.unload(name);
    return await this.load(name, entryPoint, createOptions);
  }

  /**
   * Unload an extension.
   */
  async unload(name) {
    const ext = this._extensions.get(name);
    if (ext) {
      if (ext.shutdown) {
        try {
          await ext.shutdown();
        } catch (e) {
          throw new Error(`Extension '${name}' shutdown failed: ${e.message}`);
        }
      }

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

  get(name) {
    return this._extensions.get(name);
  }

  all() {
    return Array.from(this._extensions.entries());
  }

  entryPoints() {
    return this._entryPoints;
  }

  has(name) {
    return this._extensions.has(name);
  }

  size() {
    return this._extensions.size;
  }

  getProvides(name) {
    const meta = this._metadata.get(name);
    return meta?.provides;
  }

  getDependsOn(name) {
    const meta = this._metadata.get(name);
    return meta?.dependsOn;
  }

  hasCapability(capability) {
    for (const [, meta] of this._metadata) {
      if (meta.provides?.includes(capability)) {
        return true;
      }
    }
    return false;
  }

  getProviders(capability) {
    const providers = [];
    for (const [name, meta] of this._metadata) {
      if (meta.provides?.includes(capability)) {
        providers.push(name);
      }
    }
    return providers;
  }

  async cleanup() {
    await this._core.hooks.emitAsync(HOOKS.SHUTDOWN_CLEANUP, null);
  }
}

/**
 * Create a new ExtensionLoader instance.
 */
export function createExtensionLoader(core) {
  return new ExtensionLoader(core);
}
