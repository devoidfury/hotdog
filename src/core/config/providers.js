/**
 * Provider and model registry.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT_FILENAME,
} from "./defaults.js";

/**
 * Build a model registry from config providers.
 * Accepts a config object with a `providers` array.
 * Returns a map of model_name -> { name, temperature, maxTokens }
 *
 * @param {object} config - Config object with providers array.
 * @returns {object} Model registry map.
 */
export function buildModelRegistry(config) {
  const registry = {};
  const providers = config.providers || [];

  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      registry[modelName] = {
        name: modelName,
        temperature: modelEntry.temperature,
        maxTokens: modelEntry.maxTokens || DEFAULT_MAX_TOKENS,
        reasoningEffort:
          modelEntry.reasoning_effort ||
          modelEntry.reasoningEffort ||
          undefined,
      };
    }
    // Also add provider-level models (models defined at provider level)
    // If provider has no models array, use default model settings
    if (models.length === 0 && provider.defaultModel) {
      registry[`${provider.name}/${provider.defaultModel}`] = {
        name: `${provider.name}/${provider.defaultModel}`,
        temperature: provider.temperature,
        maxTokens: provider.maxTokens || DEFAULT_MAX_TOKENS,
      };
    }
  }

  return registry;
}

/**
 * Resolve the active provider from CLI args and config.
 *
 * @param {object} cli - Parsed CLI arguments.
 * @param {object} config - Config from file.
 * @returns {object|null} Resolved provider object or null.
 */
export function resolveProvider(cli, config) {
  const providerName = cli.provider || config.defaultProvider;
  const providers = config.providers || [];

  if (!providerName) return null;
  return providers.find((p) => p.name === providerName) ?? null;
}

// ── System Prompt Template ─────────────────────────────────────────────

let cachedSystemPromptTemplate = null;

/**
 * Reset the cached system prompt template (useful for testing).
 */
export function resetSystemPromptCache() {
  cachedSystemPromptTemplate = null;
}

/**
 * Initialize (load) the system prompt template from disk.
 * Falls back to a minimal template if the file doesn't exist.
 *
 * @param {string} [templatePath] - Explicit template path.
 * @param {string} [cliConfigDir] - Config directory from CLI.
 * @param {Function} [resolveConfigDirFn] - Config dir resolver (to avoid circular import).
 * @returns {Promise<string>} System prompt template string.
 */
export async function initSystemPromptTemplate(
  templatePath,
  cliConfigDir,
  resolveConfigDirFn,
) {
  if (cachedSystemPromptTemplate) return cachedSystemPromptTemplate;

  let templateFile = templatePath;
  if (!templateFile) {
    // Use provided resolver or fallback to default resolution
    let configDir;
    if (resolveConfigDirFn) {
      configDir = resolveConfigDirFn(cliConfigDir);
    } else {
      // Inline fallback resolution to avoid circular import
      if (cliConfigDir) {
        configDir = path.resolve(cliConfigDir);
      } else {
        const { cwd } = await import("node:process");
        const cwdConfig = path.resolve(cwd(), "config");
        try {
          const fs = await import("node:fs");
          fs.accessSync(cwdConfig);
          configDir = cwdConfig;
        } catch {
          const envConfigDir = process.env.OA_AGENT_CONFIG_DIR;
          if (envConfigDir) {
            configDir = path.resolve(envConfigDir);
          } else {
            configDir = "./config";
          }
        }
      }
    }
    templateFile = path.join(configDir, DEFAULT_SYSTEM_PROMPT_FILENAME);
  }

  try {
    cachedSystemPromptTemplate = await fsPromises.readFile(
      templateFile,
      "utf-8",
    );
  } catch {
    // Fallback: minimal template
    cachedSystemPromptTemplate = `{{ role }}\n\n{{ body }}\n{% for chunk in chunks %}{{ chunk.content }}{% endfor %}`;
  }

  return cachedSystemPromptTemplate;
}
