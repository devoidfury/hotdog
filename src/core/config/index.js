// Unified config module — single entry point for all configuration.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";
import { ConfigError } from "../error.js";

import { logger } from "../logger.js";
import { parseFrontMatter } from "../../utils/file-utils.js";
import { deepMerge } from "../../utils/objects.js";
import { render } from "../../utils/render.js";
import { validate as validateSchema } from "../../utils/json-schema.js";

export * from "./defaults.js";
export * from "./schema-loader.js";
export * from "./profiles.js";
export * from "./providers.js";

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
} from "./defaults.js";
import { CONFIG_SCHEMA } from "./schema-loader.js";
import {
  resolveAll,
  resolveKey,
  resolveModel,
  resolveModelWithProvider,
} from "./schema-loader.js";
import { loadProfileFiles, allProfilesForSwitch } from "./profiles.js";
import { buildModelRegistry, initSystemPromptTemplate } from "./providers.js";
import { camelCase } from "../../utils/strings.js";

// ── Config Directory Resolution ────────────────────────────────────────

/**
 * Resolve the config directory with the following priority:
 * 1. CLI argument (--config-dir)
 * 2. OA_AGENT_CONFIG_DIR environment variable
 * 3. ./config (CWD-relative)
 * 4. /etc/oa-agent
 * 5. ~/.config/oa-agent (XDG)
 *
 * @param {string} [cliConfigDir] - Config directory from CLI --config-dir flag.
 * @returns {string} Resolved absolute config directory path.
 */
export function resolveConfigDir(cliConfigDir) {
  if (cliConfigDir) {
    return path.resolve(cliConfigDir);
  }

  const envConfigDir = process.env.OA_AGENT_CONFIG_DIR;
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

  const etcConfig = "/etc/oa-agent";
  try {
    fs.accessSync(etcConfig);
    return etcConfig;
  } catch {
    // Not found
  }

  return path.join(os.homedir(), ".config", "oa-agent");
}

// ── Extension Config Helpers ──────────────────────────────────────────────

/**
 * Merge extension-registered config defaults into the base config.
 *
 * @param {Object} defaultConfig - The default config object.
 * @param {Array<{key: string, defaults: Object}>} extParams - Extension config params.
 * @returns {Object} Merged config.
 */
export function mergeExtensionConfigDefaults(defaultConfig, extParams) {
  if (!extParams || extParams.length === 0) {
    return defaultConfig;
  }

  const merged = { ...defaultConfig };

  for (const param of extParams) {
    if (merged[param.key] === undefined) {
      merged[param.key] = { ...param.defaults };
    } else if (
      typeof merged[param.key] === "object" &&
      merged[param.key] !== null
    ) {
      // Deep merge with extension defaults
      merged[param.key] = deepMerge(merged[param.key], param.defaults);
    }
  }

  return merged;
}

// ── Config Loading ─────────────────────────────────────────────────────

/**
 * Normalize config keys from snake_case to camelCase.
 * Handles nested objects like profiles and mcp_servers.
 *
 * @param {any} obj - The object to normalize.
 * @returns {any} The normalized object with camelCase keys.
 */
export function normalizeConfigKeys(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeConfigKeys);

  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    normalized[camelCase(key)] = normalizeConfigKeys(value);
  }
  return normalized;
}

/**
 * Get the default configuration.
 *
 * @param {Array<{key: string, defaults: Object}>} [extParams] - Extension config params to merge.
 * @returns {Object} Default config object.
 */
export function getDefaultConfig(extParams) {
  const baseConfig = {
    providers: [],
    defaultProvider: null,
    aiUrl: null,
    defaultModel: DEFAULT_MODEL,
    temperature: null,
    thinker: DEFAULT_THINKER,
    toolfmt: DEFAULT_TOOL_FMT,
    toolOutputFmt: DEFAULT_TOOL_OUTPUT_FMT,
    // Note: role is intentionally NOT set here. It's resolved from:
    // CLI --role > config file role > profile file role fallback
    // Setting a default here would override profile file roles.
    role: null,
    hideTools: true,
    hideThinking: false,
    skillsPath: DEFAULT_SKILLS_PATH,
    profilesPath: DEFAULT_PROFILES_PATH,
    promptsPath: DEFAULT_PROMPTS_PATH,
    systemPromptTemplate: null,
    chatTimeoutSecs: DEFAULT_CHAT_TIMEOUT_SECS,
    embeddingsTimeoutSecs: DEFAULT_EMBEDDINGS_TIMEOUT_SECS,
    // Extension settings
    extensionPaths: ["builtins"],
    extensionAutoload: false,
    extensions: [],
    profile: null,
    profiles: {},
    theme: null,
    colors: null, // ColorPalette object — see colors.js ColorPalette
    apiKey: null,
    noLog: false,
    compactDebug: false,
    mcpServers: [],
    showTokenUse: true,
    defaultSubcommand: "cli",
  };

  return mergeExtensionConfigDefaults(baseConfig, extParams);
}

/**
 * Load config from file, falling back to defaults if no path is given.
 *
 * Resolution order:
 * 1. If `configPath` is explicitly provided via CLI, load that file (exit on error).
 * 2. Otherwise, resolve the config directory and look for defaults.json there.
 *    Config dir resolution: CLI --config-dir > ./config > env > /etc/oa-agent > XDG
 *    Silently fall through to defaults if none exist.
 * 3. Return defaults as the final fallback.
 *
 * @param {string} [configPath] - Path to config file.
 * @param {string} [cliConfigDir] - Config directory from CLI --config-dir flag.
 * @param {Array<{key: string, defaults: Object}>} [extParams] - Extension config params to merge.
 * @returns {Promise<Object>} Resolved config object.
 */
export async function loadConfig(configPath, cliConfigDir, extParams) {
  // Resolve config path: if relative, keep as-is (CWD-relative);
  // if absolute, use directly.
  let configPathToUse = configPath;
  if (!configPathToUse) {
    // Resolve the config directory and look for defaults.json
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
    // Normalize snake_case keys from config to camelCase
    return deepMerge(getDefaultConfig(extParams), normalizeConfigKeys(raw));
  } catch (e) {
    const err = ConfigError.LoadFailed(configPathToUse, e.message);
    err.cause = e;
    throw err;
  }
}

// ── Config Validation ───────────────────────────────────────────────────

/**
 * Validate a loaded config object against extension schemas.
 * Uses the json-schema.js validator for type/enum/required checks.
 *
 * @param {object} config - The loaded config object.
 * @param {Array<object>} [extensionSchemas] - Array of {key, schema} from extensions.
 * @returns {{valid: boolean, errors: string[]}} Validation result.
 */
export function validateConfig(config, extensionSchemas) {
  const errors = [];

  // Validate core config types from schema
  for (const [keyName, schemaKey] of Object.entries(CONFIG_SCHEMA)) {
    const value = config[keyName];
    if (value === undefined || value === null) continue;

    // Basic type checking
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

  // Validate extension configs against their schemas
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
 *
 * @param {{valid: boolean, errors: string[]}} result - Validation result.
 */
export function failOnInvalidConfig(result) {
  if (!result.valid) {
    throw ConfigError.ValidationError(result.errors);
  }
}

// ── Unified Config Builder ─────────────────────────────────────────────

/**
 * Build the complete resolved configuration from CLI args.
 *
 * This is the single entry point for configuration resolution.
 * It loads the config file, resolves all values (CLI → config → env → default),
 * and returns a single flattened object with everything needed.
 *
 * Usage:
 *   const config = await buildConfig(cliArgv);
 *   // config is a fully resolved object — no separate raw/resolved split
 *
 * @param {object} cliArgv - Parsed CLI arguments (from cli.js parseArgs)
 * @returns {Promise<object>} Complete resolved configuration
 */
export async function buildConfig(cliArgv) {
  const configDir = resolveConfigDir(cliArgv.configDir);

  const config = await loadConfig(cliArgv.config, cliArgv.configDir);

  const resolved = await buildAgentConfig({
    cli: cliArgv,
    config,
    configDir,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: "",
    profilesPath: cliArgv.skillsPath
      ? path.join(cliArgv.skillsPath, "..", "profiles")
      : path.join(configDir, DEFAULT_PROFILES_SUBPATH),
  });

  const modelRegistry = buildModelRegistry({
    providers: config.providers || [],
  });
  resolved.modelRegistry = modelRegistry;

  return { resolved, modelRegistry, providers: config.providers || [] };
}

/**
 * Build a complete resolved configuration for the agent.
 */
export async function buildAgentConfig(options) {
  const {
    cli,
    config,
    configDir,
    providers = [],
    defaultModel = "qwen3.5-0.8b",
    defaultRole = "You are an AI coding assistant.",
    profilesPath: givenProfilesPath,
  } = options;

  // ── Early context (provider/profile not yet resolved) ────────────────────
  let context = {
    cli,
    config,
    configDir,
    extensions: {},
  };

  // Resolve values that don't depend on profile/provider via schema layers
  const profileName = resolveKey(
    "profileName",
    CONFIG_SCHEMA.profileName,
    context,
  );
  const profilesPath =
    givenProfilesPath ||
    resolveKey("profilesPath", CONFIG_SCHEMA.profilesPath, context);

  // Load profile files (imperative — file I/O)
  const profileFiles = await loadProfileFiles(profilesPath);
  const configProfile = config.profiles?.[profileName] ?? null;
  const fileProfile = profileFiles[profileName] ?? null;

  // Resolve provider name via schema, then look up the provider object
  const providerName = resolveKey("provider", CONFIG_SCHEMA.provider, context);
  const provider = providerName
    ? (providers.find((p) => p.name === providerName) ?? null)
    : null;

  // Profile merge — file profile wins for role, whitelist, blacklist, manager
  // (stays imperative — complex merge logic)
  let profile;
  if (configProfile || fileProfile) {
    profile = { ...configProfile };
    if (fileProfile) {
      if (fileProfile.role) profile.role = fileProfile.role;
      if (fileProfile.whitelistTools != null)
        profile.whitelistTools = fileProfile.whitelistTools;
      if (fileProfile.blacklistTools?.length)
        profile.blacklistTools = fileProfile.blacklistTools;
      if (fileProfile.manager) profile.manager = true;
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

  // ── Build extension config context ────────────────────────────────────
  const extensions = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !["profiles", "provider"].includes(key)
    ) {
      if (/^[a-z][a-zA-Z]+$/.test(key) && key !== "defaultModel") {
        extensions[key] = value;
      }
    }
  }

  // ── Full declarative resolution ────────────────────────────────────────
  context = {
    ...context,
    provider,
    profile,
    profileName,
    profilesPath,
    extensions,
  };
  const resolved = resolveAll(CONFIG_SCHEMA, context);

  // ── Truly imperative values ────────────────────────────────────────────

  // Model — needs resolveModelWithProvider transform (not a simple layer walk)
  const model = resolveModel(
    cli.model,
    configProfile?.model,
    config.defaultModel,
    provider,
    defaultModel,
  );

  // Profile body with template rendering (file I/O + template)
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

  // System prompt template (file I/O)
  const systemPromptTemplate = await initSystemPromptTemplate(
    cli.systemPromptTemplate || config.systemPromptTemplate,
    cli.configDir,
    resolveConfigDir,
  );

  // All profiles for switch (merge + format)
  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: config.profiles || {},
    profilesPath,
  });

  return {
    ...resolved,
    // Values not in schema (imperative-only)
    model,
    configDir,
    profile,
    profileBody,
    activeProvider: provider?.name || null,
    systemPromptTemplate,
    profiles,
    // Model registry (populated by buildConfig after calling this function)
    modelRegistry: {},
  };
}
