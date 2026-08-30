import { join } from "node:path";
import { getNested } from "../../utils/objects.ts";
import configSchema from "../core.config.json" with { type: "json" };
import type {
  CastFn,
  ComputeFn,
  SchemaProperty,
  SchemaLayer,
  ConfigSchema,
} from "./schema-types.ts";

import type { ProviderDef } from "./providers.ts";
import { ProfileDef } from "./profiles.ts";
import { CliFlagDef } from "./index.ts";

export * from "./schema-types.ts";

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

export function resolveCast(cast: unknown): CastFn | null {
  if (typeof cast === "function") return cast as CastFn;
  if (typeof cast !== "string") return null;

  const builtin = CAST_BUILTINS[cast];
  return builtin || null;
}

export function resolveCompute(compute: unknown): ComputeFn | null {
  if (typeof compute !== "string") return null;

  let name: string | undefined;
  let arg: string | undefined;

  const parenMatch = compute.match(/^(\w+)\('(.*)'\)$/);
  if (parenMatch) {
    [, name, arg] = parenMatch;
  } else {
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

export function loadCoreSchema(): unknown {
  return configSchema;
}

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

export function buildConfigSchema(): ConfigSchema {
  const rawKeys = loadCoreSchema() as Record<string, SchemaProperty>;
  const schema: ConfigSchema = {};

  for (const [keyName, rawKey] of Object.entries(rawKeys)) {
    schema[keyName] = compileSchemaKey(rawKey);
  }

  return schema;
}

export function getLayerDefault(
  schemaKey: SchemaProperty | undefined | null,
): unknown {
  if (!schemaKey || !schemaKey.layers) return undefined;

  for (const layer of schemaKey.layers) {
    if ("default" in layer) {
      return layer.default;
    }
  }
  return undefined;
}

// Literal defaults per schema key: the first "default" layer, only when the
// value is a literal. Function/compute defaults (e.g. profilesPath) are
// skipped so those keys stay absent from the result.
export function schemaDefaults(schema: ConfigSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const [keyName, prop] of Object.entries(schema)) {
    for (const layer of prop.layers ?? []) {
      if (!("default" in layer)) continue;
      if (typeof layer.default !== "function") {
        defaults[keyName] = layer.default;
      }
      break;
    }
  }

  return defaults;
}

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

export function buildUnifiedSchema(
  extensions?: Array<{ configSchema?: unknown }>,
): ConfigSchema {
  const coreSchema = buildConfigSchema();
  const extensionSchema = extensions ? loadExtensionSchemas(extensions) : {};

  return { ...coreSchema, ...extensionSchema };
}

export function cliFlagsFromSchema(schema: ConfigSchema): CliFlagDef[] {
  const flags: CliFlagDef[] = [];
  for (const [key, def] of Object.entries(schema)) {
    if (def.cliFlag) {
      flags.push({
        key,
        short: def.cliFlag.short || undefined,
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
  provider?: ProviderDef | null;
  profile?: Partial<ProfileDef> | null;
  configDir?: string;
  profileName?: string;
  profilesPath?: string;
}

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
      return getNested(context.provider, layer.path as string);
    case "providerDefault":
      if (context.provider && Array.isArray(context.provider.models)) {
        const models = context.provider.models;
        if (models.length > 0 && models[0]?.name) {
          return models[0].name;
        }
      }
      return undefined;
    case "profile":
      return getNested(context.profile, (layer.key || layer.path) as string);
    default:
      return undefined;
  }
}

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

export function resolveKey(
  keyName: string,
  schema: SchemaProperty | undefined,
  context: ResolutionContext,
): unknown {
  if (!schema) return undefined;
  const { layers, properties } = schema;

  for (const layer of layers ?? []) {
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

// Manually mirrors core.config.json; extension keys are not included (use CoreConfigWithExtensions).
export interface CoreConfig {
  baseUrl?: string;
  apiKey?: string;
  thinkerFormat?: string;
  /** CLI display format for tool calls. */
  toolCallDisplayFormat?: string;
  /** Global default ToolFormat registry name for model-facing tool results (default "xml"). */
  modelToolFormat?: string;
  toolOutputFmt?: string;
  chatTimeout?: number;
  healthCheckTimeout?: number;
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
  defaultModel?: string;
  maxIterations?: number;
  maxRetries?: number;
  maxToolCallsPerIteration?: number;
  /** Base context window size in tokens; fallback for models without a per-model override. */
  contextLimit?: number;
  sandboxMode?: boolean;
  /** CLI override for max tool difficulty. Highest priority. */
  maxToolDifficulty?: number | null;
  /** Config-file default for max tool difficulty. Overridden by CLI and model config. */
  defaultMaxToolDifficulty?: number | null;
  prompt?: string;
  exitCommands?: string[];
  taskProfile?: string;
  coreTools?: Record<string, unknown>;
  compaction?: Record<string, unknown>;
  /** Workspace roots config: { paths: string[] } -- see expandWorkspacePaths. */
  workspace?: Record<string, unknown>;
  hookTrace?: boolean;
  /** Profile name from config file (--profile flag, config.profile). Resolved to profileName. */
  profile?: string;
  /** Resolved profile name (from schema layers). */
  profileName?: string;
  /** Resolved profile object (includes manager flag, whitelistTools, etc.). Not from schema — set at runtime. */
  profileDef?: ProfileDef;
  profilesPath?: string;
  provider?: string;
  systemPromptTemplate?: string;
  profiles?: Record<string, ProfileDef>;
  extensionPaths?: string[];
  extensionAutoload?: boolean;
  extensions?: string[];
  defaultSubcommand?: string;
  temperature?: number;
  defaultProvider?: string;
  taskDefaultRole?: string;
}

// Adds an index signature for extension-specific keys.
export type CoreConfigWithExtensions = CoreConfig & Record<string, unknown>;

export function resolveAll(
  schema: ConfigSchema,
  context: ResolutionContext,
): CoreConfigWithExtensions {
  const result: Record<string, unknown> = {};

  for (const [keyName, keySchema] of Object.entries(schema)) {
    result[keyName] = resolveKey(keyName, keySchema, context);
  }

  return result as CoreConfigWithExtensions;
}

export interface ExtensionConfigParam {
  key: string;
  defaults?: unknown;
  schema?: SchemaProperty;
  layers?: SchemaLayer[];
}

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

// Priority: profile → CLI → provider default → config → default.
// Returns null when nothing in the chain supplies a model; agent
// construction is where that becomes a hard error (model-free subcommands
// like `profiles` and `sessions` must keep working without one).
export function resolveModel(
  cliModel: string | undefined,
  profileModel: string | null | undefined,
  configModel: string | null | undefined,
  provider: ProviderDef | undefined | null,
  defaultModel: string | null,
): string | null {
  if (profileModel) return resolveModelWithProvider(profileModel, provider);
  if (cliModel) return resolveModelWithProvider(cliModel, provider);
  if (provider?.models?.length)
    return resolveModelWithProvider(provider.models[0]!.name, provider);
  if (configModel) return resolveModelWithProvider(configModel, provider);
  return defaultModel;
}

export const CONFIG_SCHEMA: ConfigSchema = buildConfigSchema();
