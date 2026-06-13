// Default configuration constants only — no resolution logic.

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
