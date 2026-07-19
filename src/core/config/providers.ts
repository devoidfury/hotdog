/**
 * Provider and model registry.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_SYSTEM_PROMPT_FILENAME,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "./defaults.ts";

export interface ModelConfig {
  name: string;
  temperature: number | null;
  contextLimit: number;
  reasoningEffort?: string;
  tags: string[];
}

export interface ProviderModelEntry {
  name: string;
  temperature?: number;
  contextLimit?: number;
  reasoning_effort?: string;
  reasoningEffort?: string;
  tags?: string[];
}

export interface ProviderDef {
  name: string;
  models: ProviderModelEntry[];
  defaultModel?: string;
  temperature?: number;
  contextLimit?: number;
  tags?: string[];
}

/**
 * Build a model registry from config providers.
 */
export function buildModelRegistry(
  config: { providers?: ProviderDef[] },
  contextLimit: number,
): Record<string, ModelConfig> {
  const registry: Record<string, ModelConfig> = {};
  const providers = config.providers || [];

  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      registry[modelName] = {
        name: modelName,
        temperature: modelEntry.temperature ?? null,
        contextLimit: modelEntry.contextLimit || contextLimit,
        reasoningEffort:
          modelEntry.reasoning_effort ||
          modelEntry.reasoningEffort ||
          undefined,
        tags: modelEntry.tags || [],
      };
    }
    // Also add provider-level models (models defined at provider level)
    if (models.length === 0 && provider.defaultModel) {
      registry[`${provider.name}/${provider.defaultModel}`] = {
        name: `${provider.name}/${provider.defaultModel}`,
        temperature: provider.temperature ?? null,
        contextLimit: provider.contextLimit || contextLimit,
        tags: provider.tags || [],
      };
    }
  }

  return registry;
}

/**
 * Resolve the active provider from CLI args and config.
 */
export function resolveProvider(
  cli: { provider?: string },
  config: { defaultProvider?: string; providers?: ProviderDef[] },
): ProviderDef | null {
  const providerName = cli.provider || config.defaultProvider;
  const providers = config.providers || [];

  if (!providerName) return null;
  return providers.find((p) => p.name === providerName) ?? null;
}

/**
 * Resolve model config from the registry with runtime overrides.
 */
export function resolveModelConfig(
  modelName: string,
  modelRegistry: Record<string, {
    name?: string;
    temperature?: number | null;
    contextLimit?: number;
    reasoningEffort?: string;
    [key: string]: unknown;
  }>,
  contextLimit: number,
  reasoningEffort: string | undefined,
): ModelConfig {
  const entry = modelRegistry[modelName];
  const fromRegistry: ModelConfig = entry ? {
    name: entry.name || modelName,
    temperature: entry.temperature ?? null,
    contextLimit: entry.contextLimit ?? contextLimit,
    reasoningEffort: entry.reasoningEffort,
    tags: (entry.tags as string[]) || [],
  } : {
    name: modelName,
    temperature: null,
    contextLimit,
    reasoningEffort: undefined,
    tags: [],
  };

  // Runtime override via /reasoning command takes priority
  if (reasoningEffort !== undefined) {
    return {
      ...fromRegistry,
      reasoningEffort,
    };
  }

  return fromRegistry;
}

// ── System Prompt Template ─────────────────────────────────────────────

let cachedSystemPromptTemplate: string | null = null;

/**
 * Reset the cached system prompt template (useful for testing).
 */
export function resetSystemPromptCache(): void {
  cachedSystemPromptTemplate = null;
}

/**
 * Initialize (load) the system prompt template from disk.
 */
export async function initSystemPromptTemplate(
  templatePath?: string,
  cliConfigDir?: string,
  resolveConfigDirFn?: (cliConfigDir?: string) => string,
): Promise<string> {
  if (cachedSystemPromptTemplate) return cachedSystemPromptTemplate;

  let templateFile = templatePath;
  if (!templateFile) {
    let configDir: string;
    if (resolveConfigDirFn) {
      configDir = resolveConfigDirFn(cliConfigDir);
    } else {
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
          const envConfigDir = process.env.HOTDOG_CONFIG_DIR;
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
    cachedSystemPromptTemplate = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }

  return cachedSystemPromptTemplate;
}
