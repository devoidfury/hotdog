/**
 * Declarative config resolution system.
 *
 * Each config key is declared once with its resolution layers (highest priority first).
 * A generic resolver walks the layers and returns the first valid value.
 */

import { join } from "node:path";
import { getNested } from "../utils/objects.js";

/**
 * Resolve a model name to provider/model format.
 * If the name already contains "/", it's assumed to be fully qualified.
 * Otherwise, looks up the model in the provider's models array.
 *
 * @param {string} name - Model name (may or may not include provider prefix).
 * @param {object} [provider] - Provider object with name and models array.
 * @returns {string} Fully qualified model name.
 */
export function resolveModelWithProvider(name, provider) {
  if (!name) return name;
  if (name.includes("/")) return name;
  if (provider?.models) {
    const match = provider.models.find((m) => m.name === name);
    if (match) return `${provider.name}/${name}`;
  }
  return name;
}

// ── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve a single config key by walking its declared layers.
 *
 * @param {string} keyName - The config key name (for debugging).
 * @param {object} schema - The schema entry for this key.
 * @param {object} context - The resolution context (cli, config, provider, etc.).
 * @returns {*} The resolved value.
 */
export function resolveKey(keyName, schema, context) {
  const { layers, transform } = schema;

  for (const layer of layers) {
    let value;

    if ("default" in layer) {
      return typeof layer.default === "function"
        ? layer.default(context)
        : layer.default;
    }

    switch (layer.source) {
      case "cli":
        value = context.cli[layer.key];
        break;
      case "config":
        value = context.config[layer.key];
        break;
      case "env":
        value = process.env[layer.key];
        break;
      case "provider":
        value = getNested(context.provider, layer.path);
        break;
      case "providerDefault":
        // Returns the first model name from provider's models array
        if (
          context.provider?.models?.length &&
          context.provider.models[0].name
        ) {
          value = context.provider.models[0].name;
        }
        break;
      case "profile":
        value = getNested(context.profile, layer.key || layer.path);
        break;
      default:
        // Unknown source, skip
        continue;
    }

    // Layer may specify a predicate — only use this value if predicate passes
    if (value !== undefined && value !== null && value !== "") {
      if (layer.predicate && !layer.predicate(value, context)) continue;

      // Apply layer-level transform first, then schema-level transform
      let result =
        layer.transform && typeof layer.transform === "function"
          ? layer.transform(value, context)
          : value;
      result =
        transform && typeof transform === "function"
          ? transform(result, context)
          : result;
      return result;
    }
  }

  // No layer matched — return undefined (should not happen if schema has a default)
  return undefined;
}

/**
 * Resolve all config keys from a schema against a context.
 *
 * @param {object} schema - The CONFIG_KEYS object mapping key names to schema entries.
 * @param {object} context - The resolution context.
 * @returns {object} Object with all resolved key-value pairs.
 */
export function resolveAll(schema, context) {
  const result = {};

  for (const [keyName, keySchema] of Object.entries(schema)) {
    result[keyName] = resolveKey(keyName, keySchema, context);
  }

  return result;
}

// ── Config Key Schema ──────────────────────────────────────────────────────

/**
 * Declarative schema for config keys.
 *
 * Each key has:
 * - `type`: documentation of the expected type
 * - `layers`: array of resolution layers (highest priority first)
 * - `transform` (optional): post-process the resolved value
 *
 * Layer types:
 * - `{ source: "cli", key: "..." [, predicate] }` — from parsed CLI args
 * - `{ source: "config", key: "..." [, predicate] }` — from config file
 * - `{ source: "env", key: "..." [, predicate] }` — from process.env
 * - `{ source: "provider", path: "..." [, predicate] }` — from resolved provider object
 * - `{ source: "profile", key: "..." [, predicate] }` — from merged profile
 * - `{ default: value | (context) => value }` — fallback value
 */

const CONFIG_KEYS = {
  baseUrl: {
    type: "string",
    layers: [
      { source: "provider", path: "url" },
      { source: "cli", key: "url" },
      { source: "config", key: "aiUrl" },
      { default: "http://ai365.home:9292" },
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

  thinkerFormat: {
    type: "string",
    layers: [
      { source: "cli", key: "thinker" },
      { source: "config", key: "thinker" },
      { default: "[Thinking: {}]" },
    ],
  },

  toolFormat: {
    type: "string",
    layers: [
      { source: "cli", key: "toolfmt" },
      { source: "config", key: "toolfmt" },
      { default: "  → {} {}" },
    ],
  },

  toolOutputFmt: {
    type: "string",
    layers: [
      { source: "cli", key: "toolOutputFmt" },
      { source: "config", key: "toolOutputFmt" },
      { default: "----\n{}\n----" },
    ],
  },

  chatTimeout: {
    type: "number",
    layers: [
      { source: "cli", key: "chatTimeout" },
      { source: "config", key: "chatTimeoutSecs" },
      { default: 600 },
    ],
  },

  embeddingsTimeout: {
    type: "number",
    layers: [
      { source: "cli", key: "embeddingsTimeout" },
      { source: "config", key: "embeddingsTimeoutSecs" },
      { default: 120 },
    ],
  },

  sessionId: {
    type: "string",
    layers: [{ source: "cli", key: "sessionId" }, { default: null }],
  },

  skillsPath: {
    type: "string",
    layers: [
      { source: "cli", key: "skillsPath" },
      { source: "config", key: "skillsPath" },
      {
        default: (ctx) => {
          if (ctx.configDir) {
            return join(ctx.configDir, "skills");
          }
          return "./config/skills";
        },
      },
    ],
  },

  promptsPath: {
    type: "string",
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

  compactDebug: {
    type: "boolean",
    layers: [
      { source: "cli", key: "compactDebug" },
      { source: "config", key: "compactDebug" },
      { default: false },
    ],
  },

  stream: {
    type: "boolean",
    layers: [
      { source: "cli", key: "noStream", transform: (v) => !v },
      { default: true },
    ],
  },

  hideTools: {
    type: "boolean",
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

  showTokenUse: {
    type: "boolean",
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

  // ── Phase 2: Complex values ───────────────────────────────────────────

  theme: {
    type: "string",
    layers: [
      { source: "cli", key: "theme" },
      { source: "config", key: "theme" },
      { default: "dark" },
    ],
  },

  role: {
    type: "string",
    layers: [
      {
        source: "cli",
        key: "role",
      },
      {
        source: "config",
        key: "role",
      },
      {
        source: "profile",
        key: "role",
      },
      { default: "You are an AI coding assistant." },
    ],
  },

  noLog: {
    type: "boolean",
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

  hideThinking: {
    type: "boolean",
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
};

export { CONFIG_KEYS };
