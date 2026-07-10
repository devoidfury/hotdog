/**
 * Default configuration constants — sourced from core.config.json.
 *
 * Instead of hardcoded values, each constant reads from the schema's
 * default layer. This keeps the JSON file as the single source of truth.
 */

import { CONFIG_SCHEMA, getLayerDefault } from "./schema-loader.ts";

// ── Core config defaults (from schema) ────────────────────────────────────

/**
 * Get the default value for a schema key.
 * Handles both static values and function defaults.
 *
 * @private
 */
function defaultFor<T = unknown>(keyName: string): T {
  const schemaKey = CONFIG_SCHEMA[keyName];
  if (!schemaKey) return undefined as T;
  return getLayerDefault(schemaKey) as T;
}

// Connection settings
export const DEFAULT_AI_URL: string | null = defaultFor("baseUrl");
export const DEFAULT_AI_URL_FALLBACK: string | null = defaultFor("defaultAiUrl");

// Format strings
export const DEFAULT_THINKER: string | null = defaultFor("thinkerFormat");
export const DEFAULT_TOOL_FMT: string | null = defaultFor("toolFormat");
export const DEFAULT_TOOL_OUTPUT_FMT: string | null = defaultFor("toolOutputFmt");

// Timeouts
export const DEFAULT_CHAT_TIMEOUT_SECS: number = defaultFor("chatTimeout");
export const DEFAULT_EMBEDDINGS_TIMEOUT_SECS: number = defaultFor("embeddingsTimeout");

// Model & tokens
export const DEFAULT_MODEL: string = defaultFor("defaultModel");
export const DEFAULT_MAX_TOKENS: number = defaultFor("maxTokens");
export const DEFAULT_MAX_ITERATIONS: number = defaultFor("maxIterations");
export const DEFAULT_MAX_RETRIES: number = defaultFor("maxRetries");

// UI/display defaults
export const DEFAULT_HIDE_TOOLS: boolean = defaultFor("hideTools");
export const DEFAULT_HIDE_THINKING: boolean = defaultFor("hideThinking");
export const DEFAULT_SHOW_TOKEN_USE: boolean = defaultFor("showTokenUse");
export const DEFAULT_THEME: string | null = defaultFor("theme");

// Task agent defaults
export const DEFAULT_TASK_PROFILE: string | null = defaultFor("taskProfile");
export const DEFAULT_TASK_ROLE: string | null = defaultFor("taskDefaultRole");

// Exit commands
export const DEFAULT_EXIT_COMMANDS: string[] = defaultFor("exitCommands");

// System prompt fallback template
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE: string = defaultFor("systemPromptDefaultTemplate");

// Subcommand & misc
export const DEFAULT_SUBCOMMAND: string | null = defaultFor("defaultSubcommand");
export const DEFAULT_NO_LOG: boolean = defaultFor("noLog");
export const DEFAULT_COMPACT_DEBUG: boolean = defaultFor("compactDebug");
export const DEFAULT_HOOK_TRACE: boolean = defaultFor("hookTrace");

// Path constants (not computed — static defaults for display/fallback)
export const DEFAULT_SKILLS_PATH = "/skills";
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";
// Full default paths (CWD-relative, for display and fallback)
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";
