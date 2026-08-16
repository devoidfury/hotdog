import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";
import { ConfigError } from "../error.ts";
import { deepMerge } from "../../utils/objects.ts";
import { render } from "../../utils/render.ts";
import { validate as validateSchema, castAs } from "../../utils/json-schema.ts";
import { camelCase } from "../../utils/strings.ts";

export * from "./defaults.ts";
export * from "./schema-loader.ts";
export * from "./profiles.ts";
export * from "./providers.ts";

// Validation re-export
export {
  validate,
  validateParams,
  formatValidationErrors,
} from "../../utils/json-schema.ts";

// Import specific items we need locally
import { DEFAULT_CONFIG_FILENAME } from "./defaults.ts";
import {
  CONFIG_SCHEMA,
  getLayerDefault,
  ResolutionContext,
  type CoreConfigWithExtensions,
} from "./schema-loader.ts";
import { resolveAll, resolveKey, resolveModel } from "./schema-loader.ts";
import {
  ProfileManager,
  type ProfileDef,
  type SwitchProfile,
} from "./profiles.ts";
import {
  buildModelRegistry,
  initSystemPromptTemplate,
  ProviderDef,
  type ModelConfig,
} from "./providers.ts";

export function resolveConfigDir(cliConfigDir?: string | null): string {
  if (cliConfigDir) {
    return path.resolve(cliConfigDir);
  }

  const envConfigDir = process.env.HOTDOG_CONFIG_DIR;
  if (envConfigDir) {
    return path.resolve(envConfigDir);
  }

  const cwdConfig = path.resolve(cwd(), "config");
  try {
    fs.accessSync(cwdConfig);
    return cwdConfig;
  } catch {
    // Not a directory or doesn't exist
  }

  const etcConfig = "/etc/hotdog";
  try {
    fs.accessSync(etcConfig);
    return etcConfig;
  } catch {
    // Not found
  }

  // XDG-style directory fallback
  return path.join(os.homedir(), ".config", "hotdog");
}

export function mergeExtensionConfigDefaults(
  defaultConfig: Record<string, unknown>,
  extParams: Array<{ key: string; defaults: unknown }> | null | undefined,
): Record<string, unknown> {
  if (!extParams || extParams.length === 0) {
    return defaultConfig;
  }

  const merged = { ...defaultConfig };

  for (const param of extParams) {
    if (merged[param.key] === undefined) {
      merged[param.key] = param.defaults;
    } else if (
      typeof merged[param.key] === "object" &&
      merged[param.key] !== null &&
      typeof param.defaults === "object" &&
      param.defaults !== null
    ) {
      merged[param.key] = deepMerge(
        merged[param.key] as object,
        param.defaults as object,
      );
    }
  }

  return merged;
}

export function normalizeConfigKeys(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((item) => normalizeConfigKeys(item));

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    normalized[camelCase(key)] = normalizeConfigKeys(value);
  }
  return normalized;
}

export interface DefaultConfig extends Record<string, unknown> {
  providers: ProviderDef[] | null;
  profiles: Record<string, ProfileDef>;
  extensionPaths: string[];
  extensionAutoload: boolean;
  extensions: string[];
  /** Profile name from config file (--profile flag, config.profile). */
  profile?: string | null;
  /** Resolved profile object (includes manager flag, whitelistTools, etc.). */
  profileDef?: ProfileDef | null;
  profileName?: string;
  theme: string | null;
  colors: unknown;
  systemPromptTemplate: string | null;
  aiUrl: string | null;
  apiKey: string | null;
  defaultModel: string;
  defaultProvider: string | null;
  defaultSubcommand: string | null;
  temperature: number | null;
  thinker: string | null;
  toolfmt: string | null;
  toolOutputFmt: string | null;
  role: string | null;
  hideTools: boolean;
  hideThinking: boolean;
  showTokenUse: boolean;
  profilesPath: string;
  chatTimeoutSecs: number;
  embeddingsTimeoutSecs: number;
  maxIterations: number;
  maxRetries: number;
  taskProfile: string | null;
  exitCommands: string[];
  noLog: boolean;
  compactDebug: boolean;
  hookTrace: boolean;
}

export function getDefaultConfig(
  extParams?: Array<{ key: string; defaults: unknown }>,
): DefaultConfig {
  const baseConfig: DefaultConfig = {
    providers: [],
    profiles: {},
    extensionPaths: ["builtins"],
    extensionAutoload: false,
    extensions: [],
    profile: null,
    profileDef: null,
    profileName: undefined,
    theme: null,
    colors: null,
    systemPromptTemplate: null,
    aiUrl: getLayerDefault(CONFIG_SCHEMA.baseUrl) as string | null,
    apiKey: null,
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
    defaultProvider: null,
    defaultSubcommand: getLayerDefault(CONFIG_SCHEMA.defaultSubcommand) as
      string | null,
    temperature: null,
    thinker: getLayerDefault(CONFIG_SCHEMA.thinkerFormat) as string | null,
    toolfmt: getLayerDefault(CONFIG_SCHEMA.toolFormat) as string | null,
    toolOutputFmt: getLayerDefault(CONFIG_SCHEMA.toolOutputFmt) as
      string | null,
    role: null,
    hideTools: getLayerDefault(CONFIG_SCHEMA.hideTools) as boolean,
    hideThinking: getLayerDefault(CONFIG_SCHEMA.hideThinking) as boolean,
    showTokenUse: getLayerDefault(CONFIG_SCHEMA.showTokenUse) as boolean,
    profilesPath: "",
    chatTimeoutSecs: getLayerDefault(CONFIG_SCHEMA.chatTimeout) as number,
    embeddingsTimeoutSecs: getLayerDefault(
      CONFIG_SCHEMA.embeddingsTimeout,
    ) as number,
    maxIterations: getLayerDefault(CONFIG_SCHEMA.maxIterations) as number,
    maxRetries: getLayerDefault(CONFIG_SCHEMA.maxRetries) as number,
    taskProfile: getLayerDefault(CONFIG_SCHEMA.taskProfile) as string | null,
    exitCommands: getLayerDefault(CONFIG_SCHEMA.exitCommands) as string[],
    noLog: getLayerDefault(CONFIG_SCHEMA.noLog) as boolean,
    compactDebug: getLayerDefault(CONFIG_SCHEMA.compactDebug) as boolean,
    hookTrace: getLayerDefault(CONFIG_SCHEMA.hookTrace) as boolean,
  };

  return castAs<DefaultConfig>(
    mergeExtensionConfigDefaults(baseConfig, extParams),
  );
}

export async function loadConfig(
  configPath?: string | null,
  cliConfigDir?: string | null,
  extParams?: Array<{ key: string; defaults: unknown }>,
): Promise<DefaultConfig> {
  let configPathToUse = configPath;
  if (!configPathToUse) {
    const configDir = resolveConfigDir(cliConfigDir);
    const configFilePath = path.join(configDir, DEFAULT_CONFIG_FILENAME);
    try {
      await fsPromises.access(configFilePath);
      configPathToUse = configFilePath;
    } catch {}
  }

  if (!configPathToUse) {
    return getDefaultConfig(extParams);
  }

  // Validate that the path actually exists when user explicitly provided one
  if (configPath) {
    try {
      await fsPromises.access(configPathToUse);
    } catch {
      throw ConfigError.LoadFailed(
        configPathToUse,
        "Config file does not exist or is not readable",
      );
    }
  }

  try {
    const content = await fsPromises.readFile(configPathToUse, "utf-8");
    const raw = JSON.parse(content);
    return deepMerge(
      getDefaultConfig(extParams),
      normalizeConfigKeys(raw) as object,
    ) as DefaultConfig;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const err = ConfigError.LoadFailed(configPathToUse, (e as Error).message);
    err.cause = e;
    throw err;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConfig(
  config: unknown,
  extensionSchemas?: Array<{ key: string; schema: unknown }>,
): ValidationResult {
  const errors: string[] = [];
  const configAny = config as Record<string, unknown>;

  for (const [keyName, schemaKey] of Object.entries(CONFIG_SCHEMA)) {
    const value = configAny[keyName];
    if (value === undefined || value === null) continue;

    const schemaErrors = validateSchema(value, schemaKey, keyName);
    errors.push(...schemaErrors);
  }

  if (extensionSchemas) {
    for (const { key, schema } of extensionSchemas) {
      const value = configAny[key];
      if (value && schema) {
        const schemaErrors = validateSchema(value, schema, key);
        errors.push(...schemaErrors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function failOnInvalidConfig(result: ValidationResult): void {
  if (!result.valid) {
    throw ConfigError.ValidationError(result.errors);
  }
}

// Keys match config schema property names; nullable strings also accept null since the CLI parser emits null for missing values.
export interface CliArgv {
  config?: string | null;
  configDir?: string | null;
  profilesPath?: string | null;
  model?: string | null;
  prompt?: string | null;
  systemPromptTemplate?: string | null;
  [key: string]: unknown;
}

// Added by buildAgentConfig on top of the schema-resolved keys.
export interface BuildAgentConfigExtra {
  model: string;
  configDir: string;
  profile: Record<string, unknown>;
  profileBody: string;
  activeProvider: string | null;
  systemPromptTemplate: string;
  profiles: Record<string, SwitchProfile>;
  modelRegistry: Record<string, ModelConfig>;
  /** Centralized profile manager - use this instead of manual path construction. */
  profileManager: ProfileManager;
  chatTimeout: number;
  maxRetries: number;
}

// Resolved schema keys + extra properties, as returned by buildAgentConfig()/buildConfig().
// Not to be confused with Agent.AgentConfig, the runtime config the Agent class reads.
export type BuildAgentConfig = CoreConfigWithExtensions & BuildAgentConfigExtra;

export async function buildConfig(cliArgv: CliArgv): Promise<{
  resolved: BuildAgentConfig;
  modelRegistry: Record<string, ModelConfig>;
  providers: ProviderDef[];
}> {
  const configDir = resolveConfigDir(cliArgv.configDir ?? undefined);

  const config = await loadConfig(
    cliArgv.config ?? undefined,
    cliArgv.configDir ?? undefined,
  );

  const resolved = await buildAgentConfig({
    cli: cliArgv,
    config: config as CoreConfigWithExtensions,
    configDir,
    providers: config.providers || [],
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
  });

  const modelRegistry = await buildModelRegistry(
    {
      providers: castAs<ProviderDef[]>(config.providers || []),
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    },
    128000,
  );
  resolved.modelRegistry = modelRegistry;

  return {
    resolved,
    modelRegistry,
    providers: (config.providers || []) as ProviderDef[],
  };
}

export async function buildAgentConfig(options: {
  cli: CliArgv;
  config: CoreConfigWithExtensions;
  configDir: string;
  providers?: ProviderDef[];
  defaultModel?: string;
}): Promise<BuildAgentConfig> {
  const {
    cli,
    config,
    configDir,
    providers = [],
    defaultModel = getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
  } = options;

  const context: ResolutionContext = {
    cli,
    config,
    configDir,
  };

  const profileName = castAs<string>(
    resolveKey("profileName", CONFIG_SCHEMA.profileName, context),
  );
  // Resolve profilesPath through schema layers (cli -> config -> compute joinConfigDir)
  const profilesPath = castAs<string>(
    resolveKey("profilesPath", CONFIG_SCHEMA.profilesPath, context),
  );

  const profileManager = await ProfileManager.create(
    profilesPath,
    config.profiles || {},
  );
  const configProfile = config.profiles?.[profileName] ?? null;
  const fileProfile = profileManager.getFileProfiles()[profileName] || null;

  const providerName = castAs<string | undefined>(
    resolveKey("provider", CONFIG_SCHEMA.provider, context),
  );
  const provider = providerName
    ? providers.find((p) => p.name === providerName)
    : null;

  // Profile merge
  let profile: ProfileDef = {
    ...configProfile,
    ...(normalizeConfigKeys(fileProfile || {}) as ProfileDef),
  };
  const resolvedContext: ResolutionContext = {
    ...context,
    provider,
    profile,
    profileName,
    profilesPath,
  };
  const resolved = resolveAll(CONFIG_SCHEMA, resolvedContext);

  const model = resolveModel(
    cli.model ?? undefined,
    configProfile?.model,
    config.defaultModel,
    provider,
    defaultModel,
  );

  const profileBody = fileProfile?.body?.trim()
    ? cli.prompt
      ? (() => {
          try {
            return render(fileProfile.body, { ARGS: cli.prompt });
          } catch {
            return fileProfile.body;
          }
        })()
      : fileProfile.body
    : "";

  const systemPromptTemplate = await initSystemPromptTemplate(
    cli.systemPromptTemplate || config.systemPromptTemplate,
    cli.configDir ?? undefined,
    resolveConfigDir,
  );

  const profiles = profileManager.getProfilesForSwitch();

  return castAs<BuildAgentConfig>({
    ...resolved,
    profilesPath,
    model,
    configDir,
    profileDef: profile,
    profileBody,
    activeProvider: provider?.name || null,
    systemPromptTemplate,
    profiles,
    modelRegistry: {},
    profileManager,
  });
}
