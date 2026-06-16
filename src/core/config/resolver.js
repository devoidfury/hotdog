/**
 * Generic config resolver.
 *
 * Walks declared layers for each config key and returns the first valid value.
 * Supports compiled schemas (from schema-loader.js) with function predicates/transforms.
 */

import { getNested } from "../../utils/objects.js";

// ── Layer Value Lookup ─────────────────────────────────────────────────────

/**
 * Resolve the raw value for a single layer from the context.
 * Shared between resolveKey() and traceConfigResolution().
 *
 * @param {object} layer - The layer definition.
 * @param {object} context - The resolution context.
 * @returns {*} The raw value from this layer, or undefined.
 */
export function resolveLayerValue(layer, context) {
  if ("default" in layer) {
    return typeof layer.default === "function"
      ? layer.default(context)
      : layer.default;
  }

  switch (layer.source) {
    case "cli":
      return context.cli[layer.key];
    case "config":
      return context.config[layer.key];
    case "env":
      return process.env[layer.key];
    case "provider":
      return getNested(context.provider, layer.path);
    case "providerDefault":
      if (
        context.provider?.models?.length &&
        context.provider.models[0].name
      ) {
        return context.provider.models[0].name;
      }
      return undefined;
    case "profile":
      return getNested(context.profile, layer.key || layer.path);
    case "extension":
      return getNested(context.extensions, layer.key);
    default:
      return undefined;
  }
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
    // Default layer always wins — return immediately, even if null
    if ("default" in layer) {
      return resolveLayerValue(layer, context);
    }

    const value = resolveLayerValue(layer, context);

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
