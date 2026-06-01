// Default configuration values and resolution logic used across the application.

import fs from "node:fs";
import path from "node:path";
import { cwd } from "node:process";

import { parseFrontMatter } from "./utils.js";
import { deepMerge } from "./utils.js";
import { render } from "./context/render.js";

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
    } else if (typeof merged[param.key] === 'object' && merged[param.key] !== null) {
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
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";
export const DEFAULT_CONFIG_PATH = "./config/defaults.json";
export const DEFAULT_CHAT_TIMEOUT_SECS = 600;
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS = 120;
export const DEFAULT_SYSTEM_PROMPT_PATH = "config/templates/system_prompt.md";
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
 * Normalize config keys from snake_case (Rust format) to camelCase (JS format).
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
  };

  return mergeExtensionConfigDefaults(baseConfig, extParams);
}

/**
 * Load config from file, falling back to defaults if no path is given.
 *
 * Resolution order:
 * 1. If `configPath` is explicitly provided via CLI, load that file (exit on error).
 * 2. Otherwise, try loading config from (in priority):
 *    a. ./config/defaults.json (relative to CWD)
 *    b. ~/.config/oa-agent/default.json (home directory)
 *    Silently fall through to defaults if none exist.
 * 3. Return defaults as the final fallback.
 *
 * @param {string} [configPath] - Path to config file.
 * @param {Array<{key: string, defaults: Object}>} [extParams] - Extension config params to merge.
 * @returns {Promise<Object>} Resolved config object.
 */
export async function loadConfig(configPath, extParams) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");

  const homeConfig = path.join(
    os.homedir(),
    ".config",
    "oa-agent",
    "default.json",
  );

  // Resolve config path: if relative, keep as-is (CWD-relative);
  // if absolute, use directly.
  let configPathToUse = configPath;
  if (!configPathToUse) {
    // Try CWD-relative config first, then home directory
    const candidates = [DEFAULT_CONFIG_PATH, homeConfig];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        configPathToUse = candidate;
        break;
      } catch {
        // Not found, try next
      }
    }
  }

  if (!configPathToUse) {
    return getDefaultConfig(extParams);
  }

  try {
    const content = await fs.readFile(configPathToUse, "utf-8");
    const raw = JSON.parse(content);
    // Normalize snake_case keys from Rust config to camelCase
    return deepMerge(getDefaultConfig(extParams), normalizeConfigKeys(raw));
  } catch (e) {
    console.error(`Error loading config from ${configPathToUse}: ${e.message}`);
    process.exit(1);
  }
}

// ── Profile Loading ────────────────────────────────────────────────────

/**
 * Load a profile from a .profile.md file.
 * Profile files use YAML front matter with fields: name, role, aspects, blacklist-tools, model, preload-skills, manager.
 */
export function loadProfileFile(config, profileName) {
  const profilesPath = config.profilesPath;
  let filePath;
  try {
    filePath = path.join(profilesPath, `${profileName}.profile.md`);
    const content = fs.readFileSync(filePath, "utf-8");
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
      aspects: fm.aspects || [],
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
export function getProfile(config, profileName) {
  // 1. Check JSON config profiles
  if (config.profiles && config.profiles[profileName]) {
    return config.profiles[profileName];
  }
  // 2. Check profile markdown files
  const fileProfile = loadProfileFile(config, profileName);
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
    aspects: [],
  };
}

/**
 * Get all profile names that have visibleWorker: true.
 * Scans all .profile.md files in the profiles directory.
 * Returns an array of profile name strings.
 */
export function getVisibleWorkerProfiles(config) {
  const profilesPath = config.profilesPath;
  let dir;
  try {
    dir = fs.readdirSync(profilesPath);
  } catch {
    return []; // Profiles directory not found or not readable
  }

  const profiles = [];
  for (const entry of dir) {
    if (!entry.endsWith(".profile.md")) continue;
    const profileName = entry.slice(0, -".profile.md".length);
    const profile = loadProfileFile(config, profileName);
    if (profile && profile.visibleWorker) {
      profiles.push(profileName);
    }
  }
  return profiles;
}

/**
 * Load all .profile.md files from a directory.
 * Returns a map of profile name → { name, role, aspects, body, blacklistTools, whitelistTools, model, preloadSkills, manager }
 */
function loadProfileFiles(profilesPath) {
  const result = {};

  let entries;
  try {
    entries = fs.readdirSync(profilesPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".profile.md")) continue;

    const filePath = path.join(profilesPath, entry.name);
    let content;
    try {
      content = fs.readFileSync(filePath, "utf-8");
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
      aspects: fm.aspects || [],
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
export function initSystemPromptTemplate(templatePath) {
  if (cachedSystemPromptTemplate) return cachedSystemPromptTemplate;

  const templateFile =
    templatePath || path.join(cwd(), "config", "templates", "system_prompt.md");
  try {
    cachedSystemPromptTemplate = fs.readFileSync(templateFile, "utf-8");
  } catch {
    // Fallback: minimal template
    cachedSystemPromptTemplate = `{{ role }}

Use the instructions below and the tools available to you to assist the user.

{%- if body %}

{{ body }}
{%- endif %}

# Environment

<system-notice>
  Agent: oa-agent (Model: {{ model }}) (Profile: {{ profile_name }})
  CWD: {{ cwd }}
  Platform: {{ platform }}
  Session: {{ session_start }}
</system-notice>

{% if aspects|length > 0 -%}
# Guidelines

{% for aspect in aspects -%}
{{ aspect.content }}
{% endfor %}
{%- endif %}

{% if agents_md %}
# Project Context

<file-include>
<path>./AGENTS.md</path>
<contents>
{{ agents_md }}
</contents>
</file-include>
{%- endif %}`;
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
 * Load aspects from names and a profiles path.
 */
function loadAspectsFromNames(aspectNames, profilesPath) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const aspects = [];

  for (const name of aspectNames) {
    const fileName = `${name}.aspect.md`;
    const filePath = path.join(profilesPath, "aspects", fileName);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        aspects.push({ name, content: trimmed });
      }
    } catch {
      // Silent skip
    }
  }

  return aspects;
}

/**
 * Resolve a single profile's SwitchProfile data.
 */
export function resolveSwitchProfile(
  profileName,
  fileProfile,
  configProfile,
  aspectNames,
  profilesPath,
) {
  const role =
    fileProfile && fileProfile.role && fileProfile.role.trim()
      ? fileProfile.role
      : configProfile && configProfile.role
        ? configProfile.role
        : "";

  const body = fileProfile?.body || "";
  const model = configProfile?.model || null;

  // Load aspects
  const aspects = loadAspectsFromNames(aspectNames, profilesPath);

  return { role, body, model, aspects };
}

/**
 * Get all profiles available for switching.
 * Merges config profiles with file profiles.
 */
export function allProfilesForSwitch(options) {
  const { profileFiles, configProfiles, profilesPath } = options;
  const result = {};

  // Collect all profile names from both sources
  const allNames = new Set([
    ...Object.keys(configProfiles || {}),
    ...Object.keys(profileFiles || {}),
  ]);

  for (const name of allNames) {
    const fileProfile = profileFiles?.[name] || null;
    const configProfile = configProfiles?.[name] || null;
    // Aspects: file profile → config profile
    const aspectNames =
      (fileProfile?.aspects?.length ? fileProfile.aspects : null) ??
      (configProfile?.aspects?.length ? configProfile.aspects : null) ??
      [];
    const sp = resolveSwitchProfile(
      name,
      fileProfile,
      configProfile,
      aspectNames,
      profilesPath,
    );
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
  const config = await loadConfig(cliArgv.config);

  const resolved = buildAgentConfig({
    cli: cliArgv,
    config,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: DEFAULT_ROLE,
    profilesPath: cliArgv.skillsPath
      ? path.join(cliArgv.skillsPath, "..", "profiles")
      : config.profilesPath,
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
export function buildAgentConfig(options) {
  const {
    cli,
    config,
    providers = [],
    defaultModel = "qwen3.5-0.8b",
    defaultRole = "You are an AI coding assistant.",
    profilesPath = "./config/profiles",
  } = options;

  // Load profile files
  const profileFiles = loadProfileFiles(profilesPath);
  const profileName = cli.profile || config.profile || "default";

  // Get config profile
  const configProfile = config.profiles?.[profileName] ?? null;

  // Get file profile
  const fileProfile = profileFiles[profileName] ?? null;

  // ── Resolve simple values inline ──────────────────────────────────────

  // Provider
  const providerName = cli.provider || config.defaultProvider;
  const provider = providerName
    ? (providers.find((p) => p.name === providerName) ?? null)
    : null;

  // Base URL: provider → CLI → config → default
  const baseUrl =
    provider?.url ?? cli.url ?? config.aiUrl ?? "http://ai365.home:9292";

  // API key: provider → CLI → config → env
  const apiKey =
    provider?.apiKey ??
    cli.apiKey ??
    config.apiKey ??
    process.env.AI_API_KEY ??
    null;

  // Model
  const model = resolveModel(
    cli.model,
    configProfile?.model,
    config.defaultModel,
    provider,
    defaultModel,
  );

  // Role: CLI → config → file profile → default
  const role =
    cli.role ??
    (config.role?.trim() ? config.role : null) ??
    (fileProfile?.role?.trim() ? fileProfile.role : null) ??
    defaultRole;

  // Profile merge
  let profile;
  if (configProfile || fileProfile) {
    profile = { ...configProfile };
    if (fileProfile) {
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
      aspects: [],
    };
  }

  // Aspects: file profile → config profile
  const aspects =
    (fileProfile?.aspects?.length ? fileProfile.aspects : null) ??
    (profile.aspects?.length ? profile.aspects : null) ??
    [];

  // Profile body with template rendering
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

  // Format strings: CLI → config → default
  const thinkerFormat = cli.thinker ?? config.thinker ?? "[Thinking: {}]";
  const toolFormat = cli.toolfmt ?? config.toolfmt ?? "  → {} {}";
  const toolOutputFmt =
    cli.toolOutputFmt ?? config.toolOutputFmt ?? "----\n{}\n----";

  // No-log: CLI → env → config → false
  const noLog =
    (cli.noLog !== undefined && cli.noLog !== false) ||
    process.env.OA_AGENT_LOG === "false" ||
    process.env.OA_AGENT_NO_LOG === "1" ||
    config.noLog ||
    false;

  // Theme: CLI → config → 'dark'
  const theme =
    (cli.theme?.trim() || config.theme?.trim() || "dark").replace(
      /^\s+|\s+$/g,
      "",
    ) || "dark";

  // Colors
  const isColorPalette = (obj) =>
    obj != null &&
    typeof obj === "object" &&
    ("thinking" in obj || "tool_call" in obj || "tool_result" in obj);
  const useColors =
    !cli.noColors &&
    (isColorPalette(config.colors) || (cli.colors ?? config.colors ?? true));

  // System prompt template
  const systemPromptTemplate = initSystemPromptTemplate(
    cli.systemPromptTemplate || config.systemPromptTemplate,
  );

  // All profiles for switch
  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: config.profiles || {},
    profilesPath,
  });

  return {
    baseUrl,
    apiKey,
    model,
    role,
    profileName,
    profile,
    aspects,
    profileBody,
    hideTools: cli.hideTools === false ? false : config.hideTools !== false,
    hideThinking:
      cli.hideThinking === true
        ? true
        : cli.hideThinking === false
          ? false
          : config.hideThinking !== false,
    compactDebug: cli.compactDebug || config.compactDebug,
    showTokenUse: cli.tokens || config.showTokenUse !== false,
    stream: !cli.noStream,
    provider,
    activeProvider: provider?.name || null,
    // Format strings
    thinkerFormat,
    toolFormat,
    toolOutputFmt,
    // No-log
    noLog,
    // Theme / colors
    theme,
    useColors,
    // System prompt template
    systemPromptTemplate,
    // All profiles
    profiles,
    // Chat/embedding timeouts
    chatTimeout: cli.chatTimeout || config.chatTimeoutSecs,
    embeddingsTimeout: cli.embeddingsTimeout || config.embeddingsTimeoutSecs,
    // Session / paths
    sessionId: cli.sessionId || null,
    skillsPath: cli.skillsPath || config.skillsPath,
    promptsPath: cli.promptsPath || config.promptsPath,
    // Model registry (populated by buildConfig after calling this function)
    modelRegistry: {},
  };
}
