// Default configuration values and resolution logic used across the application.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cwd } from "node:process";

import { parseFrontMatter } from "../utils/file-utils.js";
import { deepMerge } from "../utils/objects.js";
import { render } from "../utils/render.js";
import { resolveAll, CONFIG_KEYS } from "./config-resolution.js";

// ── Config Directory Resolution ────────────────────────────────────────

/**
 * Resolve the config directory with the following priority:
 * 1. CLI argument (--config-dir)
 * 2. ./config (CWD-relative)
 * 3. OA_AGENT_CONFIG_DIR environment variable
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

  const cwdConfig = path.resolve(cwd(), "config");
  try {
    fs.accessSync(cwdConfig);
    return cwdConfig;
  } catch {
    // Not a directory or doesn't exist
  }

  const envConfigDir = process.env.OA_AGENT_CONFIG_DIR;
  if (envConfigDir) {
    return path.resolve(envConfigDir);
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

/**
 * Get a sub-path within the config directory.
 *
 * @param {string} configDir - Resolved config directory.
 * @param {string} subPath - Sub-path (e.g. "profiles", "prompts", "defaults.json").
 * @returns {string} Full path to the sub-resource.
 */
export function configSubPath(configDir, subPath) {
  return path.join(configDir, subPath);
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

// ── Core Defaults ───────────────────────────────────────────────────────

export const DEFAULT_MODEL = "qwen3.5-0.8b";
export const DEFAULT_AI_URL = "http://ai365.home:9292";
export const DEFAULT_THINKER = "[Thinking: {}]";
export const DEFAULT_TOOL_FMT = "  → {} {}";
export const DEFAULT_TOOL_OUTPUT_FMT = "----\n{}\n----";
export const DEFAULT_TOOL_RESULT_FMT = "  → {}";
export const DEFAULT_SKILLS_PATH = "/skills";
// Sub-path names relative to the resolved config directory
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_PROMPTS_SUBPATH = "prompts";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";

// Full default paths (CWD-relative, for backward compatibility and display)
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";
export const DEFAULT_CONFIG_PATH = "./config/defaults.json";
export const DEFAULT_CHAT_TIMEOUT_SECS = 600;
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS = 120;
export const DEFAULT_SYSTEM_PROMPT_PATH = "config/system_prompt.md";
export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_MAX_ITERATIONS = 1000;
export const DEFAULT_MAX_RETRIES = 12;
export const DEFAULT_PROMPT = "> ";
export const DEFAULT_EXIT_COMMANDS = ["exit", "quit"];
export const DEFAULT_ROLE =
  "You are an AI coding assistant. Use the instructions below and the tools available to you to assist the user.";
export const DEFAULT_TASK_PROFILE = "task-default";

// ── Config Loading ─────────────────────────────────────────────────────

/**
 * Normalize config keys from snake_case to camelCase.
 * Handles nested objects like profiles and mcp_servers.
 */
function normalizeConfigKeys(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeConfigKeys);

  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    // Convert snake_case to camelCase
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    normalized[camelKey] = normalizeConfigKeys(value);
  }
  return normalized;
}

/**
 * Get the default configuration.
 *
 * @param {Array<{key: string, defaults: Object}>} [extParams] - Extension config params to merge.
 * @returns {Object} Default config object.
 */
function getDefaultConfig(extParams) {
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
    // CLI --role > config file role > profile file role > DEFAULT_ROLE fallback
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
    const configFilePath = configSubPath(configDir, DEFAULT_CONFIG_FILENAME);
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
    console.error(`Error loading config from ${configPathToUse}: ${e.message}`);
    process.exit(1);
  }
}

// ── Profile Loading ────────────────────────────────────────────────────

/**
 * Load a profile from a .profile.md file.
 * Profile files use YAML front matter with fields: name, role, blacklist-tools, model, preload-skills, manager.
 */
export async function loadProfileFile(config, profileName) {
  const profilesPath = config.profilesPath;
  let filePath;
  try {
    filePath = path.join(profilesPath, `${profileName}.profile.md`);
    const content = await fsPromises.readFile(filePath, "utf-8");
    const parsed = parseFrontMatter(content);
    if (!parsed) return null;
    const fm = parsed.frontMatter;
    const body = parsed.body;
    return {
      name: fm.name || profileName,
      role: fm.role || null,
      body: body || "",
      model: fm.model || null,
      blacklistTools: fm["blacklist-tools"] || fm.blacklist_tools || [],
      whitelistTools: fm["whitelist-tools"] || fm.whitelist_tools || null,
      manager: fm.manager || false,
      visibleWorker: fm["visible-worker"] || fm.visible_worker || false,
    };
  } catch {
    return null;
  }
}

/**
 * Get resolved profile from config and profile files.
 * Priority: JSON config profile → .profile.md file → default.
 */
export async function getProfile(config, profileName) {
  // 1. Check JSON config profiles
  if (config.profiles && config.profiles[profileName]) {
    return config.profiles[profileName];
  }
  // 2. Check profile markdown files
  const fileProfile = await loadProfileFile(config, profileName);
  if (fileProfile) {
    return fileProfile;
  }
  // Default profile: no restrictions
  return {
    whitelistTools: null,
    blacklistTools: [],
    skills: [],
    role: null,
    model: null,
    manager: false,
    cwdBoundary: null,
  };
}

/**
 * Get all profile names that have visibleWorker: true.
 * Scans all .profile.md files in the profiles directory.
 * Returns an array of profile name strings.
 */
export async function getVisibleWorkerProfiles(config) {
  const profilesPath = config.profilesPath;
  let dir;
  try {
    dir = await fsPromises.readdir(profilesPath);
  } catch {
    return []; // Profiles directory not found or not readable
  }

  const profiles = [];
  for (const entry of dir) {
    if (!entry.endsWith(".profile.md")) continue;
    const profileName = entry.slice(0, -".profile.md".length);
    const profile = await loadProfileFile(config, profileName);
    if (profile && profile.visibleWorker) {
      profiles.push(profileName);
    }
  }
  return profiles;
}

/**
 * Load all .profile.md files from a directory.
 * Returns a map of profile name → { name, role, body, blacklistTools, whitelistTools, model, preloadSkills, manager }
 */
export async function loadProfileFiles(profilesPath) {
  const result = {};

  let entries;
  try {
    entries = await fsPromises.readdir(profilesPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".profile.md")) continue;

    const filePath = path.join(profilesPath, entry.name);
    let content;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontMatter(content);
    if (!parsed) continue;

    const fm = parsed.frontMatter;
    const fileStem = entry.name.replace(/\.profile\.md$/, "");

    result[fileStem] = {
      name: fm.name || fileStem,
      description: fm.description || "",
      role: fm.role || "",
      body: parsed.body || "",
      blacklistTools: fm["blacklist-tools"] || fm.blacklist_tools || [],
      whitelistTools: fm["whitelist-tools"] || fm.whitelist_tools || null,
      model: fm.model || null,
      manager: fm.manager || false,
    };
  }

  return result;
}

// ── Model Registry ─────────────────────────────────────────────────────

/**
 * Build a model registry from config providers.
 * Accepts a config object with a `providers` array.
 * Returns a map of model_name -> { name, temperature, maxTokens }
 */
export function buildModelRegistry(config) {
  const registry = {};
  const providers = config.providers || [];

  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      registry[modelName] = {
        name: modelName,
        temperature: modelEntry.temperature,
        maxTokens: modelEntry.maxTokens || DEFAULT_MAX_TOKENS,
      };
    }
    // Also add provider-level models (models defined at provider level)
    // If provider has no models array, use default model settings
    if (models.length === 0 && provider.defaultModel) {
      registry[`${provider.name}/${provider.defaultModel}`] = {
        name: `${provider.name}/${provider.defaultModel}`,
        temperature: provider.temperature,
        maxTokens: provider.maxTokens || DEFAULT_MAX_TOKENS,
      };
    }
  }

  return registry;
}

// ── System Prompt Template ─────────────────────────────────────────────

let cachedSystemPromptTemplate = null;

/**
 * Initialize (load) the system prompt template from disk.
 * Falls back to a minimal template if the file doesn't exist.
 */
export async function initSystemPromptTemplate(templatePath, cliConfigDir) {
  if (cachedSystemPromptTemplate) return cachedSystemPromptTemplate;

  const templateFile =
    templatePath ||
    configSubPath(resolveConfigDir(cliConfigDir), DEFAULT_SYSTEM_PROMPT_FILENAME);
  try {
    cachedSystemPromptTemplate = await fsPromises.readFile(
      templateFile,
      "utf-8",
    );
  } catch {
    // Fallback: minimal template
    cachedSystemPromptTemplate = `{{ role }}\n\n{{ body }}\n{% for chunk in chunks %}{{ chunk.content }}{% endfor %}`;
  }

  return cachedSystemPromptTemplate;
}

// ── Model Resolution ───────────────────────────────────────────────────

/**
 * Resolve a model name to provider/model format.
 */
function resolveModelWithProvider(name, provider) {
  if (name.includes("/")) return name;
  if (provider?.models) {
    const match = provider.models.find((m) => m.name === name);
    if (match) return `${provider.name}/${name}`;
  }
  return name;
}

/**
 * Resolve model name with priority: profile → CLI → provider default → config → default.
 */
function resolveModel(
  cliModel,
  profileModel,
  configModel,
  provider,
  defaultModel,
) {
  if (profileModel) return resolveModelWithProvider(profileModel, provider);
  if (cliModel) return resolveModelWithProvider(cliModel, provider);
  if (provider?.models?.length)
    return resolveModelWithProvider(provider.models[0].name, provider);
  if (configModel) return resolveModelWithProvider(configModel, provider);
  return defaultModel || "qwen3.5-0.8b";
}

// ── Switch Profile ─────────────────────────────────────────────────────

/**
 * Resolve a single profile's SwitchProfile data.
 */
export function resolveSwitchProfile(profileName, fileProfile, configProfile) {
  const role =
    fileProfile && fileProfile.role && fileProfile.role.trim()
      ? fileProfile.role
      : configProfile && configProfile.role
        ? configProfile.role
        : "";

  const body = fileProfile?.body || "";
  const model = configProfile?.model || null;

  return { role, body, model };
}

/**
 * Get all profiles available for switching.
 * Merges config profiles with file profiles.
 */
export function allProfilesForSwitch(options) {
  const { profileFiles, configProfiles } = options;
  const result = {};

  // Collect all profile names from both sources
  const allNames = new Set([
    ...Object.keys(configProfiles || {}),
    ...Object.keys(profileFiles || {}),
  ]);

  for (const name of allNames) {
    const fileProfile = profileFiles?.[name] || null;
    const configProfile = configProfiles?.[name] || null;
    const sp = resolveSwitchProfile(name, fileProfile, configProfile);
    result[name] = sp;
  }

  return result;
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
    defaultRole: DEFAULT_ROLE,
    profilesPath: cliArgv.skillsPath
      ? path.join(cliArgv.skillsPath, "..", "profiles")
      : configSubPath(configDir, DEFAULT_PROFILES_SUBPATH),
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

  const profilesPath =
    givenProfilesPath ||
    (configDir
      ? configSubPath(configDir, DEFAULT_PROFILES_SUBPATH)
      : DEFAULT_PROFILES_PATH);

  // Load profile files
  const profileFiles = await loadProfileFiles(profilesPath);
  const profileName = cli.profile || config.profile || "default";

  // Get config profile
  const configProfile = config.profiles?.[profileName] ?? null;

  // Get file profile
  const fileProfile = profileFiles[profileName] ?? null;

  // Provider
  const providerName = cli.provider || config.defaultProvider;
  const provider = providerName
    ? (providers.find((p) => p.name === providerName) ?? null)
    : null;

  // Profile merge — file profile wins for role, whitelist, blacklist, manager
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
      role: null,
      model: null,
      manager: false,
      cwdBoundary: null,
    };
  }

  // ── Declarative resolution ────────────────────────────────────────────

  const context = {
    cli,
    config,
    configDir,
    provider,
    profile,
    profileName,
    profilesPath,
  };

  const resolved = resolveAll(CONFIG_KEYS, context);

  // ── Non-declarative values ────────────────────────────────────────────

  // Model — needs resolveModelWithProvider transform
  const model = resolveModel(
    cli.model,
    configProfile?.model,
    config.defaultModel,
    provider,
    defaultModel,
  );

  // Profile body with template rendering (stays imperative — file I/O + template)
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

  // System prompt template
  const systemPromptTemplate = await initSystemPromptTemplate(
    cli.systemPromptTemplate || config.systemPromptTemplate,
    cli.configDir,
  );

  // All profiles for switch
  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: config.profiles || {},
    profilesPath,
  });

  return {
    // Declaratively resolved values
    ...resolved,
    // Non-declarative values
    model,
    profileName,
    configDir,
    profilesPath,
    profile,
    profileBody,
    provider,
    activeProvider: provider?.name || null,
    systemPromptTemplate,
    profiles,
    // Model registry (populated by buildConfig after calling this function)
    modelRegistry: {},
  };
}
