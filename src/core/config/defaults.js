/**
 * Default configuration constants — sourced from core.config.json.
 *
 * Instead of hardcoded values, each constant reads from the schema's
 * default layer. This keeps the JSON file as the single source of truth.
 */

import { CONFIG_SCHEMA, getLayerDefault } from "./schema-loader.js";

// ── Core config defaults (from schema) ────────────────────────────────────

/**
 * Get the default value for a schema key.
 * Handles both static values and function defaults.
 *
 * @private
 * @param {string} keyName - The config key name.
 * @returns {*} The default value (static, not function-evaluated).
 */
function defaultFor(keyName) {
  const schemaKey = CONFIG_SCHEMA[keyName];
  if (!schemaKey) return undefined;
  return getLayerDefault(schemaKey);
}

// Connection settings
// DEFAULT_AI_URL mirrors the schema's baseUrl default (null — URL comes from provider/config/env).
// DEFAULT_AI_URL_FALLBACK is a runtime fallback for LlmClient when no URL is configured.
export const DEFAULT_AI_URL = defaultFor("baseUrl");
export const DEFAULT_AI_URL_FALLBACK = defaultFor("defaultAiUrl");

// Format strings
export const DEFAULT_THINKER = defaultFor("thinkerFormat");
export const DEFAULT_TOOL_FMT = defaultFor("toolFormat");
export const DEFAULT_TOOL_OUTPUT_FMT = defaultFor("toolOutputFmt");

// Timeouts
export const DEFAULT_CHAT_TIMEOUT_SECS = defaultFor("chatTimeout");
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS = defaultFor("embeddingsTimeout");

// Model & tokens
export const DEFAULT_MODEL = defaultFor("defaultModel");
export const DEFAULT_MAX_TOKENS = defaultFor("maxTokens");
export const DEFAULT_MAX_ITERATIONS = defaultFor("maxIterations");
export const DEFAULT_MAX_RETRIES = defaultFor("maxRetries");

// UI/display defaults
export const DEFAULT_HIDE_TOOLS = defaultFor("hideTools");
export const DEFAULT_HIDE_THINKING = defaultFor("hideThinking");
export const DEFAULT_SHOW_TOKEN_USE = defaultFor("showTokenUse");
export const DEFAULT_THEME = defaultFor("theme");

// Task agent defaults
export const DEFAULT_TASK_PROFILE = defaultFor("taskProfile");
export const DEFAULT_TASK_ROLE = defaultFor("taskDefaultRole");

// Exit commands
export const DEFAULT_EXIT_COMMANDS = defaultFor("exitCommands");

// System prompt fallback template
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = defaultFor("systemPromptDefaultTemplate");

// Subcommand & misc
export const DEFAULT_SUBCOMMAND = defaultFor("defaultSubcommand");
export const DEFAULT_NO_LOG = defaultFor("noLog");
export const DEFAULT_COMPACT_DEBUG = defaultFor("compactDebug");
export const DEFAULT_HOOK_TRACE = defaultFor("hookTrace");

// Path constants (not computed — static defaults for display/fallback)
export const DEFAULT_SKILLS_PATH = "/skills";
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";
// Full default paths (CWD-relative, for display and fallback)
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";
