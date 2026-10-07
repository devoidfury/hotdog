// STT target resolution for push-to-talk (webui mic + CLI dictation).
//
// Mirrors show-me's imageModel pattern:
//   - An explicit `sttUrl` (full OpenAI-compatible transcriptions endpoint)
//     wins and skips the registry entirely; `sttModel`, if set, is the
//     multipart model field.
//   - Without sttUrl, the model registry is consulted: `sttModel` pins a
//     registry entry (which must declare audio input); empty AUTO-selects
//     the first entry declaring "audio" input and "text" output. Entries
//     with absent modality data never auto-pick (unknown capabilities must
//     not hijack transcription; same strictness as show-me).
//   - Registry mode derives the endpoint from the model's provider via
//     LlmClient.resolveProviderSettings -- the same base URL and transport
//     key every other request uses -- so an API-key-protected llama-swap
//     needs no credentials in the STT config.

import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

export const TRANSCRIPTIONS_API_PATH = "/v1/audio/transcriptions";

export interface SttTarget {
  /** Full transcriptions endpoint URL. */
  url: string;
  /** Sent as the multipart `model` field; null omits it. */
  model: string | null;
  /** Authorization header carrying the provider key; null when unauthenticated. */
  authHeader: string | null;
}

interface RegistryEntryLike {
  name?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  [key: string]: unknown;
}

export interface SttSettingsLike {
  sttUrl?: string | null;
  sttModel?: string | null;
  modelRegistry?: Record<string, RegistryEntryLike> | null;
}

/**
 * Structural slice of LlmClient so tests can pass a duck-typed fake
 * (show-me declares ImageChatClient for the same reason).
 */
export interface SttProviderResolver {
  resolveProviderSettings(name: string): { url: string; apiKey: string | null };
}

/** Registry key for a bare or provider-qualified name (findModelEntry's matching, key-returning). */
function findRegistryKey(
  registry: Record<string, RegistryEntryLike>,
  name: string,
): { key: string; entry: RegistryEntryLike } | null {
  const direct = registry[name];
  if (direct) return { key: name, entry: direct };
  if (!name.includes("/")) {
    for (const key of Object.keys(registry)) {
      if (key.endsWith(`/${name}`)) return { key, entry: registry[key]! };
    }
  }
  return null;
}

/** Resolve the transcriptions target, or null when no usable backend exists. */
export function resolveSttTarget(
  settings: SttSettingsLike | null | undefined,
  llmClient: SttProviderResolver,
): SttTarget | null {
  if (!settings) return null;
  const sttModel = settings.sttModel || null;

  if (settings.sttUrl) {
    return { url: settings.sttUrl, model: sttModel, authHeader: null };
  }

  const registry = settings.modelRegistry;
  if (!registry) return null;

  let key: string | null = null;
  let entry: RegistryEntryLike | null = null;

  if (sttModel) {
    const found = findRegistryKey(registry, sttModel);
    if (!found) {
      logger.debug(`stt: pinned model "${sttModel}" not in the registry; speech-to-text disabled`);
      return null;
    }
    if (!found.entry.inputModalities?.includes("audio")) {
      logger.debug(`stt: pinned model "${sttModel}" does not declare audio input; speech-to-text disabled`);
      return null;
    }
    ({ key, entry } = found);
  } else {
    // Deterministic AUTO: first match in registry insertion order (provider
    // declaration order), no sorting -- same rule as show-me.
    for (const [k, e] of Object.entries(registry)) {
      if (!e || typeof e !== "object") continue;
      if (!e.inputModalities?.includes("audio")) continue;
      if (!e.outputModalities?.includes("text")) continue;
      key = k;
      entry = e;
      logger.debug(`stt: auto-selected audio model "${e.name ?? k}"`);
      break;
    }
  }
  if (!key) return null;

  try {
    const { url, apiKey } = llmClient.resolveProviderSettings(key);
    // Wire model name: registry key minus its provider prefix (show-me does
    // the same for the Images API).
    const wireName = (entry?.name || key).split("/").pop() || key;
    return {
      url: `${url.replace(/\/+$/, "")}${TRANSCRIPTIONS_API_PATH}`,
      model: wireName,
      authHeader: apiKey ? `Bearer ${apiKey}` : null,
    };
  } catch (err) {
    logger.debug(`stt: provider resolution failed: ${formatError(err)}`);
    return null;
  }
}
