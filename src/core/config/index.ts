// Unified config module — single entry point for all configuration.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";
import { ConfigError } from "../error.ts";
import { deepMerge } from "../../utils/objects.js";
import { render } from "../../utils/render.js";
import { validate as validateSchema } from "../../utils/json-schema.js";
import { camelCase } from "../../utils/strings.js";

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
  DEFAULT_MODEL,
  DEFAULT_PROFILES_SUBPATH,
  DEFAULT_PROFILES_PATH,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_THINKER,
  DEFAULT_TOOL_FMT,
  DEFAULT_TOOL_OUTPUT_FMT,
  DEFAULT_SKILLS_PATH,
  DEFAULT_PROMPTS_PATH,
  DEFAULT_CHAT_TIMEOUT_SECS,
  DEFAULT_EMBEDDINGS_TIMEOUT_SECS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TASK_PROFILE,
  DEFAULT_TASK_ROLE,
  DEFAULT_EXIT_COMMANDS,
  DEFAULT_AI_URL,
  DEFAULT_HIDE_TOOLS,
  DEFAULT_HIDE_THINKING,
  DEFAULT_SHOW_TOKEN_USE,
  DEFAULT_SUBCOMMAND,
  DEFAULT_NO_LOG,
  DEFAULT_COMPACT_DEBUG,
  DEFAULT_HOOK_TRACE,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "./defaults.ts";
import { CONFIG_SCHEMA } from "./schema-loader.ts";
import {
  resolveAll,
  resolveKey,
  resolveModel,
  resolveModelWithProvider,
} from "./schema-loader.ts";
import { loadProfileFiles, allProfilesForSwitch } from "./profiles.ts";
import { buildModelRegistry, initSystemPromptTemplate } from "./providers.ts";

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
  extParams: Array<{ key: string; defaults: unknown }>,
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
      merged[param.key] = deepMerge(merged[param.key] as object, param.defaults as object);
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
  if (Array.isArray(obj)) return obj.map(normalizeConfigKeys);

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
  skillsPath: string;
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
  mcpServers: unknown[];
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
    aiUrl: DEFAULT_AI_URL,
    apiKey: null,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: null,
    defaultSubcommand: DEFAULT_SUBCOMMAND,
    temperature: null,
    thinker: DEFAULT_THINKER,
    toolfmt: DEFAULT_TOOL_FMT,
    toolOutputFmt: DEFAULT_TOOL_OUTPUT_FMT,
    role: null,
    hideTools: DEFAULT_HIDE_TOOLS,
    hideThinking: DEFAULT_HIDE_THINKING,
    showTokenUse: DEFAULT_SHOW_TOKEN_USE,
    skillsPath: DEFAULT_SKILLS_PATH,
    profilesPath: DEFAULT_PROFILES_PATH,
    chatTimeoutSecs: DEFAULT_CHAT_TIMEOUT_SECS,
    embeddingsTimeoutSecs: DEFAULT_EMBEDDINGS_TIMEOUT_SECS,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxRetries: DEFAULT_MAX_RETRIES,
    taskProfile: DEFAULT_TASK_PROFILE,
    exitCommands: DEFAULT_EXIT_COMMANDS,
    noLog: DEFAULT_NO_LOG,
    compactDebug: DEFAULT_COMPACT_DEBUG,
    hookTrace: DEFAULT_HOOK_TRACE,
    mcpServers: [],
  };

  return mergeExtensionConfigDefaults(baseConfig, extParams) as DefaultConfig;
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

  try {
    const content = await fsPromises.readFile(configPathToUse, "utf-8");
    const raw = JSON.parse(content);
    return deepMerge(getDefaultConfig(extParams), normalizeConfigKeys(raw) as object) as DefaultConfig;
  } catch (e) {
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
  config: Record<string, unknown>,
  extensionSchemas?: Array<{ key: string; schema: unknown }>,
): ValidationResult {
  const errors: string[] = [];

  for (const [keyName, schemaKey] of Object.entries(CONFIG_SCHEMA)) {
    const value = config[keyName];
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
      const value = config[key];
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
 * Build the complete resolved configuration from CLI args.
 */
export async function buildConfig(cliArgv: CliArgv) {
  const configDir = resolveConfigDir(cliArgv.configDir);

  const config = await loadConfig(cliArgv.config, cliArgv.configDir);

  const resolved = await buildAgentConfig({
    cli: cliArgv,
    config,
    configDir,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    profilesPath: cliArgv.profilesPath
      ? cliArgv.profilesPath
      : path.join(configDir, DEFAULT_PROFILES_SUBPATH),
  });

  const modelRegistry = buildModelRegistry(
    { providers: config.providers || [] },
    resolved.maxTokens as number,
  );
  resolved.modelRegistry = modelRegistry;

  return { resolved, modelRegistry, providers: config.providers || [] };
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
}) {
  const {
    cli,
    config,
    configDir,
    providers = [],
    defaultModel = DEFAULT_MODEL,
    profilesPath: givenProfilesPath,
  } = options;

  let context: Record<string, unknown> = {
    cli,
    config,
    configDir,
  };

  const profileName = resolveKey(
    "profileName",
    CONFIG_SCHEMA.profileName,
    context as Record<string, unknown>,
  ) as string;
  const profilesPath =
    givenProfilesPath ||
    (resolveKey("profilesPath", CONFIG_SCHEMA.profilesPath, context as Record<string, unknown>) as string);

  const profileFiles = await loadProfileFiles(profilesPath);
  const configProfile =
    ((config.profiles as Record<string, unknown>)?.[profileName] ?? null) as Record<string, unknown> | null;
  const fileProfile = profileFiles[profileName] || null;

  const providerName = resolveKey(
    "provider",
    CONFIG_SCHEMA.provider,
    context as Record<string, unknown>,
  ) as string | undefined;
  const provider = providerName
    ? ((providers as Array<{ name: string }>).find((p) => (p as { name: string }).name === providerName) ?? null)
    : null;

  // Profile merge
  let profile: Record<string, unknown>;
  if (configProfile || fileProfile) {
    profile = { ...configProfile };
    if (fileProfile) {
      if ((fileProfile as Record<string, unknown>).role)
        profile.role = (fileProfile as Record<string, unknown>).role;
      if (
        (fileProfile as Record<string, unknown>).whitelistTools != null
      )
        profile.whitelistTools = (fileProfile as Record<string, unknown>).whitelistTools;
      if ((fileProfile as Record<string, unknown>).blacklistTools?.length)
        profile.blacklistTools = (fileProfile as Record<string, unknown>).blacklistTools;
      if ((fileProfile as Record<string, unknown>).manager)
        profile.manager = true;
    }
  } else {
    profile = {
      whitelistTools: null,
      blacklistTools: [],
      skills: [],
      manager: false,
      cwdBoundary: null,
    };
  }

  context = {
    ...context,
    provider,
    profile,
    profileName,
    profilesPath,
  };
  const resolved = resolveAll(CONFIG_SCHEMA, context as Record<string, unknown>) as Record<string, unknown>;

  const model = resolveModel(
    cli.model,
    configProfile?.model as string | null | undefined,
    config.defaultModel as string | null | undefined,
    provider as { name: string; models: Array<{ name: string }> } | undefined | null,
    defaultModel,
  );

  const profileBody = fileProfile?.body?.trim()
    ? cli.prompt
      ? (() => {
          try {
            return render(fileProfile.body as string, { ARGS: cli.prompt });
          } catch {
            return fileProfile.body as string;
          }
        })()
      : (fileProfile.body as string)
    : "";

  const systemPromptTemplate = await initSystemPromptTemplate(
    cli.systemPromptTemplate || (config.systemPromptTemplate as string),
    cli.configDir,
    resolveConfigDir,
  );

  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: (config.profiles as Record<string, unknown>) || {},
    profilesPath,
  });

  return {
    ...resolved,
    model,
    configDir,
    profile,
    profileBody,
    activeProvider: (provider as { name?: string })?.name || null,
    systemPromptTemplate,
    profiles,
    modelRegistry: {},
  };
}
