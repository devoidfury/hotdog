// Init module — agent initialization and configuration resolution.
// Init module — agent initialization and configuration resolution.

import fs from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { parseFrontMatter, DEFAULT_MODEL, DEFAULT_ROLE, DEFAULT_SKILLS_PATH, DEFAULT_PROFILES_PATH } from "../config.js";
import { render } from "../context/render.js";

// ── Unified Config Builder ───────────────────────────────────────────────────

/**
 * Build the complete resolved configuration from CLI args.
 *
 * This is the single entry point for configuration resolution.
 * It loads the config file, resolves all values (CLI → config → env → default),
 * and returns a single object with everything needed.
 *
 * Usage:
 *   const config = await buildConfig(cliArgv);
 *   // config.resolved — fully resolved agent configuration
 *   // config.modelRegistry — model lookup map
 *   // config.providers — raw provider list
 *
 * @param {object} cliArgv - Parsed CLI arguments (from cli.js parseArgs)
 * @returns {Promise<{ resolved: object, modelRegistry: object, providers: object[] }>} Complete resolved configuration
 */
export async function buildConfig(cliArgv) {
  const { loadConfig } = await import("../config.js");
  const config = await loadConfig(cliArgv.config);

  const resolved = buildAgentConfig({
    cli: cliArgv,
    config,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: DEFAULT_ROLE,
    profilesPath: cliArgv.skillsPath
      ? join(cliArgv.skillsPath, "..", "profiles")
      : config.profilesPath || DEFAULT_PROFILES_PATH,
  });

  const { buildModelRegistry } = await import("../config.js");
  const modelRegistry = buildModelRegistry({ providers: config.providers || [] });

  return { resolved, modelRegistry, providers: config.providers || [] };
}

// ── Profile File Loading ───────────────────────────────────────────────────

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

    const filePath = join(profilesPath, entry.name);
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
      preloadSkills: fm["preload-skills"] || fm.preload_skills || [],
      manager: fm.manager || false,
    };
  }

  return result;
}

// ── Resolution Helpers ─────────────────────────────────────────────────────

/**
 * Resolve format string: CLI → config → default.
 */
export function resolveFormatString(cliValue, configValue, defaultValue) {
  if (cliValue !== undefined && cliValue !== null && cliValue !== "")
    return cliValue;
  if (configValue !== undefined && configValue !== null && configValue !== "")
    return configValue;
  return defaultValue;
}

/**
 * Resolve no-log: CLI → env (OA_AGENT_LOG, OA_AGENT_NO_LOG) → config → false.
 */
export function resolveNoLog(cli, config) {
  if (cli) return true;
  if (process.env.OA_AGENT_LOG === "false") return true;
  if (process.env.OA_AGENT_NO_LOG === "1") return true;
  if (config.noLog) return true;
  return false;
}

/**
 * Resolve theme: CLI → config → 'dark'.
 * Returns the theme string (e.g. 'dark', 'light', 'monochrome', or a file path).
 */
export function resolveTheme(cliTheme, configTheme) {
  if (cliTheme !== undefined && cliTheme !== null && cliTheme !== "")
    return cliTheme;
  if (configTheme !== undefined && configTheme !== null && configTheme !== "")
    return configTheme;
  return "dark";
}

/**
 * Resolve color usage: CLI colors flag → config colors → true (default).
 */
export function resolveColors(cliColors, configColors) {
  if (cliColors !== undefined) return cliColors;
  if (configColors !== undefined) return configColors;
  return true;
}

/**
 * Check if a value looks like a ColorPalette object (has the expected fields).
 */
function isColorPalette(obj) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    ("thinking" in obj || "tool_call" in obj || "tool_result" in obj)
  );
}

/**
 * Resolve the color palette from config. Returns a ColorPalette-like object
 * if config.colors contains one, otherwise null.
 * Check if the config contains a color palette object.
 */
export function resolveColorPalette(config) {
  if (isColorPalette(config.colors)) {
    return config.colors;
  }
  return null;
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve model name with priority: profile → CLI → provider default → config → default.
 * Also resolves bare model names to provider/model format.
 */
export function resolveModelName(options) {
  const { cliModel, profileModel, configModel, provider, defaultModel } =
    options;

  // Profile model override (highest priority after CLI)
  if (profileModel) {
    return resolveModelWithProvider(profileModel, provider);
  }

  // CLI model
  if (cliModel) {
    return resolveModelWithProvider(cliModel, provider);
  }

  // Provider's first model as default
  if (provider && provider.models && provider.models.length > 0) {
    return resolveModelWithProvider(provider.models[0].name, provider);
  }

  // Config default model
  if (configModel) {
    return resolveModelWithProvider(configModel, provider);
  }

  // Global default
  return defaultModel || "qwen3.5-0.8b";
}

/**
 * Resolve a model name to provider/model format.
 * If the name already contains '/', it's used as-is.
 * If a provider is active and the name matches a provider model,
 * it's prefixed with the provider name.
 */
export function resolveModelWithProvider(name, provider) {
  if (name.includes("/")) {
    return name;
  }
  if (provider && provider.models) {
    const match = provider.models.find((m) => m.name === name);
    if (match) {
      return `${provider.name}/${name}`;
    }
  }
  return name;
}

/**
 * Resolve base URL: provider → CLI → config → default.
 */
export function resolveBaseUrl(options) {
  const { cliUrl, configUrl, provider } = options;
  if (provider && provider.url) {
    return provider.url;
  }
  if (cliUrl) return cliUrl;
  if (configUrl) return configUrl;
  return "http://ai365.home:9292";
}

/**
 * Resolve API key: provider → CLI → config → env → null.
 */
export function resolveApiKey(options) {
  const { cliKey, configKey, provider } = options;
  if (provider && provider.apiKey) {
    return provider.apiKey;
  }
  if (cliKey) return cliKey;
  if (configKey) return configKey;
  return process.env.AI_API_KEY || null;
}

/**
 * Resolve aspect names: file profile aspects → config profile aspects.
 */
export function resolveAspectNames(options) {
  const { fileProfile, configProfile } = options;

  // File profile aspects take priority
  if (fileProfile && fileProfile.aspects && fileProfile.aspects.length > 0) {
    return fileProfile.aspects;
  }

  // Config profile aspects
  if (
    configProfile &&
    configProfile.aspects &&
    configProfile.aspects.length > 0
  ) {
    return configProfile.aspects;
  }

  return [];
}

/**
 * Resolve role: CLI → config → file profile → default.
 */
export function resolveRole(options) {
  const { cliRole, configRole, fileProfile, defaultRole } = options;
  if (cliRole) return cliRole;
  if (configRole && configRole.trim()) return configRole;
  if (fileProfile && fileProfile.role && fileProfile.role.trim())
    return fileProfile.role;
  return defaultRole || "You are an AI coding assistant.";
}

/**
 * Resolve profile: merge config profile with file profile overrides.
 */
export function resolveProfile(options) {
  const { configProfile, fileProfile } = options;

  if (!configProfile && !fileProfile) {
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

  const merged = { ...configProfile };

  if (fileProfile) {
    if (
      fileProfile.whitelistTools !== null &&
      fileProfile.whitelistTools !== undefined
    ) {
      merged.whitelistTools = fileProfile.whitelistTools;
    }
    if (fileProfile.blacklistTools && fileProfile.blacklistTools.length > 0) {
      merged.blacklistTools = fileProfile.blacklistTools;
    }
    if (fileProfile.preloadSkills && fileProfile.preloadSkills.length > 0) {
      merged.preloadSkills = fileProfile.preloadSkills;
    }
    if (fileProfile.manager) {
      merged.manager = true;
    }
  }

  return merged;
}

/**
 * Resolve active provider by name.
 */
export function resolveProvider(options) {
  const { cliProvider, configProvider, providers } = options;
  const providerName = cliProvider || configProvider;
  if (!providerName) return null;
  return providers.find((p) => p.name === providerName) || null;
}

/**
 * Render profile body with ARGS template substitution.
 * Uses the template engine (same as system prompt template).
 */
export function renderProfileBody(body, args) {
  if (!body || !body.trim()) return "";
  if (!args) return body;
  try {
    return render(body, { ARGS: args });
  } catch {
    // If template rendering fails, return raw body (fallback)
    return body;
  }
}

// ── Switch Profile ─────────────────────────────────────────────────────────

/**
 * Resolve a single profile's SwitchProfile data.
 * Shared by allProfilesForSwitch and buildAgentConfig.
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

  const body = renderProfileBody(fileProfile?.body, null);
  const model = configProfile?.model || null;

  // Load aspects
  const aspects = loadAspectsFromNames(aspectNames, profilesPath);

  return { role, body, model, aspects };
}

/**
 * Load aspects from names and a profiles path.
 */
function loadAspectsFromNames(aspectNames, profilesPath) {
  if (!aspectNames || aspectNames.length === 0) return [];

  const aspects = [];

  for (const name of aspectNames) {
    const fileName = `${name}.aspect.md`;
    const path = join(profilesPath, "aspects", fileName);
    try {
      const content = fs.readFileSync(path, "utf-8");
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
    const aspectNames = resolveAspectNames({ fileProfile, configProfile });
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

// ── System Prompt Template Init ────────────────────────────────────────────

let cachedSystemPromptTemplate = null;

/**
 * Initialize (load) the system prompt template from disk.
 * Falls back to a minimal template if the file doesn't exist.
 * Initialize (load) the system prompt template from disk.
 */
export function initSystemPromptTemplate(templatePath) {
  if (cachedSystemPromptTemplate) return cachedSystemPromptTemplate;

  const path =
    templatePath || join(cwd(), "config", "templates", "system_prompt.md");
  try {
    cachedSystemPromptTemplate = fs.readFileSync(path, "utf-8");
  } catch {
    // Fallback: minimal template
    cachedSystemPromptTemplate = `# Role & Mission

{{ role }}

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
## Aspect: {{ aspect.name }}

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

// ── Build Output ───────────────────────────────────────────────────────────

/**
 * Build a complete resolved configuration for the agent.
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
  const configProfile =
    config.profiles && config.profiles[profileName]
      ? config.profiles[profileName]
      : null;

  // Get file profile
  const fileProfile = profileFiles[profileName] || null;

  // Resolve all values
  const provider = resolveProvider({
    cliProvider: cli.provider,
    configProvider: config.defaultProvider,
    providers,
  });

  const baseUrl = resolveBaseUrl({
    cliUrl: cli.url,
    configUrl: config.aiUrl,
    provider,
  });

  const apiKey = resolveApiKey({
    cliKey: cli.apiKey,
    configKey: config.apiKey,
    provider,
  });

  const model = resolveModelName({
    cliModel: cli.model,
    profileModel: configProfile?.model,
    configModel: config.defaultModel,
    provider,
    defaultModel,
  });

  const role = resolveRole({
    cliRole: cli.role,
    configRole: config.role,
    fileProfile,
    defaultRole,
  });

  const profile = resolveProfile({ configProfile, fileProfile });
  const aspects = resolveAspectNames({ fileProfile, configProfile: profile });
  const profileBody = renderProfileBody(fileProfile?.body, cli.prompt);
  const preloadSkills =
    cli.preloadSkills?.length > 0
      ? cli.preloadSkills
      : profile.preloadSkills || [];

  // Format strings: CLI → config → default
  const thinkerFormat = resolveFormatString(
    cli.thinker,
    config.thinker,
    "[Thinking: {}]",
  );
  const toolFormat = resolveFormatString(
    cli.toolfmt,
    config.toolfmt,
    "  → {} {}",
  );
  const toolOutputFmt = resolveFormatString(
    cli.toolOutputFmt,
    config.toolOutputFmt,
    "----\n{}\n----",
  );

  // No-log resolution
  const noLog = resolveNoLog(cli.noLog, config);

  // Theme resolution
  const theme = resolveTheme(cli.theme, config.theme);
  const useColors = cli.noColors
    ? false
    : resolveColorPalette(config) !== null
      ? true
      : resolveColors(cli.colors, config.colors);

  // System prompt template init
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
    preloadSkills,
    hideTools:
      cli.hideTools === false
        ? false
        : config.hideTools !== false,
    hideThinking:
      cli.hideThinking === true
        ? true
        : cli.hideThinking === false
          ? false
          : config.hideThinking !== false,
    compactDebug: cli.compactDebug || config.compactDebug || false,
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
    chatTimeout: cli.chatTimeout || config.chatTimeoutSecs || 600,
    embeddingsTimeout:
      cli.embeddingsTimeout || config.embeddingsTimeoutSecs || 120,
    // Session / paths
    sessionId: cli.sessionId || null,
    skillsPath: cli.skillsPath || config.skillsPath || null,
    promptsPath: cli.promptsPath || config.promptsPath || null,
  };
}
