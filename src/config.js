// Default configuration values used across the application.

export const DEFAULT_MODEL = 'qwen3.5-0.8b';
export const DEFAULT_AI_URL = 'http://ai365.home:9292';
export const DEFAULT_THINKER = '[Thinking: {}]';
export const DEFAULT_TOOL_FMT = '  → {} {}';
export const DEFAULT_TOOL_OUTPUT_FMT = '----\n{}\n----';
export const DEFAULT_TOOL_RESULT_FMT = '  → {}';
export const DEFAULT_SKILLS_PATH = '/skills';
export const DEFAULT_PROFILES_PATH = './config/profiles';
export const DEFAULT_PROMPTS_PATH = './config/prompts';
export const DEFAULT_CONFIG_PATH = './config/defaults.json';
export const DEFAULT_CHAT_TIMEOUT_SECS = 600;
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS = 120;
export const DEFAULT_BASH_TIMEOUT_MS = 60000;
export const DEFAULT_SYSTEM_PROMPT_PATH = 'config/templates/system_prompt.md';

export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_MAX_ITERATIONS = 1000;
export const DEFAULT_MAX_RETRIES = 12;
export const DEFAULT_PROMPT = '> ';
export const DEFAULT_EXIT_COMMANDS = ['exit', 'quit'];
export const DEFAULT_ROLE =
  'You are an AI coding assistant. Use the instructions below and the tools available to you to assist the user.';
export const DEFAULT_MAX_TOOL_OUTPUT_LINES = 800;
export const DEFAULT_READ_TOOL_LIMIT = 800;
export const DEFAULT_FIND_MAX_RESULTS = 400;
export const DEFAULT_GREP_MAX_RESULTS = 100;

// Max diff size in characters — diffs larger than this are truncated to prevent API crashes
export const DEFAULT_MAX_DIFF_SIZE = 8000;

// Max input size for edit tool (oldString + newString combined) in characters
export const DEFAULT_MAX_EDIT_INPUT_SIZE = 16000;

// Compaction settings
export const DEFAULT_COMPACTION_ENABLED = true;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384;
export const DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES = 3;

export const defaultCompactionSettings = {
  enabled: DEFAULT_COMPACTION_ENABLED,
  reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
  keepRecentMessages: DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES,
};

/**
 * Normalize config keys from snake_case (Rust format) to camelCase (JS format).
 * Handles nested objects like profiles and mcp_servers.
 */
function normalizeConfigKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
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
 * Load config from file, falling back to defaults if no path is given.
 *
 * Resolution order:
 * 1. If `configPath` is explicitly provided via CLI, load that file (exit on error).
 * 2. Otherwise, try loading config from (in priority):
 *    a. ./config/defaults.json (relative to CWD)
 *    b. ~/.config/oa-agent/default.json (home directory)
 *    Silently fall through to defaults if none exist.
 * 3. Return defaults as the final fallback.
 */
export async function loadConfig(configPath) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const homeConfig = path.join(os.homedir(), '.config', 'oa-agent', 'default.json');

  // Resolve config path: if relative, keep as-is (CWD-relative);
  // if absolute, use directly.
  let configPathToUse = configPath;
  if (!configPathToUse) {
    // Try CWD-relative config first, then home directory
    const candidates = [
      DEFAULT_CONFIG_PATH,
      homeConfig,
    ];
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
    return getDefaultConfig();
  }

  try {
    const content = await fs.readFile(configPathToUse, 'utf-8');
    const raw = JSON.parse(content);
    // Normalize snake_case keys from Rust config to camelCase
    return normalizeConfigKeys(raw);
  } catch (e) {
    if (configPath) {
      console.error(`Error loading config from ${configPathToUse}: ${e.message}`);
      process.exit(1);
    }
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    providers: [],
    defaultProvider: null,
    aiUrl: null,
    defaultModel: null,
    temperature: null,
    thinker: DEFAULT_THINKER,
    toolfmt: DEFAULT_TOOL_FMT,
    toolOutputFmt: DEFAULT_TOOL_OUTPUT_FMT,
    role: DEFAULT_ROLE,
    hideTools: true,
    hideThinking: false,
    skillsPath: null,
    profilesPath: null,
    promptsPath: null,
    systemPromptTemplate: null,
    chatTimeoutSecs: DEFAULT_CHAT_TIMEOUT_SECS,
    embeddingsTimeoutSecs: DEFAULT_EMBEDDINGS_TIMEOUT_SECS,
    profile: null,
    profiles: {},
    theme: null,
    colors: null, // ColorPalette object — see colors.js ColorPalette
    apiKey: null,
    maxToolOutputLines: DEFAULT_MAX_TOOL_OUTPUT_LINES,
    noLog: false,
    mcpServers: [],
    compaction: defaultCompactionSettings,
    showTokenUse: null,
  };
}

/**
 * Resolve API key with priority: CLI → config → env → null.
 */
export function resolveApiKey(cli, config) {
  if (cli) return cli;
  if (config.apiKey) return config.apiKey;
  return process.env.AI_API_KEY || null;
}

// ── YAML Parsing ───────────────────────────────────────────────────────────

import { YAML } from "bun";

/**
 * Parse YAML front matter from a markdown string.
 * Returns { frontMatter: object, body: string } or null if no front matter.
 */
export function parseFrontMatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const body = m[2] || "";
  const fm = YAML.parse(m[1]);
  return { frontMatter: fm, body };
}

/**
 * Load a profile from a .profile.md file.
 * Profile files use YAML front matter with fields: name, role, aspects, blacklist-tools, model, preload-skills, manager.
 */
export function loadProfileFile(config, profileName) {
  const profilesPath = config.profilesPath || DEFAULT_PROFILES_PATH;
  let fs, path;
  try {
    fs = require('node:fs');
    path = require('node:path');
  } catch {
    return null;
  }

  const filePath = path.join(profilesPath, `${profileName}.profile.md`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFrontMatter(content);
    if (!parsed) return null;
    const fm = parsed.frontMatter;
    const body = parsed.body;
    return {
      name: fm.name || profileName,
      role: fm.role || null,
      body: body || '',
      model: fm.model || null,
      blacklistTools: fm['blacklist-tools'] || fm.blacklist_tools || [],
      whitelistTools: fm['whitelist-tools'] || fm.whitelist_tools || null,
      aspects: fm.aspects || [],
      preloadSkills: fm['preload-skills'] || fm.preload_skills || [],
      manager: fm.manager || false,
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
    preloadSkills: [],
    manager: false,
    cwdBoundary: null,
    aspects: [],
  };
}

// Internal helpers — used by tests and internal logic
export function resolveString(cli, configValue, defaultValue, envName) {
  if (cli !== undefined && cli !== null) return cli;
  if (configValue !== undefined && configValue !== null && configValue !== '') return configValue;
  const env = envName ? process.env[envName] : undefined;
  if (env !== undefined && env !== '') return env;
  return defaultValue;
}

// Internal helpers — used by tests and internal logic
export function isFalse(val) {
  return val === false;
}

export function isEmptyArray(val) {
  return Array.isArray(val) && val.length === 0;
}

export function isNoneOr(val, check) {
  return val === null || val === undefined || check(val);
}

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
