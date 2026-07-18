/**
 * Schema loader — reads core.config.json and builds the unified config schema.
 */
import { join } from "node:path";
import { getNested } from "../../utils/objects.ts";
import { parseAs } from "../../utils/json-schema.ts";
import configSchema from "../core.config.json" with { type: "json" };

export type CastFn = (v: unknown, ctx?: unknown) => unknown;
export type ComputeFn = (ctx: unknown) => unknown;

export interface SchemaLayer {
  source?: string;
  key?: string;
  path?: string;
  default?: unknown;
  cast?: CastFn | string | null;
  compute?: string;
}

export interface SchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  layers?: SchemaLayer[];
  properties?: Record<string, SchemaProperty>;
  cliFlag?: {
    short?: string;
    long: string;
    type?: string;
    description?: string;
  };
}

export type ConfigSchema = Record<string, SchemaProperty>;

/**
 * Map of named cast strings to their function implementations.
 */
const CAST_BUILTINS: Record<string, CastFn> = {
  truthy: (v: unknown): boolean | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v !== "string") return undefined;
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "on" || s === "1") return true;
    if (s === "false" || s === "off" || s === "0") return false;
    return undefined;
  },

  falsy: (v: unknown): boolean | undefined => {
    const result = CAST_BUILTINS.truthy!(v);
    if (result === undefined) return undefined;
    return !result;
  },

  number: (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v.trim());
      if (!isNaN(n)) return n;
    }
    return undefined;
  },

  string: (v: unknown): string | undefined => {
    if (typeof v === "string") {
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
  },

  any: (v: unknown): unknown => v,

  array: (v: unknown): unknown[] | undefined =>
    Array.isArray(v) ? v : undefined,
};

/**
 * Map of compute function names to their implementations.
 */
const COMPUTE_BUILTINS: Record<
  string,
  (arg: unknown, ctx: unknown) => unknown
> = {
  joinConfigDir: (arg: unknown, ctx: unknown): string => {
    const subPath = arg as string;
    const configDir = (ctx as { configDir?: string }).configDir;
    if (configDir) {
      return join(configDir, subPath);
    }
    const fallbacks: Record<string, string> = {
      skills: "/skills",
      prompts: "./config/prompts",
      profiles: "./config/profiles",
    };
    return fallbacks[subPath] || join("./config", subPath);
  },
};

/**
 * Parse a cast string and return a function.
 */
export function resolveCast(cast: unknown): CastFn | null {
  if (typeof cast === "function") return cast as CastFn;
  if (typeof cast !== "string") return null;

  const builtin = CAST_BUILTINS[cast];
  return builtin || null;
}

/**
 * Parse a compute string and return a function.
 */
export function resolveCompute(compute: unknown): ComputeFn | null {
  if (typeof compute !== "string") return null;

  let name: string | undefined;
  let arg: string | undefined;

  // Try name('arg') form first
  const parenMatch = compute.match(/^(\w+)\('(.*)'\)$/);
  if (parenMatch) {
    [, name, arg] = parenMatch;
  } else {
    // Try name:arg form
    const colonMatch = compute.match(/^(\w+):(.+)$/);
    if (colonMatch) {
      [, name, arg] = colonMatch;
    }
  }

  if (name && arg !== undefined) {
    const fn = COMPUTE_BUILTINS[name];
    if (fn) {
      try {
        const parsed = JSON.parse(arg);
        return (ctx) => fn(parsed, ctx);
      } catch {
        return (ctx) => fn(arg, ctx);
      }
    }
  }

  return null;
}

/**
 * Load the core config schema from core.config.json.
 */
export function loadCoreSchema(): unknown {
  return configSchema;
}

/**
 * Compile layers within a property definition.
 *
 * @private
 */
function compilePropertyLayers(rawProp: SchemaProperty): SchemaProperty {
  if (!rawProp.layers) return rawProp;

  const compiledLayers = rawProp.layers.map((layer) => {
    const compiled = { ...layer };

    if (typeof compiled.cast === "string") {
      compiled.cast = resolveCast(compiled.cast);
    }

    if (compiled.compute) {
      const computeFn = resolveCompute(compiled.compute);
      if (computeFn) {
        compiled.default = computeFn;
        delete compiled.compute;
      }
    }

    return compiled;
  });

  return { ...rawProp, layers: compiledLayers };
}

/**
 * Recursively compile layers within nested properties.
 *
 * @private
 */
function compileNestedPropertyLayers(
  properties: Record<string, SchemaProperty>,
): Record<string, SchemaProperty> {
  if (!properties || typeof properties !== "object") return properties;

  const compiled: Record<string, SchemaProperty> = {};
  for (const [propName, prop] of Object.entries(properties)) {
    compiled[propName] = compilePropertyLayers(prop);

    if (prop.type === "object" && prop.properties) {
      compiled[propName].properties = compileNestedPropertyLayers(
        prop.properties,
      );
    }
  }
  return compiled;
}

/**
 * Convert a raw JSON schema entry to a runtime-ready schema entry.
 */
export function compileSchemaKey(rawKey: SchemaProperty): SchemaProperty {
  const { layers, properties, ...rest } = rawKey;

  const compiledLayers = (layers || []).map((layer) => {
    const compiled = { ...layer };

    if (typeof compiled.cast === "string") {
      compiled.cast = resolveCast(compiled.cast);
    }

    if (compiled.compute) {
      const computeFn = resolveCompute(compiled.compute);
      if (computeFn) {
        compiled.default = computeFn;
        delete compiled.compute;
      }
    }

    return compiled;
  });

  const compiledProperties = compileNestedPropertyLayers(properties || {});

  return {
    ...rest,
    layers: compiledLayers,
    ...(compiledProperties ? { properties: compiledProperties } : {}),
  };
}

/**
 * Build the full CONFIG_SCHEMA from the JSON file.
 */
export function buildConfigSchema(): ConfigSchema {
  const rawKeys = loadCoreSchema() as Record<string, SchemaProperty>;
  const schema: ConfigSchema = {};

  for (const [keyName, rawKey] of Object.entries(rawKeys)) {
    schema[keyName] = compileSchemaKey(rawKey);
  }

  return schema;
}

/**
 * Extract the default value from a schema key's layers.
 */
export function getLayerDefault(schemaKey: SchemaProperty | undefined | null): unknown {
  if (!schemaKey || !schemaKey.layers) return undefined;

  for (const layer of schemaKey.layers) {
    if ("default" in layer) {
      return layer.default;
    }
  }
  return undefined;
}

/**
 * Load extension schemas and merge them into the unified schema.
 */
export function loadExtensionSchemas(
  extensions: Array<{ configSchema?: unknown }>,
): ConfigSchema {
  const extensionKeys: ConfigSchema = {};

  for (const ext of extensions) {
    if (!ext.configSchema || typeof ext.configSchema !== "object") continue;

    for (const [keyName, keySchema] of Object.entries(
      ext.configSchema as Record<string, SchemaProperty>,
    )) {
      if (keySchema.layers) {
        extensionKeys[keyName] = compileSchemaKey({
          type: keySchema.type,
          layers: keySchema.layers,
          ...(keySchema.properties ? { properties: keySchema.properties } : {}),
        });
      }
    }
  }

  return extensionKeys;
}

/**
 * Build a unified schema combining core and extension schemas.
 */
export function buildUnifiedSchema(
  extensions?: Array<{ configSchema?: unknown }>,
): ConfigSchema {
  const coreSchema = buildConfigSchema();
  const extensionSchema = extensions ? loadExtensionSchemas(extensions) : {};

  return { ...coreSchema, ...extensionSchema };
}

export interface CliFlagDef {
  key: string;
  short: string | null;
  long: string;
  type: string;
  hasValue: boolean;
  description: string;
}

/**
 * Generate CLI flag definitions from the schema.
 */
export function cliFlagsFromSchema(schema: ConfigSchema): CliFlagDef[] {
  const flags: CliFlagDef[] = [];
  for (const [key, def] of Object.entries(schema)) {
    if (def.cliFlag) {
      flags.push({
        key,
        short: def.cliFlag.short || null,
        long: def.cliFlag.long,
        type: def.cliFlag.type || def.type || "string",
        hasValue: def.cliFlag.type !== "boolean",
        description: def.cliFlag.description || "",
      });
    }
  }
  return flags;
}

export interface ResolutionContext {
  cli?: Record<string, unknown>;
  config?: Record<string, unknown>;
  provider?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  configDir?: string;
  [key: string]: unknown;
}

/**
 * Resolve the raw value for a single layer from the context.
 */
export function resolveLayerValue(
  layer: SchemaLayer,
  context: ResolutionContext,
): unknown {
  if ("default" in layer) {
    return typeof layer.default === "function"
      ? (layer.default as ComputeFn)(context)
      : layer.default;
  }

  switch (layer.source) {
    case "cli":
      return context.cli?.[layer.key as string];
    case "config":
      return getNested(context.config, layer.key as string);
    case "env":
      return process.env[layer.key as string];
    case "provider":
      return getNested(
        context.provider as Record<string, unknown>,
        layer.path as string,
      );
    case "providerDefault":
      if (
        context.provider &&
        Array.isArray((context.provider as Record<string, unknown>).models)
      ) {
        const models = (context.provider as Record<string, unknown>).models as Array<Record<string, unknown>>;
        if (models.length > 0 && models[0]?.name) {
          return models[0].name;
        }
      }
      return undefined;
    case "profile":
      return getNested(
        context.profile as Record<string, unknown>,
        (layer.key || layer.path) as string,
      );
    default:
      return undefined;
  }
}

/**
 * Resolve nested properties that have their own layers.
 *
 * @private
 */
function resolveNestedProperties(
  parentKey: string,
  parentValue: Record<string, unknown>,
  properties: Record<string, SchemaProperty>,
  context: ResolutionContext,
): Record<string, unknown> | unknown[] {
  if (!properties || typeof parentValue !== "object" || parentValue === null) {
    return parentValue;
  }

  // Don't spread arrays — preserve them as-is
  const result = Array.isArray(parentValue)
    ? [...parentValue]
    : { ...parentValue };

  for (const [propName, propSchema] of Object.entries(properties)) {
    const fullKey = `${parentKey}.${propName}`;

    if (propSchema.layers) {
      const propContext: ResolutionContext = {
        ...context,
        config: context.config || {},
      };

      const propValue = resolveKey(
        fullKey,
        { ...propSchema, layers: propSchema.layers },
        propContext,
      );

      if (propValue !== undefined) {
        (result as Record<string, unknown>)[propName] = propValue;
      }
    } else if (propSchema.default !== undefined && !(propName in result)) {
      (result as Record<string, unknown>)[propName] = propSchema.default;
    }
  }

  return result;
}

/**
 * Resolve a single config key by walking its declared layers.
 */
export function resolveKey(
  keyName: string,
  schema: SchemaProperty | undefined,
  context: ResolutionContext,
): unknown {
  if (!schema) return undefined;
  const { layers, properties } = schema;

  for (const layer of (layers ?? [])) {
    if ("default" in layer) {
      const value = resolveLayerValue(layer, context);
      if (properties && typeof value === "object" && value !== null) {
        return resolveNestedProperties(
          keyName,
          value as Record<string, unknown>,
          properties,
          context,
        );
      }
      return value;
    }

    const value = resolveLayerValue(layer, context);

    if (value === undefined || value === null || value === "") continue;

    let resolved: unknown;
    if (layer.cast && typeof layer.cast === "function") {
      const casted = layer.cast(value, context);
      if (casted === undefined) continue;
      resolved = casted;
    } else {
      resolved = value;
    }

    if (properties && typeof resolved === "object" && resolved !== null) {
      return resolveNestedProperties(
        keyName,
        resolved as Record<string, unknown>,
        properties,
        context,
      );
    }
    return resolved;
  }

  return undefined;
}

/**
 * The resolved shape of the core schema keys.
 * Provides compile-time type checking for commonly used config keys.
 * Extension-specific config keys are not included — access them via
 * Record<string, unknown> or a generic parameter.
 *
 * This is a manually defined interface matching the core.config.json schema.
 */
export interface CoreConfig {
  baseUrl?: string;
  apiKey?: string;
  thinkerFormat?: string;
  toolFormat?: string;
  toolOutputFmt?: string;
  chatTimeout?: number;
  embeddingsTimeout?: number;
  sessionId?: string;
  compactDebug?: boolean;
  noLog?: boolean;
  showTokenUse?: boolean;
  stream?: boolean;
  hideTools?: boolean;
  hideThinking?: boolean;
  useColors?: boolean;
  theme?: string;
  role?: string;
  aspects?: unknown[];
  defaultModel?: string;
  maxIterations?: number;
  maxRetries?: number;
  prompt?: string;
  exitCommands?: string[];
  taskProfile?: string;
  coreTools?: Record<string, unknown>;
  compaction?: Record<string, unknown>;
  hookTrace?: boolean;
  profileName?: string;
  /** Resolved profile object (includes manager flag, whitelistTools, etc.). Not from schema — set at runtime. */
  profile?: Record<string, unknown>;
  profilesPath?: string;
  provider?: string;
  systemPromptTemplate?: string;
  profiles?: Record<string, unknown>;
  extensionPaths?: string[];
  extensionAutoload?: boolean;
  extensions?: string[];
  defaultSubcommand?: string;
  temperature?: number;
  defaultProvider?: string;
  defaultAiUrl?: string;
  taskDefaultRole?: string;
  systemPromptDefaultTemplate?: string;
  // Allow access to extension-specific config keys
  [key: string]: unknown;
}

/**
 * Resolve all config keys from a schema against a context.
 * Returns a typed CoreConfig — known keys have their declared types,
 * extension keys fall through to the index signature (unknown).
 */
export function resolveAll(
  schema: ConfigSchema,
  context: ResolutionContext,
): CoreConfig {
  const result: Record<string, unknown> = {};

  for (const [keyName, keySchema] of Object.entries(schema)) {
    result[keyName] = resolveKey(keyName, keySchema, context);
  }

  return parseAs<CoreConfig>(result);
}

export interface ExtensionConfigParam {
  key: string;
  defaults?: unknown;
  schema?: SchemaProperty;
  layers?: SchemaLayer[];
}

/**
 * Resolve extension config keys using their registered schemas.
 */
export function resolveExtensionConfig(
  extParams: ExtensionConfigParam[],
  context: ResolutionContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const param of extParams) {
    if (!param.layers) continue;

    const schemaEntry = compileSchemaKey({
      type: param.schema?.type || "object",
      layers: param.layers,
      properties: param.schema?.properties,
    });

    const resolved = resolveKey(param.key, schemaEntry, context);
    if (resolved !== undefined) {
      result[param.key] = resolved;
    }
  }

  return result;
}

/**
 * Resolve a model name to provider/model format.
 */
export function resolveModelWithProvider(
  name: string,
  provider?: ProviderDef | null,
): string {
  if (!name) return name;
  if (name.includes("/")) return name;
  if (provider?.models) {
    const match = provider.models.find((m) => m.name === name);
    if (match) return `${provider.name}/${name}`;
  }
  return name;
}

interface ProviderDef {
  name: string;
  models: Array<{ name: string }>;
}

/**
 * Resolve model name with priority: profile → CLI → provider default → config → default.
 */
export function resolveModel(
  cliModel: string | undefined,
  profileModel: string | null | undefined,
  configModel: string | null | undefined,
  provider: ProviderDef | undefined | null,
  defaultModel: string,
): string {
  if (profileModel) return resolveModelWithProvider(profileModel, provider);
  if (cliModel) return resolveModelWithProvider(cliModel, provider);
  if (provider?.models?.length)
    return resolveModelWithProvider(provider.models[0]!.name, provider);
  if (configModel) return resolveModelWithProvider(configModel, provider);
  return defaultModel;
}

/**
 * The CONFIG_SCHEMA object — derived from core.config.json.
 */
export const CONFIG_SCHEMA: ConfigSchema = buildConfigSchema();
