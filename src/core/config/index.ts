// Unified config module — single entry point for all configuration.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";
import { ConfigError } from "../error.ts";
import { deepMerge } from "../../utils/objects.ts";
import { render } from "../../utils/render.ts";
import { validate as validateSchema } from "../../utils/json-schema.ts";
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
} from "../../utils/json-schema.js";

// Import specific items we need locally
import {
  DEFAULT_PROFILES_SUBPATH,
  DEFAULT_PROFILES_PATH,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_PROMPTS_PATH,
} from "./defaults.ts";
import { CONFIG_SCHEMA, getLayerDefault, ResolutionContext, type CoreConfig } from "./schema-loader.ts";
import {
  resolveAll,
  resolveKey,
  resolveModel,
  resolveModelWithProvider,
} from "./schema-loader.ts";
import { loadProfileFiles, allProfilesForSwitch, ProfileDef, type SwitchProfile } from "./profiles.ts";
import {
  buildModelRegistry,
  initSystemPromptTemplate,
  ProviderDef,
  type ModelConfig,
} from "./providers.ts";

// ── Config Directory Resolution ────────────────────────────────────────

/**
 * Resolve the config directory with the following priority.
 */
export function resolveConfigDir(cliConfigDir?: string): string {
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

  return path.join(os.homedir(), ".config", "hotdog");
}

// ── Extension Config Helpers ──────────────────────────────────────────────

/**
 * Merge extension-registered config defaults into the base config.
 */
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

// ── Config Loading ─────────────────────────────────────────────────────

/**
 * Normalize config keys from snake_case to camelCase recursively.
 */
export function normalizeConfigKeys(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((item) => normalizeConfigKeys(item));

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    normalized[camelCase(key)] = normalizeConfigKeys(value);
  }
  return normalized;
}

export interface DefaultConfig {
  providers: unknown[];
  profiles: Record<string, unknown>;
  extensionPaths: string[];
  extensionAutoload: boolean;
  extensions: string[];
  profile: unknown;
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
  maxTokens: number;
  maxIterations: number;
  maxRetries: number;
  taskProfile: string | null;
  exitCommands: string[];
  noLog: boolean;
  compactDebug: boolean;
  hookTrace: boolean;
}

/**
 * Get the default configuration.
 */
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
    theme: null,
    colors: null,
    systemPromptTemplate: null,
    aiUrl: getLayerDefault(CONFIG_SCHEMA.baseUrl) as string | null,
    apiKey: null,
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
    defaultProvider: null,
    defaultSubcommand: getLayerDefault(CONFIG_SCHEMA.defaultSubcommand) as string | null,
    temperature: null,
    thinker: getLayerDefault(CONFIG_SCHEMA.thinkerFormat) as string | null,
    toolfmt: getLayerDefault(CONFIG_SCHEMA.toolFormat) as string | null,
    toolOutputFmt: getLayerDefault(CONFIG_SCHEMA.toolOutputFmt) as string | null,
    role: null,
    hideTools: getLayerDefault(CONFIG_SCHEMA.hideTools) as boolean,
    hideThinking: getLayerDefault(CONFIG_SCHEMA.hideThinking) as boolean,
    showTokenUse: getLayerDefault(CONFIG_SCHEMA.showTokenUse) as boolean,
    profilesPath: DEFAULT_PROFILES_PATH,
    chatTimeoutSecs: getLayerDefault(CONFIG_SCHEMA.chatTimeout) as number,
    embeddingsTimeoutSecs: getLayerDefault(CONFIG_SCHEMA.embeddingsTimeout) as number,
    maxTokens: getLayerDefault(CONFIG_SCHEMA.maxTokens) as number,
    maxIterations: getLayerDefault(CONFIG_SCHEMA.maxIterations) as number,
    maxRetries: getLayerDefault(CONFIG_SCHEMA.maxRetries) as number,
    taskProfile: getLayerDefault(CONFIG_SCHEMA.taskProfile) as string | null,
    exitCommands: getLayerDefault(CONFIG_SCHEMA.exitCommands) as string[],
    noLog: getLayerDefault(CONFIG_SCHEMA.noLog) as boolean,
    compactDebug: getLayerDefault(CONFIG_SCHEMA.compactDebug) as boolean,
    hookTrace: getLayerDefault(CONFIG_SCHEMA.hookTrace) as boolean,
  };

  return mergeExtensionConfigDefaults(baseConfig as Record<string, unknown>, extParams) as unknown as DefaultConfig;
}

/**
 * Load config from file, falling back to defaults if no path is given.
 */
export async function loadConfig(
  configPath?: string,
  cliConfigDir?: string,
  extParams?: Array<{ key: string; defaults: unknown }>,
): Promise<DefaultConfig> {
  let configPathToUse = configPath;
  if (!configPathToUse) {
    const configDir = resolveConfigDir(cliConfigDir);
    const configFilePath = path.join(configDir, DEFAULT_CONFIG_FILENAME);
    try {
      await fsPromises.access(configFilePath);
      configPathToUse = configFilePath;
    } catch {
      // Not found, fall through to defaults
    }
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

// ── Config Validation ───────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a loaded config object against extension schemas.
 */
export function validateConfig(
  config: CoreConfig,
  extensionSchemas?: Array<{ key: string; schema: unknown }>,
): ValidationResult {
  const errors: string[] = [];
  const configAny = config as Record<string, unknown>;

  for (const [keyName, schemaKey] of Object.entries(CONFIG_SCHEMA)) {
    const value = configAny[keyName];
    if (value === undefined || value === null) continue;

    const expectedType = schemaKey.type;
    if (expectedType === "string" && typeof value !== "string") {
      errors.push(`${keyName}: expected string, got ${typeof value}`);
    } else if (expectedType === "number" && typeof value !== "number") {
      errors.push(`${keyName}: expected number, got ${typeof value}`);
    } else if (expectedType === "boolean" && typeof value !== "boolean") {
      errors.push(`${keyName}: expected boolean, got ${typeof value}`);
    } else if (expectedType === "array" && !Array.isArray(value)) {
      errors.push(`${keyName}: expected array, got ${typeof value}`);
    }
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

/**
 * Print validation errors and exit if config is invalid.
 */
export function failOnInvalidConfig(result: ValidationResult): void {
  if (!result.valid) {
    throw ConfigError.ValidationError(result.errors);
  }
}

// ── Unified Config Builder ─────────────────────────────────────────────

export interface CliArgv {
  config?: string;
  configDir?: string;
  profilesPath?: string;
  model?: string;
  prompt?: string;
  systemPromptTemplate?: string;
  [key: string]: unknown;
}

/**
 * Extra properties added by buildAgentConfig beyond the schema-resolved keys.
 */
export interface AgentConfigExtra {
  model: string;
  configDir: string;
  profile: Record<string, unknown>;
  profileBody: string;
  activeProvider: string | null;
  systemPromptTemplate: string;
  profiles: Record<string, SwitchProfile>;
  modelRegistry: Record<string, ModelConfig>;
}

/**
 * Complete agent configuration = resolved schema keys + extra properties.
 */
export type AgentConfig = CoreConfig & AgentConfigExtra;

/**
 * Build the complete resolved configuration from CLI args.
 */
export async function buildConfig(cliArgv: CliArgv): Promise<{
  resolved: AgentConfig;
  modelRegistry: Record<string, ModelConfig>;
  providers: ProviderDef[];
}> {
  const configDir = resolveConfigDir(cliArgv.configDir);

  const config = await loadConfig(cliArgv.config, cliArgv.configDir);

  const resolved = await buildAgentConfig({
    cli: cliArgv,
    config: config as Record<string, unknown>,
    configDir,
    providers: config.providers || [],
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
    profilesPath: cliArgv.profilesPath
      ? cliArgv.profilesPath
      : path.join(configDir, DEFAULT_PROFILES_SUBPATH),
  });

  const modelRegistry = buildModelRegistry(
    { providers: (config.providers || []) as unknown as ProviderDef[] },
    resolved.maxTokens as number,
  );
  resolved.modelRegistry = modelRegistry;

  return { resolved, modelRegistry, providers: (config.providers || []) as ProviderDef[] };
}

/**
 * Build a complete resolved configuration for the agent.
 */
export async function buildAgentConfig(options: {
  cli: CliArgv;
  config: Record<string, unknown>;
  configDir: string;
  providers?: unknown[];
  defaultModel?: string;
  profilesPath?: string;
}): Promise<AgentConfig> {
  const {
    cli,
    config,
    configDir,
    providers = [],
    defaultModel = getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
    profilesPath: givenProfilesPath,
  } = options;

  const context: ResolutionContext = {
    cli: cli as Record<string, unknown>,
    config: config as Record<string, unknown>,
    configDir,
  };

  const profileName = resolveKey(
    "profileName",
    CONFIG_SCHEMA.profileName,
    context,
  ) as string;
  const profilesPath =
    givenProfilesPath ||
    (resolveKey(
      "profilesPath",
      CONFIG_SCHEMA.profilesPath,
      context,
    ) as string);

  const profileFiles = await loadProfileFiles(profilesPath);
  const configProfile = (config.profiles as Record<string, unknown> | undefined)?.[profileName] ?? null;
  const fileProfile = profileFiles[profileName] || null;

  const providerName = resolveKey(
    "provider",
    CONFIG_SCHEMA.provider,
    context,
  ) as string | undefined;
  const provider = providerName
    ? (providers as Array<{ name: string }>).find(
        (p) => p.name === providerName,
      ) ?? null
    : null;

  // Profile merge
  let profile: Record<string, unknown>;
  if (configProfile || fileProfile) {
    profile = { ...(configProfile as Record<string, unknown> | null) };
    if (fileProfile) {
      const fp = fileProfile as unknown as Record<string, unknown>;
      if (fp.role) profile.role = fp.role;
      if (fp.whitelistTools != null) profile.whitelistTools = fp.whitelistTools;
      if (Array.isArray(fp.blacklistTools) && (fp.blacklistTools as unknown[]).length)
        profile.blacklistTools = fp.blacklistTools;
      if (fp.manager) profile.manager = true;
    }
  } else {
    profile = {
      whitelistTools: null,
      blacklistTools: [],
      manager: false,
      cwdBoundary: null,
    };
  }

  const resolvedContext: ResolutionContext = {
    ...context,
    provider: provider as Record<string, unknown> | null,
    profile,
    profileName,
    profilesPath,
  };
  const resolved = resolveAll(
    CONFIG_SCHEMA,
    resolvedContext,
  );

  const model = resolveModel(
    cli.model,
    (configProfile as { model?: string } | null)?.model,
    config.defaultModel as string | null | undefined,
    provider as { name: string; models: Array<{ name: string }> } | undefined | null,
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
    cli.systemPromptTemplate || config.systemPromptTemplate as string | undefined,
    cli.configDir,
    resolveConfigDir,
  );

  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: config.profiles as Record<string, Partial<ProfileDef>> | undefined || {},
    profilesPath,
  });

  return {
    ...resolved,
    model,
    configDir,
    profile,
    profileBody,
    activeProvider: (provider as { name?: string } | null)?.name || null,
    systemPromptTemplate,
    profiles,
    modelRegistry: {},
  } as AgentConfig;
}
