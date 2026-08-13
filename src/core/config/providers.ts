/**
 * Provider and model registry.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import { cwd } from "node:process";

import {
  DEFAULT_SYSTEM_PROMPT_FILENAME,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "./defaults.ts";
import { logger } from "../logger.ts";
import { hotdogFetch } from "@utils/fetch.ts";

export interface ModelConfig {
  name: string;
  temperature: number | null;
  contextLimit: number;
  reasoningEffort?: string;
  tags: string[];
  /**
   * Model capabilities (e.g., vision, tool use).
   */
  capabilities?: {
    vision?: boolean;
    [key: string]: boolean | undefined;
  };
  /**
   * Maximum tool difficulty for this model.
   * When set, only tools with difficulty <= this value are exposed.
   * Useful for smaller models that may struggle with complex tools.
   */
  maxToolDifficulty?: number;
  [key: string]: unknown;
}

export interface ProviderModelEntry {
  name: string;
  temperature?: number;
  contextLimit?: number;
  reasoning_effort?: string;
  reasoningEffort?: string;
  tags?: string[];
  /** Model capabilities (e.g., vision, tool use). */
  capabilities?: {
    vision?: boolean;
    [key: string]: boolean | undefined;
  };
  /** Maximum tool difficulty for this model (1-5). */
  maxToolDifficulty?: number;
}

export interface ProviderDef {
  name: string;
  url?: string;
  apiKey?: string;
  fetchModels?: boolean;
  models: ProviderModelEntry[];
  defaultModel?: string;
  temperature?: number;
  contextLimit?: number;
  tags?: string[];
}

/**
 * LlamaSwap /v1/models response format.
 */
interface LlamaSwapModel {
  id: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
  };
  capabilities?: {
    vision?: boolean;
  };
  meta?: {
    tags?: string[];
    max_tool_difficulty?: number;
    llamaswap?: {
      aliases?: string[];
      tags?: string[];
      max_tool_difficulty?: number;
    };
  };
}

interface LlamaSwapModelsResponse {
  data: LlamaSwapModel[];
}

/**
 * Parse a /v1/models response into ProviderModelEntry[].
 */
function parseModelsResponse(json: LlamaSwapModelsResponse): ProviderModelEntry[] {
  const entries: ProviderModelEntry[] = [];

  for (const m of json.data || []) {
    const hasVision =
      m.capabilities?.vision === true ||
      m.architecture?.input_modalities?.includes("image");

    const baseEntry: ProviderModelEntry = {
      name: m.id,
      contextLimit: m.context_length,
      tags: [...(m.meta?.tags ?? m.meta?.llamaswap?.tags ?? [])],
      capabilities: hasVision ? { vision: true } : undefined,
      maxToolDifficulty: m.meta?.max_tool_difficulty ?? m.meta?.llamaswap?.max_tool_difficulty,
    };

    entries.push(baseEntry);

    // Add aliases as separate model entries
    if (m.meta?.llamaswap?.aliases) {
      for (const alias of m.meta.llamaswap.aliases) {
        entries.push({
          ...baseEntry,
          name: alias,
        });
      }
    }
  }

  return entries;
}

/**
 * Fetch models from a provider's /v1/models endpoint.
 * Falls back to globalBaseUrl/globalApiKey when the provider has no explicit values.
 * Times out after 5 seconds.
 */
async function fetchRemoteModels(
  provider: ProviderDef,
  globalBaseUrl?: string,
  globalApiKey?: string,
): Promise<ProviderModelEntry[]> {
  const baseUrl = provider.url || globalBaseUrl;
  if (!baseUrl) return [];

  try {
    const url = new URL("v1/models", baseUrl).toString();

    const headers: Record<string, string> = {};
    const apiKey = provider.apiKey || globalApiKey;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await hotdogFetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return parseModelsResponse(await response.json() as LlamaSwapModelsResponse);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e) {
    // Log error but don't crash the registry build
    logger.error(`Failed to fetch remote models for ${provider.name}`, {
      error: e instanceof Error ? { message: e.message, stack: e.stack } : String(e),
    });
    return [];
  }
}

/**
 * Build a model registry from config providers.
 */
export async function buildModelRegistry(
  config: { providers?: ProviderDef[]; baseUrl?: string; apiKey?: string },
  contextLimit: number,
): Promise<Record<string, ModelConfig>> {
  const registry: Record<string, ModelConfig> = {};
  const providers = config.providers || [];

  for (const provider of providers) {
    let models = provider.models || [];

    if (provider.fetchModels) {
      const remoteModels = await fetchRemoteModels(provider, config.baseUrl, config.apiKey);
      // Deep merge remote models with local ones: local takes priority, but remote fills in missing fields
      const localByName = new Map(models.map((m) => [m.name, m]));
      for (const rm of remoteModels) {
        const local = localByName.get(rm.name);
        if (local) {
          // Merge provider properties: local values take priority, remote fills gaps
          localByName.set(rm.name, {
            ...rm,
            ...local,
          });
        } else {
          localByName.set(rm.name, rm);
        }
      }
      models = [...localByName.values()];
    }

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
        capabilities: modelEntry.capabilities || {},
        maxToolDifficulty: modelEntry.maxToolDifficulty,
      };
    }
    // Also add provider-level models (models defined at provider level)
    if (models.length === 0 && provider.defaultModel) {
      registry[`${provider.name}/${provider.defaultModel}`] = {
        name: `${provider.name}/${provider.defaultModel}`,
        temperature: provider.temperature ?? null,
        contextLimit: provider.contextLimit || contextLimit,
        tags: provider.tags || [],
        capabilities: {},
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
  // Direct lookup (e.g. "provider/modelName")
  let entry = modelRegistry[modelName];
  // Fallback: if modelName has no "/" and isn't found, try "provider/modelName"
  // This handles the case where models are fetched remotely (fetchModels: true)
  // with an empty local models array, so resolveModel returns just the model name
  // but the registry key is provider/modelName.
  if (!entry && !modelName.includes("/")) {
    for (const key of Object.keys(modelRegistry)) {
      if (key.endsWith(`/${modelName}`)) {
        entry = modelRegistry[key];
        break;
      }
    }
  }
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
        const cwdConfig = path.resolve(cwd(), "config");
        try {
          await fsPromises.access(cwdConfig);
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
