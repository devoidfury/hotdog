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
 * @param {string} keyName - The config key name.
 * @returns {*} The default value (static, not function-evaluated).
 */
function defaultFor(keyName) {
  const schemaKey = CONFIG_SCHEMA[keyName];
  if (!schemaKey) return undefined;
  return getLayerDefault(schemaKey);
}

// Connection settings
export const DEFAULT_AI_URL = defaultFor("baseUrl");

// Format strings
export const DEFAULT_THINKER = defaultFor("thinkerFormat");
export const DEFAULT_TOOL_FMT = defaultFor("toolFormat");
export const DEFAULT_TOOL_OUTPUT_FMT = defaultFor("toolOutputFmt");
export const DEFAULT_TOOL_RESULT_FMT = "  → {}";

// Timeouts
export const DEFAULT_CHAT_TIMEOUT_SECS = defaultFor("chatTimeout");
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS = defaultFor("embeddingsTimeout");

// Model (not in schema layers — still a constant)
export const DEFAULT_MODEL = "qwen3.5-0.8b";

// Path constants (not computed — static defaults for display/fallback)
export const DEFAULT_SKILLS_PATH = "/skills";
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_PROMPTS_SUBPATH = "prompts";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";
// Full default paths (CWD-relative, for display and fallback)
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";
export const DEFAULT_CONFIG_PATH = "./config/defaults.json";
export const DEFAULT_SYSTEM_PROMPT_PATH = "config/system_prompt.md";

// Other constants (from schema)
export const DEFAULT_MAX_TOKENS = defaultFor("maxTokens");
export const DEFAULT_MAX_ITERATIONS = defaultFor("maxIterations");
export const DEFAULT_MAX_RETRIES = defaultFor("maxRetries");
export const DEFAULT_PROMPT = defaultFor("prompt");
export const DEFAULT_EXIT_COMMANDS = defaultFor("exitCommands");
export const DEFAULT_ROLE = defaultFor("role");
export const DEFAULT_TASK_PROFILE = defaultFor("taskProfile");
