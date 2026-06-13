/**
 * Unified config schema — single source of truth for all config values.
 *
 * Merges:
 * - All CONFIG_KEYS from config-resolution.js
 * - All defaults from getDefaultConfig() in config.js
 * - CLI flag metadata for deriving CLI flags
 *
 * Each key has:
 * - `type`: documentation of the expected type
 * - `layers`: array of resolution layers (highest priority first)
 * - `transform` (optional): post-process the resolved value
 * - `cliFlag` (optional): CLI flag metadata for deriving flag definitions
 *
 * Layer types:
 * - `{ source: "cli", key: "..." [, predicate, transform] }` — from parsed CLI args
 * - `{ source: "config", key: "..." [, predicate, transform] }` — from config file
 * - `{ source: "env", key: "..." [, predicate, transform] }` — from process.env
 * - `{ source: "provider", path: "..." [, predicate, transform] }` — from resolved provider object
 * - `{ source: "providerDefault" [, predicate, transform] }` — first model from provider
 * - `{ source: "profile", key: "..." [, predicate, transform] }` — from merged profile
 * - `{ source: "extension", key: "..." [, predicate, transform] }` — from extension config
 * - `{ default: value | (context) => value }` — fallback value
 */

import { join } from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_AI_URL,
  DEFAULT_THINKER,
  DEFAULT_TOOL_FMT,
  DEFAULT_TOOL_OUTPUT_FMT,
  DEFAULT_ROLE,
  DEFAULT_CHAT_TIMEOUT_SECS,
  DEFAULT_EMBEDDINGS_TIMEOUT_SECS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PROFILES_PATH,
  DEFAULT_PROMPTS_PATH,
} from "./defaults.js";

export const CONFIG_SCHEMA = {
  // ── Core connection settings ──────────────────────────────────────────

  baseUrl: {
    type: "string",
    layers: [
      { source: "provider", path: "url" },
      { source: "cli", key: "url" },
      { source: "config", key: "aiUrl" },
      { default: DEFAULT_AI_URL },
    ],
  },

  apiKey: {
    type: "string",
    layers: [
      { source: "provider", path: "apiKey" },
      { source: "cli", key: "apiKey" },
      { source: "config", key: "apiKey" },
      { source: "env", key: "AI_API_KEY" },
      { default: null },
    ],
  },

  // ── Format strings ────────────────────────────────────────────────────

  thinkerFormat: {
    type: "string",
    cliFlag: { short: "-t", long: "--thinker", type: "string" },
    layers: [
      { source: "cli", key: "thinker" },
      { source: "config", key: "thinker" },
      { default: DEFAULT_THINKER },
    ],
  },

  toolFormat: {
    type: "string",
    cliFlag: { long: "--toolfmt", type: "string" },
    layers: [
      { source: "cli", key: "toolfmt" },
      { source: "config", key: "toolfmt" },
      { default: DEFAULT_TOOL_FMT },
    ],
  },

  toolOutputFmt: {
    type: "string",
    cliFlag: { long: "--tool-output-fmt", type: "string" },
    layers: [
      { source: "cli", key: "toolOutputFmt" },
      { source: "config", key: "toolOutputFmt" },
      { default: DEFAULT_TOOL_OUTPUT_FMT },
    ],
  },

  // ── Timeouts ──────────────────────────────────────────────────────────

  chatTimeout: {
    type: "number",
    cliFlag: { long: "--chat-timeout", type: "number" },
    layers: [
      { source: "cli", key: "chatTimeout" },
      { source: "config", key: "chatTimeoutSecs" },
      { default: DEFAULT_CHAT_TIMEOUT_SECS },
    ],
  },

  embeddingsTimeout: {
    type: "number",
    cliFlag: { long: "--embeddings-timeout", type: "number" },
    layers: [
      { source: "cli", key: "embeddingsTimeout" },
      { source: "config", key: "embeddingsTimeoutSecs" },
      { default: DEFAULT_EMBEDDINGS_TIMEOUT_SECS },
    ],
  },

  // ── Session ───────────────────────────────────────────────────────────

  sessionId: {
    type: "string",
    cliFlag: { short: "-s", long: "--session-id", type: "string" },
    layers: [{ source: "cli", key: "sessionId" }, { default: null }],
  },

  // ── Paths ─────────────────────────────────────────────────────────────

  skillsPath: {
    type: "string",
    cliFlag: { long: "--skills-path", type: "string" },
    layers: [
      { source: "cli", key: "skillsPath" },
      { source: "config", key: "skillsPath" },
      {
        default: (ctx) => {
          if (ctx.configDir) {
            return join(ctx.configDir, "skills");
          }
          return "/skills";
        },
      },
    ],
  },

  promptsPath: {
    type: "string",
    cliFlag: { long: "--prompts-path", type: "string" },
    layers: [
      { source: "cli", key: "promptsPath" },
      { source: "config", key: "promptsPath" },
      {
        default: (ctx) => {
          if (ctx.configDir) {
            return join(ctx.configDir, "prompts");
          }
          return "./config/prompts";
        },
      },
    ],
  },

  // ── Debug / logging ───────────────────────────────────────────────────

  compactDebug: {
    type: "boolean",
    cliFlag: { long: "--compact-debug", type: "boolean" },
    layers: [
      { source: "cli", key: "compactDebug" },
      { source: "config", key: "compactDebug" },
      { default: false },
    ],
  },

  noLog: {
    type: "boolean",
    cliFlag: { long: "--no-log", type: "boolean" },
    layers: [
      {
        source: "cli",
        key: "noLog",
        predicate: (v) => v !== undefined && v !== false,
        transform: () => true,
      },
      {
        source: "env",
        key: "OA_AGENT_LOG",
        predicate: (v) => v === "false",
        transform: () => false,
      },
      {
        source: "env",
        key: "OA_AGENT_NO_LOG",
        predicate: (v) => v === "1",
        transform: () => true,
      },
      { source: "config", key: "noLog" },
      { default: false },
    ],
  },

  showTokenUse: {
    type: "boolean",
    cliFlag: { long: "--tokens", type: "boolean" },
    layers: [
      { source: "cli", key: "tokens", transform: () => true },
      {
        source: "config",
        key: "showTokenUse",
        predicate: (v) => v !== false,
        transform: () => true,
      },
      { default: true },
    ],
  },

  // ── Streaming / display ───────────────────────────────────────────────

  stream: {
    type: "boolean",
    cliFlag: { long: "--no-stream", type: "boolean" },
    layers: [
      { source: "cli", key: "noStream", transform: (v) => !v },
      { default: true },
    ],
  },

  hideTools: {
    type: "boolean",
    cliFlag: { long: "--show-tools", type: "boolean" },
    layers: [
      {
        source: "cli",
        key: "hideTools",
        predicate: (v) => v === false,
        transform: () => false,
      },
      { source: "config", key: "hideTools" },
      { default: true },
    ],
  },

  hideThinking: {
    type: "boolean",
    cliFlag: { long: "--hide-thinking", type: "boolean" },
    layers: [
      {
        source: "cli",
        key: "hideThinking",
        predicate: (v) => v === true,
        transform: () => true,
      },
      {
        source: "cli",
        key: "hideThinking",
        predicate: (v) => v === false,
        transform: () => false,
      },
      {
        source: "config",
        key: "hideThinking",
        predicate: (v) => v === true,
        transform: () => true,
      },
      {
        source: "config",
        key: "hideThinking",
        predicate: (v) => v === false,
        transform: () => false,
      },
      { default: false },
    ],
  },

  useColors: {
    type: "boolean",
    cliFlag: { long: "--colors", type: "boolean" },
    layers: [
      {
        source: "cli",
        key: "noColors",
        predicate: (v) => v === true,
        transform: () => false,
      },
      {
        source: "cli",
        key: "colors",
        predicate: (v) => v !== undefined,
        transform: (v) => !!v,
      },
      {
        source: "config",
        key: "colors",
        predicate: (v) => v !== undefined && v !== null,
        transform: (v) => {
          // isColorPalette check — if it's a palette object, treat as true
          if (
            typeof v === "object" &&
            ("thinking" in v || "tool_call" in v || "tool_result" in v)
          )
            return true;
          return !!v;
        },
      },
      { default: true },
    ],
  },

  // ── Theme ─────────────────────────────────────────────────────────────

  theme: {
    type: "string",
    cliFlag: { long: "--theme", type: "string" },
    layers: [
      {
        source: "cli",
        key: "theme",
        predicate: (v) => v?.trim().length > 0,
        transform: (v) => v.trim(),
      },
      {
        source: "config",
        key: "theme",
        predicate: (v) => v?.trim().length > 0,
        transform: (v) => v.trim(),
      },
      { default: "dark" },
    ],
  },

  // ── Role ──────────────────────────────────────────────────────────────

  role: {
    type: "string",
    cliFlag: { long: "--role", type: "string" },
    layers: [
      {
        source: "cli",
        key: "role",
        predicate: (v) => v?.trim().length > 0,
        transform: (v) => v.trim(),
      },
      {
        source: "config",
        key: "role",
        predicate: (v) => v?.trim().length > 0,
        transform: (v) => v.trim(),
      },
      {
        source: "profile",
        key: "role",
        predicate: (v) => v?.trim().length > 0,
        transform: (v) => v.trim(),
      },
      { default: "You are an AI coding assistant." },
    ],
  },

  // ── Aspects ───────────────────────────────────────────────────────────

  aspects: {
    type: "array",
    layers: [
      {
        source: "profile",
        key: "aspects",
        predicate: (v) => Array.isArray(v) && v.length > 0,
      },
      { default: [] },
    ],
  },

  // ── Extension config layers (available for extensions to use) ─────────

  coreTools: {
    type: "object",
    layers: [
      { source: "extension", key: "coreTools" },
      { source: "config", key: "coreTools" },
      { default: {} },
    ],
  },

  compaction: {
    type: "object",
    layers: [
      { source: "extension", key: "compaction" },
      { source: "config", key: "compaction" },
      { default: {} },
    ],
  },
};

/**
 * Generate CLI flag definitions from the schema.
 * Returns an array of flag objects compatible with the CLI parser.
 *
 * @param {object} schema - The CONFIG_SCHEMA object.
 * @returns {Array<object>} Array of CLI flag definitions.
 */
export function cliFlagsFromSchema(schema) {
  const flags = [];
  for (const [key, def] of Object.entries(schema)) {
    if (def.cliFlag) {
      flags.push({
        key,
        short: def.cliFlag.short || null,
        long: def.cliFlag.long,
        type: def.cliFlag.type || def.type,
        hasValue: def.cliFlag.type !== "boolean",
        description: def.cliFlag.description || "",
      });
    }
  }
  return flags;
}
