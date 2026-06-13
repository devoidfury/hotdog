/**
 * Generic config resolver.
 *
 * Walks declared layers for each config key and returns the first valid value.
 */

import { getNested } from "../../utils/objects.js";
import { CONFIG_SCHEMA } from "./schema.js";

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
      case "extension":
        value = getNested(context.extensions, layer.key);
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
 * @param {object} schema - The CONFIG_SCHEMA object mapping key names to schema entries.
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

/**
 * Resolve model name with priority: profile → CLI → provider default → config → default.
 */
export function resolveModel(
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
