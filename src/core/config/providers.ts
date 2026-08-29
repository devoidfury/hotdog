import fsPromises from "node:fs/promises";
import path from "node:path";
import { cwd } from "node:process";
import { DEFAULT_SYSTEM_PROMPT_FILENAME, DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "./defaults.ts";
import { logger } from "../logger.ts";
import { hotdogFetch } from "@utils/fetch.ts";

/**
 * Wire format for chat requests (per-model: chat templates are per-model,
 * even on the same backend). Defaults to "system-first".
 */
export type WireFormatKind = "system-first" | "developer";

export interface ModelConfig {
  name: string;
  temperature: number | null;
  contextLimit: number;
  reasoningEffort?: string;
  wireFormat?: WireFormatKind;
  /** LlmProtocol registry name (e.g. "openai"). */
  protocol?: string;
  /** ToolFormat registry name (e.g. "xml"); falls back to provider, then global default. */
  toolFormat?: string;
  /** Server chat-template control tokens to mangle in message content. */
  controlTokens?: string[];
  tags: string[];
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
  wireFormat?: WireFormatKind;
  protocol?: string;
  toolFormat?: string;
  controlTokens?: string[];
  tags?: string[];
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
  wireFormat?: WireFormatKind;
  protocol?: string;
  toolFormat?: string;
  controlTokens?: string[];
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

function parseModelsResponse(json: LlamaSwapModelsResponse): ProviderModelEntry[] {
  const entries: ProviderModelEntry[] = [];

  for (const m of json.data || []) {
    const hasVision = m.capabilities?.vision === true || m.architecture?.input_modalities?.includes("image");

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

async function fetchRemoteModels(
  provider: ProviderDef,
  globalBaseUrl?: string,
  globalApiKey?: string,
): Promise<ProviderModelEntry[]> {
  const baseUrl = provider.url || globalBaseUrl;
  if (!baseUrl) return [];

  try {
    // String concat, not new URL(): URL resolution drops path-prefixed bases
    // (new URL("v1/models", "http://h:8080/api") -> "http://h:8080/v1/models"),
    // and the chat request path is built the same concat way in llm-client.
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;

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
      return parseModelsResponse((await response.json()) as LlamaSwapModelsResponse);
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
        reasoningEffort: modelEntry.reasoning_effort || modelEntry.reasoningEffort || undefined,
        wireFormat: modelEntry.wireFormat ?? provider.wireFormat,
        protocol: modelEntry.protocol ?? provider.protocol,
        toolFormat: modelEntry.toolFormat ?? provider.toolFormat,
        controlTokens: modelEntry.controlTokens ?? provider.controlTokens,
        tags: modelEntry.tags || [],
        capabilities: modelEntry.capabilities || {},
        maxToolDifficulty: modelEntry.maxToolDifficulty,
      };
    }
    if (models.length === 0 && provider.defaultModel) {
      registry[`${provider.name}/${provider.defaultModel}`] = {
        name: `${provider.name}/${provider.defaultModel}`,
        temperature: provider.temperature ?? null,
        contextLimit: provider.contextLimit || contextLimit,
        wireFormat: provider.wireFormat,
        protocol: provider.protocol,
        toolFormat: provider.toolFormat,
        controlTokens: provider.controlTokens,
        tags: provider.tags || [],
        capabilities: {},
      };
    }
  }

  return registry;
}

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
 * Look up a model entry in the registry by exact key, falling back to a
 * suffix match ("provider/modelName") when the name has no "/".
 * Handles models fetched remotely (fetchModels: true) where the resolved
 * name is bare but the registry key is provider/modelName.
 */
export function findModelEntry<T extends Partial<ModelConfig>>(
  modelName: string,
  modelRegistry: Record<string, T>,
): T | undefined {
  let entry = modelRegistry[modelName];
  if (!entry && !modelName.includes("/")) {
    for (const key of Object.keys(modelRegistry)) {
      if (key.endsWith(`/${modelName}`)) {
        entry = modelRegistry[key];
        break;
      }
    }
  }
  return entry;
}

export function resolveModelConfig(
  modelName: string,
  modelRegistry: Record<
    string,
    {
      name?: string;
      temperature?: number | null;
      contextLimit?: number;
      reasoningEffort?: string;
      [key: string]: unknown;
    }
  >,
  contextLimit: number,
  reasoningEffort: string | undefined,
): ModelConfig {
  const entry = findModelEntry(modelName, modelRegistry);
  const wireFormat = (entry?.wireFormat as WireFormatKind | undefined) ?? undefined;
  const fromRegistry: ModelConfig = entry
    ? {
        name: entry.name || modelName,
        temperature: entry.temperature ?? null,
        contextLimit: entry.contextLimit ?? contextLimit,
        reasoningEffort: entry.reasoningEffort,
        wireFormat,
        protocol: entry.protocol as string | undefined,
        toolFormat: entry.toolFormat as string | undefined,
        controlTokens: entry.controlTokens as string[] | undefined,
        tags: (entry.tags as string[]) || [],
      }
    : {
        name: modelName,
        temperature: null,
        contextLimit,
        reasoningEffort: undefined,
        wireFormat,
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

export function resetSystemPromptCache(): void {
  cachedSystemPromptTemplate = null;
}

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
          configDir = envConfigDir ? path.resolve(envConfigDir) : "./config";
        }
      }
    }
    templateFile = path.join(configDir, DEFAULT_SYSTEM_PROMPT_FILENAME);
  }

  try {
    cachedSystemPromptTemplate = await fsPromises.readFile(templateFile, "utf-8");
  } catch {
    cachedSystemPromptTemplate = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }

  return cachedSystemPromptTemplate;
}
