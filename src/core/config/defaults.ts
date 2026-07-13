/**
 * Default configuration constants — sourced from core.config.json.
 *
 * This module exports only static path constants and runtime fallback values.
 * All configurable defaults are resolved by the config layer directly from the schema.
 * Components receive resolved values from callers — do not import DEFAULT_* constants.
 */

// Path constants (static defaults for display/fallback — not schema-configurable)
export const DEFAULT_PROFILES_SUBPATH = "profiles";
export const DEFAULT_CONFIG_FILENAME = "defaults.json";
export const DEFAULT_SYSTEM_PROMPT_FILENAME = "system_prompt.md";

// Full default paths (CWD-relative, for display and fallback)
export const DEFAULT_PROFILES_PATH = "./config/profiles";
export const DEFAULT_PROMPTS_PATH = "./config/prompts";

// Runtime fallback values (exempt from the "no DEFAULT_* in components" rule)
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE: string =
  "{{ role }}\n\n{{ body }}\n{% for chunk in chunks %}{{ chunk.content }}{% endfor %}";
