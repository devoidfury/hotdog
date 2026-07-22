// Extension loader

import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS, EXTENSION_PROVIDES, type HookSystem, type HookHandlerAny } from "../hooks.ts";
import { ExtensionError } from "../error.ts";
import { logger } from "../logger.ts";
import { camelCase } from "../../utils/strings.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { ServiceRegistry } from "./service-registry.ts";
import type { ConfigRegistry } from "./config-registry.ts";
import type { CliSubcommandRegistry } from "./registries.ts";
import type { CoreConfig } from "../config/schema-loader.ts";

export { HOOKS, EXTENSION_PROVIDES };

export interface SchemaDefaultEntry {
  key: string;
  description?: string;
  defaults: unknown;
  schema?: Record<string, unknown>;
  layers?: unknown;
}

export function extractSchemaDefaults(
  schema: Record<string, unknown> | null | undefined,
): SchemaDefaultEntry[] {
  if (!schema || typeof schema !== "object") return [];

  const result: SchemaDefaultEntry[] = [];
  for (const [keyName, keySchemaRaw] of Object.entries(schema)) {
    const keySchema = keySchemaRaw as Record<string, unknown>;
    let defaults: unknown;
    if ((keySchema.type as string) === "object" && keySchema.properties) {
      defaults = {};
      for (const [propName, propRaw] of Object.entries(
        keySchema.properties as Record<string, unknown>,
      )) {
        const prop = propRaw as Record<string, unknown>;
        if (prop.default !== undefined && prop.default !== null) {
          (defaults as Record<string, unknown>)[propName] = prop.default;
        }
      }
    } else if (keySchema.default !== undefined) {
      defaults = keySchema.default;
    }

    const entry: SchemaDefaultEntry = {
      key: keyName,
      description: (keySchema.description as string) || "",
      defaults,
      schema: keySchema,
    };
    if (keySchema.layers) {
      entry.layers = keySchema.layers;
    }
    result.push(entry);
  }
  return result;
}

export async function getExtensionConfigDefaults(
  extensionPaths?: string[],
): Promise<SchemaDefaultEntry[]> {
  const params: SchemaDefaultEntry[] = [];

  for (const spec of extensionPaths || ["builtins"]) {
    const resolved = resolveExtensionPath(spec);
    const discovered = await discoverExtensionsInDir(resolved);

    for (const ext of discovered) {
      if (ext.configSchema) {
        const defaults = extractSchemaDefaults(ext.configSchema);
        params.push(...defaults);
      }
    }
  }

  return params;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../");

export interface ExtensionMetadata {
  name: string;
  path?: string;
  provides: string[];
  loadOrder: number;
  description: string;
  dependsOn: string[];
  autoload: boolean;
  configSchema: Record<string, unknown> | null;
  cliSubcommands: Array<{
    name: string;
    description: string;
    options: unknown[];
  }>;
  cliFlags: Array<{
    short: string | null;
    long: string;
    description: string;
    type: string;
    default: unknown;
  }>;
  services: Record<string, unknown[]>;
  requires: Record<string, unknown[]>;
}

export function resolveExtensionPath(spec: string): string {
  if (spec === "builtins") {
    return path.join(ROOT_DIR, "extensions");
  }
  if (path.isAbsolute(spec)) {
    return spec;
  }
  return path.resolve(process.cwd(), spec);
}

export async function isExtensionDirectory(dirPath: string): Promise<boolean> {
  const metaPath = path.join(dirPath, "extension.json");
  try {
    await fsPromises.access(metaPath);
  } catch {
    return false;
  }
  for (const ext of [".js", ".ts"]) {
    const indexPath = path.join(dirPath, `index${ext}`);
    try {
      await fsPromises.access(indexPath);
      return true;
    } catch {
      // Try next extension
    }
  }
  return false;
}

async function readExtensionMetadata(
  dirPath: string,
): Promise<ExtensionMetadata> {
  const metaPath = path.join(dirPath, "extension.json");
  const name = path.basename(dirPath);
  try {
    await fsPromises.access(metaPath);
  } catch {
    return {
      name,
      path: metaPath,
      provides: [],
      loadOrder: LOAD_ORDER.DEFAULT,
      description: "",
      dependsOn: [],
      autoload: true,
      configSchema: null,
      cliSubcommands: [],
      cliFlags: [],
      services: {},
      requires: {},
    };
  }
  let meta: Record<string, unknown> | null = null;
  try {
    const content = await fsPromises.readFile(metaPath, "utf-8");
    meta = JSON.parse(content) as Record<string, unknown>;

    const provides = Array.isArray(meta.provides)
      ? (meta.provides as string[])
      : [];
    const description =
      typeof meta.description === "string" ? meta.description : "";
    const dependsOn = Array.isArray(meta.dependsOn)
      ? (meta.dependsOn as string[])
      : [];
    const autoload = (meta.autoload as boolean) !== false;
    const configSchema =
      meta.configSchema &&
      typeof meta.configSchema === "object" &&
      !Array.isArray(meta.configSchema)
        ? (meta.configSchema as Record<string, unknown>)
        : null;

    const cliSubcommands = Array.isArray(meta["cli:subcommands"])
      ? (meta["cli:subcommands"] as Array<Record<string, unknown>>).map(
          (sc) => ({
            name: (sc.name as string) || "",
            description: (sc.description as string) || "",
            options: Array.isArray(sc.options) ? (sc.options as unknown[]) : [],
          }),
        )
      : [];

    const cliFlags = Array.isArray(meta["cli:flags"])
      ? (meta["cli:flags"] as Array<Record<string, unknown>>).map((flag) => ({
          short: (flag.short as string) || null,
          long: (flag.long as string) || "",
          description: (flag.description as string) || "",
          type: (flag.type as string) || "string",
          default: flag.default !== undefined ? flag.default : null,
        }))
      : [];

    const services =
      meta.services &&
      typeof meta.services === "object" &&
      !Array.isArray(meta.services)
        ? (meta.services as Record<string, unknown[]>)
        : {};

    const requires =
      meta.requires &&
      typeof meta.requires === "object" &&
      !Array.isArray(meta.requires)
        ? (meta.requires as Record<string, unknown[]>)
        : {};

    let loadOrder: number = LOAD_ORDER.DEFAULT;
    if (meta.loadOrder !== undefined) {
      loadOrder = meta.loadOrder as number;
    } else if (provides.includes(EXTENSION_PROVIDES.CLI_SUBCOMMANDS)) {
      loadOrder = LOAD_ORDER.CLI;
    }

    return {
      name: meta.name ? `${meta.name}` : name,
      provides,
      loadOrder,
      description,
      dependsOn,
      autoload,
      configSchema,
      cliSubcommands,
      cliFlags,
      services,
      requires,
    };
  } catch {
    return {
      name: meta?.name ? `${meta.name}` : name,
      provides: [],
      loadOrder: LOAD_ORDER.DEFAULT,
      description: "",
      dependsOn: [],
      autoload: true,
      configSchema: null,
      cliSubcommands: [],
      cliFlags: [],
      services: {},
      requires: {},
    };
  }
}

export interface DiscoveredExtension extends ExtensionMetadata {
  path: string;
  dirPath: string;
}

export async function discoverExtensionsInDir(
  dirPath: string,
): Promise<DiscoveredExtension[]> {
  const extensions: DiscoveredExtension[] = [];

  try {
    const stats = await fsPromises.stat(dirPath);
    if (!stats.isDirectory()) {
      return extensions;
    }
  } catch {
    return extensions;
  }

  async function scanDirectory(
    currentDir: string,
    relativeBase = "",
  ): Promise<void> {
    const entries = await fsPromises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirFull = path.join(currentDir, entry.name);
      const relativePath = relativeBase
        ? `${relativeBase}/${entry.name}`
        : entry.name;

      if (await isExtensionDirectory(dirFull)) {
        const metadata = await readExtensionMetadata(dirFull);
        extensions.push({
          ...metadata,
          path: metadata.path || relativePath,
          dirPath,
        });
      }

      await scanDirectory(dirFull, relativePath);
    }
  }

  await scanDirectory(dirPath);

  return extensions;
}

export const LOAD_ORDER = {
  REFRESH: 0,
  CORE_TOOLS: 1,
  CLI: 2,
  DEFAULT: 10,
} as const;

export function resolveLoadOrder(
  extensions: ExtensionMetadata[],
  serviceOverrides: Record<string, string> = {},
): ExtensionMetadata[] {
  const nameSet = new Set(extensions.map((e) => e.name));

  const serviceMap = buildServiceProviderMap(extensions, serviceOverrides);

  const deps = new Map<string, string[]>();

  for (const ext of extensions) {
    const validDeps = ext.dependsOn.filter((d) => nameSet.has(d));
    const allDeps = [...validDeps];

    if (ext.requires && typeof ext.requires === "object") {
      for (const [serviceName] of Object.entries(ext.requires)) {
        const provider = serviceMap.get(serviceName);
        if (provider && nameSet.has(provider) && provider !== ext.name) {
          if (!allDeps.includes(provider)) {
            allDeps.push(provider);
          }
        }
      }
    }

    deps.set(ext.name, allDeps);
  }

  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const ext of extensions) {
    if (!inDegree.has(ext.name)) inDegree.set(ext.name, 0);
    if (!adjList.has(ext.name)) adjList.set(ext.name, []);
  }

  for (const [name, depList] of deps) {
    for (const dep of depList) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      const adj = adjList.get(dep)!;
      adj.push(name);
      inDegree.set(name, (inDegree.get(name) || 0) + 1);
    }
  }

  const cmp = (a: ExtensionMetadata, b: ExtensionMetadata) =>
    a.loadOrder - b.loadOrder || a.name.localeCompare(b.name);

  const queue = extensions
    .filter((e) => (inDegree.get(e.name) || 0) === 0)
    .sort(cmp);

  const result: ExtensionMetadata[] = [];
  const pending: ExtensionMetadata[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const dependent of adjList.get(current.name) || []) {
      inDegree.set(dependent, inDegree.get(dependent)! - 1);
      if (inDegree.get(dependent) === 0) {
        const depExt = extensions.find((e) => e.name === dependent);
        if (depExt) {
          pending.push(depExt);
        }
      }
    }
  }

  const maxIterations = extensions.length * extensions.length + 1;
  let iterationCount = 0;
  while (pending.length > 0) {
    iterationCount++;
    if (iterationCount > maxIterations) {
      const remaining = extensions.filter(
        (e) => !result.find((r) => r.name === e.name),
      );
      throw ExtensionError.CircularDependency(remaining.map((e) => e.name));
    }
    const batch = [...pending].sort(cmp);
    pending.length = 0;
    for (const ext of batch) {
      result.push(ext);
      for (const dependent of adjList.get(ext.name) || []) {
        inDegree.set(dependent, inDegree.get(dependent)! - 1);
        if (inDegree.get(dependent) === 0) {
          const depExt = extensions.find((e) => e.name === dependent);
          if (depExt) {
            pending.push(depExt);
          }
        }
      }
    }
  }

  if (result.length !== extensions.length) {
    const remaining = extensions.filter(
      (e) => !result.find((r) => r.name === e.name),
    );
    throw ExtensionError.CircularDependency(remaining.map((e) => e.name));
  }

  return result;
}

function buildServiceProviderMap(
  extensions: ExtensionMetadata[],
  serviceOverrides: Record<string, string>,
): Map<string, string> {
  const serviceMap = new Map<string, string>();

  const extNames = new Set(extensions.map((e) => e.name));

  for (const ext of extensions) {
    if (!ext.services || typeof ext.services !== "object") continue;

    for (const [serviceName, _methods] of Object.entries(ext.services)) {
      const override = serviceOverrides[serviceName];
      if (override) {
        if (override === ext.name && !serviceMap.has(serviceName)) {
          serviceMap.set(serviceName, ext.name);
        }
        continue;
      }

      if (!serviceMap.has(serviceName)) {
        serviceMap.set(serviceName, ext.name);
      } else {
        logger.warn(
          `[services] Multiple extensions provide "${serviceName}": ` +
            `"${serviceMap.get(serviceName)}" and "${ext.name}". ` +
            `Using "${serviceMap.get(serviceName)}". ` +
            `Set services.${serviceName} in config to override.`,
        );
      }
    }
  }

  for (const [serviceName, targetExtName] of Object.entries(serviceOverrides)) {
    if (!targetExtName) continue;
    if (!extNames.has(targetExtName)) {
      logger.warn(
        `[services] Config override sets "${serviceName}" to "${targetExtName}" ` +
          `but no extension with that name was discovered.`,
      );
      continue;
    }
    if (!serviceMap.has(serviceName)) {
      logger.warn(
        `[services] Config override sets "${serviceName}" to "${targetExtName}" ` +
          `but extension "${targetExtName}" does not declare "${serviceName}" in its services.`,
      );
    }
  }

  return serviceMap;
}

export async function discoverExtensions(
  extensionPaths: string[],
  serviceOverrides: Record<string, string> = {},
): Promise<ExtensionMetadata[]> {
  const allExtensions: ExtensionMetadata[] = [];

  for (const spec of extensionPaths) {
    const resolved = resolveExtensionPath(spec);
    const discovered = await discoverExtensionsInDir(resolved);

    for (const ext of discovered) {
      let basePath: string;
      if (spec === "builtins") {
        basePath = `../../extensions/${ext.name}/index.ts`;
      } else {
        const relPath = path.relative(
          ROOT_DIR,
          path.join(resolved, ext.name, "index.ts"),
        );
        basePath = relPath.startsWith("..") ? relPath : `./${relPath}`;
      }

      allExtensions.push({
        name: ext.name,
        path: basePath,
        provides: ext.provides,
        loadOrder: ext.loadOrder,
        dependsOn: ext.dependsOn,
        autoload: ext.autoload,
        configSchema: ext.configSchema,
        cliSubcommands: ext.cliSubcommands || [],
        cliFlags: ext.cliFlags || [],
        services: ext.services || {},
        requires: ext.requires || {},
        description: ext.description,
      });
    }
  }

  return resolveLoadOrder(allExtensions, serviceOverrides);
}

export async function getExtensionConfigSchemas(
  extensionPaths: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const schemas: Record<string, Record<string, unknown>> = {};

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

export function isExtensionEnabled(
  extName: string,
  config: CoreConfig | null | undefined,
): boolean {
  if (!config) return true;
  const configKey = camelCase(extName);
  const extConfig = (config as Record<string, unknown>)[configKey];
  if (extConfig && typeof extConfig === "object") {
    return (extConfig as Record<string, unknown>).enabled !== false;
  }
  return true;
}

export async function getExtensionsToLoad(
  extensionPaths: string[],
  extensionAutoload: boolean,
  extensions: string[],
  config?: CoreConfig,
): Promise<ExtensionMetadata[]> {
  const configAny = config as Record<string, unknown> | undefined;
  const serviceOverrides = (configAny?.services as Record<string, string>) || {};

  const discovered = await discoverExtensions(extensionPaths, serviceOverrides);

  const enabledExtensions = config
    ? discovered.filter((ext) => isExtensionEnabled(ext.name, config))
    : discovered;

  if (extensionAutoload) {
    const autoloaded = enabledExtensions.filter(
      (ext) => ext.autoload !== false,
    );
    return resolveExtensionDependencies(
      autoloaded,
      enabledExtensions,
      serviceOverrides,
    );
  }

  if (extensions && extensions.length > 0) {
    const selected = enabledExtensions.filter((ext) =>
      extensions.includes(ext.name),
    );
    return resolveExtensionDependencies(
      selected,
      enabledExtensions,
      serviceOverrides,
    );
  }

  return [];
}

export function resolveExtensionDependencies(
  extensions: ExtensionMetadata[],
  allDiscovered: ExtensionMetadata[],
  serviceOverrides: Record<string, string> = {},
): ExtensionMetadata[] {
  if (extensions.length === 0) return extensions;

  const extMap = new Map(allDiscovered.map((e) => [e.name, e]));
  const serviceMap = buildServiceProviderMap(allDiscovered, serviceOverrides);

  const result = new Map<string, ExtensionMetadata>();
  const visiting = new Set<string>();

  function addWithDeps(extName: string): void {
    if (result.has(extName)) return;
    if (visiting.has(extName)) return;
    const ext = extMap.get(extName);
    if (!ext) return;

    visiting.add(extName);

    for (const dep of ext.dependsOn) {
      addWithDeps(dep);
    }

    if (ext.requires && typeof ext.requires === "object") {
      for (const [serviceName] of Object.entries(ext.requires)) {
        const provider = serviceMap.get(serviceName);
        if (provider && provider !== ext.name) {
          addWithDeps(provider);
        }
      }
    }

    visiting.delete(extName);
    result.set(extName, ext);
  }

  for (const ext of extensions) {
    addWithDeps(ext.name);
  }

  return Array.from(result.values());
}

export async function registerExtensionMetadata(
  config: CoreConfig,
  configRegistry: ConfigRegistry,
  cliSubcommandRegistry: CliSubcommandRegistry,
): Promise<ExtensionMetadata[]> {
  const extensionPaths = (config?.extensionPaths as string[]) || ["builtins"];
  const extensionAutoload = (config?.extensionAutoload as boolean) ?? false;
  const extensionsList = (config?.extensions as string[]) || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
    config,
  );

  for (const ext of extensionsToLoad) {
    if (ext.cliFlags && ext.cliFlags.length > 0) {
      const flags = ext.cliFlags.map((flag) => ({
        short: flag.short ?? undefined,
        long: flag.long,
        description: flag.description,
        type: flag.type,
        default: flag.default,
      }));
      configRegistry.registerCliFlags(flags);
    }
  }

  for (const ext of extensionsToLoad) {
    if (ext.configSchema) {
      const params = extractSchemaDefaults(ext.configSchema);
      if (params.length > 0) {
        configRegistry.registerConfigParams(
          params.map((p) => ({
            key: p.key,
            description: p.description || "",
            defaults: (p.defaults ?? {}) as Record<string, unknown>,
            schema: p.schema,
            layers: Array.isArray(p.layers) ? p.layers : undefined,
          })),
        );
      }
      for (const [keyName, keySchema] of Object.entries(ext.configSchema)) {
        configRegistry.registerConfigSchema(keyName, keySchema as Record<string, unknown>);
      }
    }
  }

  for (const ext of extensionsToLoad) {
    if (ext.cliSubcommands && ext.cliSubcommands.length > 0) {
      for (const sc of ext.cliSubcommands) {
        cliSubcommandRegistry.register(sc.name, {
          description: sc.description || "",
          options: (sc.options?.length ? { items: sc.options } : undefined) as Record<string, unknown> | undefined,
          handler: undefined,
        });
      }
    }
  }

  return extensionsToLoad;
}

export interface LoaderCore {
  hooks: HookSystem;
  toolRegistry: ToolRegistry;
  services: ServiceRegistry;
  config?: CoreConfig;
  configRegistry: ConfigRegistry;
  cliSubcommandRegistry: CliSubcommandRegistry;
}

export class ExtensionLoader {
  #core: LoaderCore;
  #extensions: Map<string, unknown>;
  #handlerRemovers: Map<string, Array<() => void>>;
  #entryPoints: Map<string, string>;
  #metadata: Map<string, { provides?: string[]; dependsOn?: string[] }>;
  #toolOwners: Map<string, string[]>;
  #configRegistry: ConfigRegistry | null;
  #cliSubcommandRegistry: CliSubcommandRegistry | null;

  constructor(core: LoaderCore) {
    this.#core = core;
    this.#extensions = new Map();
    this.#handlerRemovers = new Map();
    this.#entryPoints = new Map();
    this.#metadata = new Map();
    this.#toolOwners = new Map();
    this.#configRegistry = core.configRegistry;
    this.#cliSubcommandRegistry = core.cliSubcommandRegistry;
  }

  async load(
    name: string,
    entryPoint: string | Record<string, unknown>,
    createOptions: Record<string, unknown> = {},
  ): Promise<unknown> {
    let extModule: Record<string, unknown>;
    if (typeof entryPoint === "string") {
      extModule = (await import(entryPoint)) as Record<string, unknown>;
    } else {
      extModule = entryPoint;
    }

    const createFn = extModule.create as ((core: LoaderCore, opts: Record<string, unknown>) => unknown) | undefined;
    const instance = createFn
      ? await createFn(this.#core, createOptions)
      : extModule;

    if (!instance) {
      return null;
    }

    this.#extensions.set(name, instance);

    if (typeof entryPoint === "string") {
      this.#entryPoints.set(name, entryPoint);
    }

    if (createOptions.provides || createOptions.dependsOn) {
      this.#metadata.set(name, {
        provides: createOptions.provides as string[],
        dependsOn: (createOptions.dependsOn as string[]) || [],
      });
    }

    const removers: Array<() => void> = [];
    this.#handlerRemovers.set(name, removers);

    const instanceHooks = (instance as Record<string, unknown>).hooks as Record<string, unknown> | undefined;
    if (instanceHooks) {
      for (const [hookName, handler] of Object.entries(instanceHooks)) {
        if (hookName === HOOKS.TOOLS_REGISTER) continue;
        if (hookName === HOOKS.SERVICES_REGISTER) continue;
        const remove = this.#core.hooks.on(hookName, handler as HookHandlerAny, name);
        removers.push(remove);
      }
    }

    if (
      instanceHooks &&
      instanceHooks[HOOKS.SERVICES_REGISTER]
    ) {
      (instanceHooks[HOOKS.SERVICES_REGISTER] as (registry: ServiceRegistry) => unknown)(this.#core.services);
    }

    const toolNamesBefore = new Set(
      Array.from(
        this.#core.toolRegistry.getAll().map(([n]) => n),
      ),
    );

    if (instanceHooks?.[HOOKS.TOOLS_REGISTER]) {
      await (instanceHooks[HOOKS.TOOLS_REGISTER] as (registry: ToolRegistry) => Promise<unknown>)(this.#core.toolRegistry);
    } else if ((instance as Record<string, unknown>).registerTools) {
      await ((instance as Record<string, unknown>).registerTools as (registry: ToolRegistry) => Promise<unknown>)(this.#core.toolRegistry);
    }

    const toolNamesAfter = new Set(
      Array.from(
        this.#core.toolRegistry.getAll().map(([n]) => n),
      ),
    );
    const newlyRegistered: string[] = [];
    for (const n of toolNamesAfter) {
      if (!toolNamesBefore.has(n)) {
        newlyRegistered.push(n);
      }
    }
    if (newlyRegistered.length > 0) {
      this.#toolOwners.set(name, newlyRegistered);
    }

    return instance;
  }

  async unload(name: string): Promise<void> {
    const ext = this.#extensions.get(name);
    if (ext) {
      if ((ext as Record<string, unknown>).shutdown) {
        try {
          await ((ext as Record<string, unknown>).shutdown as Function)();
        } catch (e) {
          throw ExtensionError.ShutdownFailed(name, (e as Error).message);
        }
      }

      const removers = this.#handlerRemovers.get(name);
      if (removers) {
        for (const remove of removers) {
          remove();
        }
        this.#handlerRemovers.delete(name);
      }

      const ownedTools = this.#toolOwners.get(name);
      if (ownedTools) {
        for (const toolName of ownedTools) {
          this.#core.toolRegistry.remove(toolName);
        }
        this.#toolOwners.delete(name);
      }

      this.#extensions.delete(name);
      this.#entryPoints.delete(name);
      this.#metadata.delete(name);
    }
  }

  get(name: string): unknown {
    return this.#extensions.get(name);
  }

  all(): [string, unknown][] {
    return Array.from(this.#extensions.entries());
  }

  entryPoints(): Map<string, string> {
    return this.#entryPoints;
  }

  has(name: string): boolean {
    return this.#extensions.has(name);
  }

  size(): number {
    return this.#extensions.size;
  }

  getProvides(name: string): string[] | undefined {
    const meta = this.#metadata.get(name);
    return meta?.provides;
  }

  getDependsOn(name: string): string[] | undefined {
    const meta = this.#metadata.get(name);
    return meta?.dependsOn;
  }

  hasCapability(capability: string): boolean {
    for (const [, meta] of this.#metadata) {
      if (meta.provides?.includes(capability)) {
        return true;
      }
    }
    return false;
  }

  getProviders(capability: string): string[] {
    const providers: string[] = [];
    for (const [name, meta] of this.#metadata) {
      if (meta.provides?.includes(capability)) {
        providers.push(name);
      }
    }
    return providers;
  }

  async cleanup(): Promise<void> {
    this.#core.hooks.notifyHooks(HOOKS.SHUTDOWN_CLEANUP, null);
  }
}

export function createExtensionLoader(core: LoaderCore): ExtensionLoader {
  return new ExtensionLoader(core);
}

export function validateServiceContracts(
  loadedExtensions: ExtensionMetadata[],
  serviceRegistry: {
    has(name: string): boolean;
    checkContract(
      name: string,
      methods: string[],
    ): { valid: boolean; missing: string[] };
  },
): Array<{
  extension: string;
  service: string;
  missing: string[];
  message: string;
}> {
  const errors: Array<{
    extension: string;
    service: string;
    missing: string[];
    message: string;
  }> = [];

  for (const ext of loadedExtensions) {
    if (!ext.requires || typeof ext.requires !== "object") continue;

    for (const [serviceName, expectedMethods] of Object.entries(ext.requires)) {
      if (!Array.isArray(expectedMethods)) continue;

      if (!serviceRegistry.has(serviceName)) {
        errors.push({
          extension: ext.name,
          service: serviceName,
          missing: expectedMethods as string[],
          message: `Extension "${ext.name}" requires service "${serviceName}" but no provider registered it.`,
        });
        continue;
      }

      const { valid, missing } = serviceRegistry.checkContract(
        serviceName,
        expectedMethods as string[],
      );
      if (!valid) {
        errors.push({
          extension: ext.name,
          service: serviceName,
          missing,
          message:
            `Extension "${ext.name}" requires service "${serviceName}" with methods [${expectedMethods.join(", ")}], ` +
            `but registered implementation is missing: [${missing.join(", ")}].`,
        });
      }
    }
  }

  return errors;
}
