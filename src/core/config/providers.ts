import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  resolveConfigDir,
  DEFAULT_SYSTEM_PROMPT_FILENAME,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "./defaults.ts";
import { logger } from "@utils/logger.ts";
import { hotdogFetch } from "@utils/fetch.ts";
import { formatError } from "../error.ts";

export interface ModelConfig {
  name: string;
  temperature: number | null;
  contextLimit: number;
  reasoningEffort?: string;
  /** RoleMapping registry name (e.g. "system-first", "developer"); provider -> global default. */
  roleMapping?: string;
  /** LlmProtocol registry name (e.g. "openai"). */
  protocol?: string;
  /** WireFormat registry name (e.g. "xml"); falls back to provider, then global default. */
  wireFormat?: string;
  /** Server chat-template control tokens to mangle in message content. */
  controlTokens?: string[];
  tags: string[];
  capabilities?: {
    vision?: boolean;
    [key: string]: boolean | undefined;
  };
  /** Declared input modalities (e.g. ["text","image"]); absent = unknown. */
  inputModalities?: string[];
  /** Declared output modalities (e.g. ["image"]); absent = unknown. */
  outputModalities?: string[];
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
  /** RoleMapping registry name (e.g. "system-first", "developer"); provider -> global default. */
  roleMapping?: string;
  protocol?: string;
  wireFormat?: string;
  controlTokens?: string[];
  tags?: string[];
  capabilities?: {
    vision?: boolean;
    [key: string]: boolean | undefined;
  };
  /** Declared input modalities (e.g. ["text","image"]); absent = unknown. */
  inputModalities?: string[];
  /** Declared output modalities (e.g. ["image"]); absent = unknown. */
  outputModalities?: string[];
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
  /** RoleMapping registry name (e.g. "system-first", "developer"); provider -> global default. */
  roleMapping?: string;
  /** Exclude this provider from implicit model-copy fanout (group members that name it explicitly, and pins, still reach it). */
  noSpread?: boolean;
  /** Concurrent task agents allowed on this provider's lane; overrides global taskLanesPerProvider. Below 1 = unlimited. */
  taskLanes?: number;
  protocol?: string;
  wireFormat?: string;
  controlTokens?: string[];
  tags?: string[];
}

/**
 * LlamaSwap /v1/models response format. Plain llama.cpp servers answer the same
 * endpoint with a different shape (see LlamaCompatModel); this parser handles both.
 */
interface LlamaSwapModel {
  id: string;
  owned_by?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  capabilities?: {
    vision?: boolean;
    function_calling?: boolean;
  };
  /** llama.cpp top-level aliases on the model card. */
  aliases?: string[];
  meta?: {
    tags?: string[];
    max_tool_difficulty?: number;
    /** llama.cpp reports the slot context as meta.n_ctx (not context_length). */
    n_ctx?: number;
    llamaswap?: {
      aliases?: string[];
      tags?: string[];
      max_tool_difficulty?: number;
    };
  };
}

/**
 * llama.cpp mirrors Ollama metadata alongside `data` in its /v1/models response:
 * `models[].capabilities` lists "completion" plus "multimodal" when an mtmd projector is loaded.
 */
interface LlamaCompatModel {
  name?: string;
  model?: string;
  capabilities?: string[];
}

/** llama.cpp /props subset used for modality detection. */
interface LlamaCppProps {
  model_alias?: string;
  modalities?: {
    vision?: boolean;
    video?: boolean;
    audio?: boolean;
  };
  /** Older llama.cpp builds listed ["completion","multimodal"] here instead of `modalities`. */
  capabilities?: string[];
}

interface LlamaSwapModelsResponse {
  data: LlamaSwapModel[];
  models?: LlamaCompatModel[];
}

function parseModelsResponse(json: LlamaSwapModelsResponse): ProviderModelEntry[] {
  const entries: ProviderModelEntry[] = [];

  // llama.cpp: ollama-style `models[]` keyed by model name, carrying "multimodal" when vision is on
  const compatCaps = new Map<string, string[]>();
  for (const om of json.models ?? []) {
    const key = om.name ?? om.model;
    if (key) compatCaps.set(key, om.capabilities ?? []);
  }

  for (const m of json.data || []) {
    const llamaCaps = compatCaps.get(m.id) ?? [];
    const hasVision =
      m.capabilities?.vision === true ||
      m.architecture?.input_modalities?.includes("image") ||
      llamaCaps.includes("multimodal");
    const capabilities: { vision?: boolean; toolCalling?: boolean } = {};
    if (hasVision) capabilities.vision = true;
    if (m.capabilities?.function_calling === true) capabilities.toolCalling = true;

    // llama.cpp "multimodal" = mtmd projector loaded, i.e. image input. Materialize it as a
    // modality list too: capabilities.vision covers modelAcceptsImages, but strict consumers
    // (show-me) read only inputModalities.
    const inputModalities =
      m.architecture?.input_modalities ??
      (llamaCaps.includes("multimodal") ? ["text", "image"] : undefined);

    const baseEntry: ProviderModelEntry = {
      name: m.id,
      contextLimit: m.context_length ?? m.meta?.n_ctx,
      tags: [...(m.meta?.tags ?? m.meta?.llamaswap?.tags ?? [])],
      capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
      inputModalities,
      outputModalities: m.architecture?.output_modalities,
      maxToolDifficulty: m.meta?.max_tool_difficulty ?? m.meta?.llamaswap?.max_tool_difficulty,
    };

    entries.push(baseEntry);

    // Add aliases as separate model entries
    for (const alias of [...(m.meta?.llamaswap?.aliases ?? []), ...(m.aliases ?? [])]) {
      entries.push({
        ...baseEntry,
        name: alias,
      });
    }
  }

  return entries;
}

/**
 * Probe llama.cpp /props for modality data. One server serves one model, so the
 * answer applies to every entry that arrived without declared modalities.
 */
function applyLlamaCppProps(entries: ProviderModelEntry[], props: LlamaCppProps): void {
  const vision = props.modalities?.vision === true || props.capabilities?.includes("multimodal") === true;
  if (!vision) return;
  for (const entry of entries) {
    if (entry.inputModalities === undefined) {
      entry.inputModalities = ["text", "image"];
    }
    entry.capabilities = { ...entry.capabilities, vision: true };
  }
}

async function fetchLlamaCppProps(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<LlamaCppProps | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await hotdogFetch(`${baseUrl.replace(/\/+$/, "")}/props`, { headers, signal });
    if (!response.ok) return null;
    return (await response.json()) as LlamaCppProps;
  } catch (e) {
    // Modality detection is progressive enhancement; a missing/failed /props is not fatal.
    logger.debug(`llama.cpp /props probe failed for ${baseUrl}: ${formatError(e)}`);
    return null;
  }
}

/**
 * Outcome of one provider /v1/models request. `reachable` is STATUS-AGNOSTIC by design:
 * ANY HTTP response -- even a 404 from a backend without the route -- proves the socket answers;
 * only a connection-level failure (refused / DNS / timeout) is false.
 */
export interface RemoteModelsOutcome {
  reachable: boolean;
  /** Parsed (llama.cpp /props-enriched) entries from a 2xx body; empty otherwise. */
  entries: ProviderModelEntry[];
  /** Why it failed (network error or HTTP status), for logging. */
  reason?: string;
}

/**
 * GET <base>/v1/models. String concat instead of `new URL()` -- URL resolution
 * drops path-prefixed bases (new URL("v1/models", "http://h:8080/api")
 * -> "http://h:8080/v1/models").
 */
export async function fetchRemoteModelsOutcome(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number = 5000,
): Promise<RemoteModelsOutcome> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await hotdogFetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      // Reachable but no usable payload: up for health purposes, nothing to refresh.
      return { reachable: true, entries: [], reason: `HTTP error! status: ${response.status}` };
    }
    // Headers arrived, the socket answers, so it's reachable.
    try {
      const raw = (await response.json()) as LlamaSwapModelsResponse;
      const entries = parseModelsResponse(raw);

      // llama.cpp with a vision model may expose it only on /props (modalities.vision);
      // probe when the models payload looks like llama.cpp but declared no modalities.
      const looksLikeLlamaCpp =
        raw.models !== undefined || (raw.data ?? []).some((d) => d.owned_by === "llamacpp");
      if (looksLikeLlamaCpp && entries.length > 0 &&
          entries.every((e) => e.inputModalities === undefined && e.capabilities?.vision !== true)) {
        const props = await fetchLlamaCppProps(baseUrl, apiKey, controller.signal);
        if (props) applyLlamaCppProps(entries, props);
      }

      return { reachable: true, entries };
    } catch (e) {
      if (!controller.signal.aborted) {
        return { reachable: true, entries: [], reason: `bad /v1/models payload: ${formatError(e)}` };
      }
      throw e;
    }
  } catch (e) {
    return { reachable: false, entries: [], reason: formatError(e) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchRemoteModels(
  provider: ProviderDef,
  globalBaseUrl?: string,
  globalApiKey?: string,
): Promise<RemoteModelsOutcome> {
  const baseUrl = provider.url || globalBaseUrl;
  if (!baseUrl) return { reachable: false, entries: [] };
  return fetchRemoteModelsOutcome(baseUrl, provider.apiKey || globalApiKey);
}

/**
 * One provider's catalog contribution: static models deep-merged with remote
 * ones when fetchModels:true (local takes priority, remote fills in missing
 * fields), keyed "provider/model". Shared by the boot build (buildModelRegistry)
 * and the health-driven catalog refresh -- pass `prefetchedRemote` to reuse the
 * entries the health probe already fetched, so the sweep costs one request.
 */
export async function buildProviderModels(
  provider: ProviderDef,
  contextLimit: number,
  globals: { baseUrl?: string; apiKey?: string },
  prefetchedRemote?: ProviderModelEntry[],
): Promise<Record<string, ModelConfig>> {
  const registry: Record<string, ModelConfig> = {};
  let models = provider.models || [];

  if (provider.fetchModels) {
    let remoteModels = prefetchedRemote;
    if (!remoteModels) {
      const outcome = await fetchRemoteModels(provider, globals.baseUrl, globals.apiKey);
      // A fetch failure must not crash the registry build; the static models stay.
      if (outcome.reason) {
        logger.error(`Failed to fetch remote models for ${provider.name}: ${outcome.reason}`);
      }
      remoteModels = outcome.entries;
    }
    // Deep merge remote models with local ones. Local takes priority, but remote fills in missing fields
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
      roleMapping: modelEntry.roleMapping ?? provider.roleMapping,
      protocol: modelEntry.protocol ?? provider.protocol,
      wireFormat: modelEntry.wireFormat ?? provider.wireFormat,
      controlTokens: modelEntry.controlTokens ?? provider.controlTokens,
      tags: modelEntry.tags || [],
      capabilities: modelEntry.capabilities || {},
      inputModalities: modelEntry.inputModalities,
      outputModalities: modelEntry.outputModalities,
      maxToolDifficulty: modelEntry.maxToolDifficulty,
    };
  }
  if (models.length === 0 && provider.defaultModel) {
    registry[`${provider.name}/${provider.defaultModel}`] = {
      name: `${provider.name}/${provider.defaultModel}`,
      temperature: provider.temperature ?? null,
      contextLimit: provider.contextLimit || contextLimit,
      roleMapping: provider.roleMapping,
      protocol: provider.protocol,
      wireFormat: provider.wireFormat,
      controlTokens: provider.controlTokens,
      tags: provider.tags || [],
      capabilities: {},
    };
  }

  return registry;
}

export async function buildModelRegistry(
  config: { providers?: ProviderDef[]; baseUrl?: string; apiKey?: string },
  contextLimit: number,
): Promise<Record<string, ModelConfig>> {
  const registry: Record<string, ModelConfig> = {};

  for (const provider of config.providers || []) {
    Object.assign(
      registry,
      await buildProviderModels(provider, contextLimit, {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      }),
    );
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
 * Look up a model entry in the registry by exact key, falling back to a suffix match ("provider/modelName")
 * when the name has no "/". Handles models fetched remotely (fetchModels: true) where the resolved name
 * is bare but the registry key is provider/modelName.
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

/**
 * Whether a model accepts image input. Unknown model (no registry entry) fails closed:
 * sending images to a text-only model is a guaranteed API error.
 * Shared by file-attachment (@refs) and the webui upload path.
 */
export function modelAcceptsImages(
  modelName: string | undefined | null,
  modelRegistry: Record<string, ModelConfig> | undefined | null,
): boolean {
  if (!modelName || !modelRegistry) return false;
  const entry = findModelEntry(modelName, modelRegistry);
  if (!entry) return false;
  return entry.capabilities?.vision === true || (entry.inputModalities?.includes("image") ?? false);
}

/**
 * Whether a catalog entry can serve as the session's main model: when modalities
 * are declared, they must include text in AND text out. Progressive enhancement:
 * entries with no modality data pass (unknown caps never exclude).
 */
export function isTextGenerative(
  entry?: { inputModalities?: string[]; outputModalities?: string[] },
): boolean {
  if (!entry) return true;
  const inMods = entry.inputModalities;
  const outMods = entry.outputModalities;
  if (!inMods?.length && !outMods?.length) return true;
  return (inMods ? inMods.includes("text") : true) &&
    (outMods ? outMods.includes("text") : true);
}

/** Registry keys eligible as the session's main model (text in, text out). */
export function selectableModelKeys(registry: Record<string, unknown>): string[] {
  return Object.keys(registry).filter((k) =>
    isTextGenerative(
      registry[k] as { inputModalities?: string[]; outputModalities?: string[] } | undefined,
    ),
  );
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
  const roleMapping = (entry?.roleMapping as string | undefined) ?? undefined;
  const fromRegistry: ModelConfig = entry
    ? {
        name: entry.name || modelName,
        temperature: entry.temperature ?? null,
        contextLimit: entry.contextLimit ?? contextLimit,
        reasoningEffort: entry.reasoningEffort,
        roleMapping,
        protocol: entry.protocol as string | undefined,
        wireFormat: entry.wireFormat as string | undefined,
        controlTokens: entry.controlTokens as string[] | undefined,
        tags: (entry.tags as string[]) || [],
      }
    : {
        name: modelName,
        temperature: null,
        contextLimit,
        reasoningEffort: undefined,
        roleMapping,
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

export async function initSystemPromptTemplate(
  templatePath?: string,
  configDir?: string,
): Promise<string> {
  const templateFile =
    templatePath ?? path.join(configDir ?? resolveConfigDir(), DEFAULT_SYSTEM_PROMPT_FILENAME);

  try {
    return await fsPromises.readFile(templateFile, "utf-8");
  } catch {
    return DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }
}
