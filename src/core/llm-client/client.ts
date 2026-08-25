import { retryWithBackoff } from "./retry.ts";
import { MarkerMangler } from "../marker-mangler.ts";
import type { Message } from "../context/message.ts";
import { LlmError } from "../error.ts";
import { ToolDef } from "../extensions/tool-registry.ts";
import {
  createToolFormatRegistry,
  resolveToolFormatId,
  ToolFormat,
  type ToolFormatRegistry,
} from "../extensions/tool-format.ts";
import { xmlToolFormat } from "../extensions/tool-format-xml.ts";
import type { LlmProtocol, ProtocolContext } from "./protocol.ts";
import { createLlmProtocolRegistry, resolveProtocolId, type LlmProtocolRegistry } from "./protocol.ts";
import { openaiProtocol } from "./openai-protocol.ts";
import { hotdogFetch } from "@utils/fetch.ts";

import { ModelConfig, ProviderDef } from "../config/providers.ts";

export interface LlmClientOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  sessionId?: string;
  loud?: boolean;
  stream?: boolean;
  providers?: ProviderDef[];
  cancelled?: boolean;
  markerMangler?: MarkerMangler | null;
  /** Global toolFormat default (core config); provider/model entries override. */
  toolFormat?: string | null;
  /** ToolFormat registry (defaults to a registry with the xml format). */
  toolFormatRegistry?: ToolFormatRegistry | null;
  /** LlmProtocol registry (defaults to a registry with the openai protocol). */
  llmProtocolRegistry?: LlmProtocolRegistry | null;
  /** Base delay in ms before first retry (default: 1000). Useful for fast tests. */
  retryBaseDelayMs?: number;
  /** Health-check (ping) timeout in seconds (default: 5). */
  healthCheckTimeoutSecs?: number;
}

export interface LlmClientRequiredOptions {
  chatTimeoutSecs: number;
  maxRetries: number;
}

export type StreamEvent =
  | { type: "content"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "toolName"; index: number; name: string; toolCallId: string }
  | { type: "toolArgument"; index: number; arguments: string }
  | { type: "usage"; data: Record<string, unknown> }
  | { type: "finish"; reason: string };


function createDefaultProtocolRegistry(): LlmProtocolRegistry {
  const reg = createLlmProtocolRegistry();
  reg.register(openaiProtocol);
  return reg;
}

function createDefaultToolFormatRegistry(): ToolFormatRegistry {
  const reg = createToolFormatRegistry();
  reg.register(xmlToolFormat);
  return reg;
}

export class LlmClient {
  baseUrl: string | null;
  apiKey: string | null;
  sessionId: string;
  loud: boolean;
  chatTimeoutSecs: number;
  healthCheckTimeoutSecs: number;
  maxRetries: number;
  stream: boolean;
  providers: ProviderDef[];
  cancelled: boolean;
  defaultToolFormat?: string;
  retryBaseDelayMs?: number;
  #toolFormatRegistry: ToolFormatRegistry;
  #protocolRegistry: LlmProtocolRegistry;
  #mangler: MarkerMangler | null;

  constructor(options: LlmClientOptions & LlmClientRequiredOptions) {
    this.baseUrl = options.baseUrl || null;
    this.apiKey = options.apiKey || null;
    this.sessionId = options.sessionId || "";
    this.loud = options.loud || false;
    this.chatTimeoutSecs = options.chatTimeoutSecs;
    this.healthCheckTimeoutSecs = options.healthCheckTimeoutSecs ?? 5;
    this.maxRetries = options.maxRetries;
    this.stream = options.stream !== false;
    this.retryBaseDelayMs = options.retryBaseDelayMs;
    this.providers = options.providers || [];
    this.defaultToolFormat = options.toolFormat || undefined;
    this.#toolFormatRegistry = options.toolFormatRegistry ?? createDefaultToolFormatRegistry();
    this.#protocolRegistry = options.llmProtocolRegistry ?? createDefaultProtocolRegistry();
    this.cancelled = false;
    this.#mangler = options.markerMangler !== undefined ? options.markerMangler : new MarkerMangler();
  }

  get markerMangler(): MarkerMangler | null {
    return this.#mangler;
  }

  /** The ToolFormat active for a model (model -> provider -> global chain). */
  toolFormatFor(modelConfig: ModelConfig): ToolFormat {
    const id = resolveToolFormatId(modelConfig, this.providers, this.defaultToolFormat);
    const format = this.#toolFormatRegistry.get(id);
    if (!format) {
      throw new LlmError(`Unknown tool format "${id}"`, "config");
    }
    return format;
  }

  /** The session's ToolFormat registry (used by the agent loop to resolve seam renders). */
  get toolFormatRegistry(): ToolFormatRegistry {
    return this.#toolFormatRegistry;
  }

  /** The ToolFormat's marker names for the resolved model (mangler union). */
  toolFormatMarkers(modelConfig: ModelConfig): string[] {
    return this.toolFormatFor(modelConfig).markers;
  }

  /** Resolve the LlmProtocol for a model (model -> provider -> default chain). */
  protocolFor(modelConfig: ModelConfig): LlmProtocol {
    const id = resolveProtocolId(modelConfig, this.providers);
    const protocol = this.#protocolRegistry.get(id);
    if (!protocol) {
      throw new LlmError(`Unknown LLM protocol "${id}"`, "config");
    }
    return protocol;
  }

  #buildProtocolContext(modelConfig: ModelConfig): ProtocolContext {
    let url = this.baseUrl || "";
    let apiKey = this.apiKey;
    try {
      const settings = this.resolveProviderSettings(modelConfig.name);
      url = settings.url;
      apiKey = settings.apiKey;
    } catch {
      // No URL configured yet; the protocol can still build the body.
    }
    return {
      mangler: this.#mangler,
      baseUrl: url,
      apiKey,
      sessionId: this.sessionId,
    };
  }

  /**
   * Grow the mangler's protected set for a model: active ToolFormat markers +
   * controlTokens. Existing aliases stay stable (addPrefixes only adds new
   * prefixes), so context stored raw stays valid across model switches.
   */
  ensureManglerCovers(modelConfig: ModelConfig): void {
    if (!this.#mangler) return;
    const tokens = [
      ...this.toolFormatMarkers(modelConfig),
      ...(modelConfig.controlTokens || []),
    ];
    this.#mangler.addPrefixes(tokens);
  }

  resolveProviderSettings(modelName: string): { url: string; apiKey: string | null } {
    const providerName = modelName.split("/")[0];
    const provider = this.providers.find((p) => p.name === providerName);
    let url: string | null;
    let apiKey: string | null;
    if (provider) {
      url = provider.url || this.baseUrl;
      apiKey = provider.apiKey || this.apiKey;
    } else {
      url = this.baseUrl;
      apiKey = this.apiKey;
    }
    if (!url) {
      throw new LlmError(
        "No AI URL configured. Set a URL via --ai-url, aiUrl in config, or provider.url.",
        "config",
      );
    }
    return { url, apiKey };
  }

  /** Health-check the LLM provider for the model (or the default). */
  async ping(modelName?: string): Promise<void> {
    try {
      const base = (
        modelName
          ? this.resolveProviderSettings(modelName).url
          : this.baseUrl ?? ""
      ).replace(/\/+$/, "");
      const resp = await hotdogFetch(base + "/health", undefined, this.healthCheckTimeoutSecs * 1000);
      if (resp.ok) return;
      throw LlmError.Api(`HTTP ${resp.status}`);
    } catch (e: unknown) {
      if (e instanceof LlmError) throw e;
      if (LlmClient.isAbortError(e))
        throw LlmError.Timeout(`health check timed out after ${this.healthCheckTimeoutSecs}s`);
      throw LlmError.Http((e as Error).message);
    }
  }

  buildChatRequest(
    messages: Message[],
    modelConfig: ModelConfig,
    tools: Array<ToolDef> | null | undefined,
    stream: boolean = this.stream,
  ): Record<string, unknown> {
    return this.#buildRequest(messages, modelConfig, tools || null, stream).body;
  }

  /** Build the protocol request (path + body) for a model. */
  #buildRequest(
    messages: Message[],
    modelConfig: ModelConfig,
    tools: Array<ToolDef> | null,
    stream: boolean,
  ): { path: string; body: Record<string, unknown> } {
    this.ensureManglerCovers(modelConfig);
    const protocol = this.protocolFor(modelConfig);
    const ctx = this.#buildProtocolContext(modelConfig);
    const { path, body } = protocol.buildRequest(messages, modelConfig, tools, stream, ctx);
    return { path, body: body as Record<string, unknown> };
  }

  async *chatStreamCancellable(
    messages: Message[],
    modelConfig: ModelConfig,
    tools: Array<ToolDef> = [],
    cancelToken: AbortSignal | null = null,
    sessionId?: string,
  ): AsyncGenerator<StreamEvent> {
    const { path, body: request } = this.#buildRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    const abortController = new AbortController();
    let removeCancelListener: (() => void) | null = null;

    if (cancelToken) {
      if (cancelToken.aborted) {
        abortController.abort();
      } else {
        const onAbort = () => abortController.abort();
        cancelToken.addEventListener("abort", onAbort, { once: true });
        removeCancelListener = () => cancelToken.removeEventListener("abort", onAbort);
      }
    }

    try {
      const effectiveSessionId = sessionId || this.sessionId;
      // The chat timeout is enforced per-attempt via hotdogFetch's built-in
      // timeoutMs (an independent AbortSignal.timeout), NOT by aborting the
      // shared abortController. Aborting the shared controller would poison
      // every subsequent retry attempt with an already-aborted signal.
      // The shared abortController is exclusively for user cancellation.
      const doRequestWithTimeout = () =>
        this._doRequest(
          url,
          apiKey,
          request,
          abortController.signal,
          modelConfig,
          path,
          effectiveSessionId,
          this.chatTimeoutSecs * 1000,
        );

      const response = await retryWithBackoff<Response>(doRequestWithTimeout, this.maxRetries, {
        signal: abortController.signal,
        baseDelayMs: this.retryBaseDelayMs,
      });

      yield* this._processSSE(response, modelConfig);
    } finally {
      removeCancelListener?.();
    }
  }

  /**
   * Classify a raw fetch rejection.
   *
   * Bun rejects an aborted fetch with the aborting signal's reason:
   * `TimeoutError` (DOMException) for `AbortSignal.timeout()` and
   * `AbortError` (DOMException) for a manual `controller.abort()`.
   */
  static isAbortError(e: unknown): boolean {
    return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
  }

  async _doRequest(
    url: string,
    apiKey: string | null,
    request: Record<string, unknown>,
    signal: AbortSignal | null,
    modelConfig: ModelConfig,
    path: string,
    sessionId?: string,
    timeoutMs?: number | null,
  ): Promise<Response> {
    // The protocol owns both the path (from buildRequest) and the headers;
    // the ctx carries the *resolved* url/apiKey (provider-level overrides
    // applied) so buildHeaders authenticates with the right key.
    const effectiveSessionId = sessionId || this.sessionId;
    const protocol = this.protocolFor(modelConfig);
    const ctx: ProtocolContext = {
      mangler: this.#mangler,
      baseUrl: url,
      apiKey,
      sessionId: effectiveSessionId || "",
    };
    const headers = protocol.buildHeaders(ctx);

    let resp: Response;
    try {
      resp = await hotdogFetch(
        `${url}${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal,
        },
        timeoutMs ?? undefined,
      );
    } catch (e: unknown) {
      // Translate raw fetch failures into LlmError so retryWithBackoff
      // classifies them: http/timeout are transient and retried, cancelled
      // is rethrown immediately.
      if (e instanceof LlmError) throw e;
      if (LlmClient.isAbortError(e)) {
        // User cancellation aborts the shared signal; the per-attempt
        // timeout uses an independent signal inside hotdogFetch.
        if (signal?.aborted) {
          throw LlmError.Cancelled("request was cancelled");
        }
        if (timeoutMs != null) {
          throw LlmError.Timeout(`Chat request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw LlmError.Cancelled("request was aborted");
      }
      // Network failures (ECONNREFUSED, DNS, TLS, etc.) are transient.
      throw LlmError.Http(e instanceof Error ? e.message : String(e));
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw LlmError.Api(`HTTP ${resp.status} (body: ${body})`);
    }
    return resp;
  }

  async *_processSSE(response: Response, modelConfig: ModelConfig): AsyncGenerator<StreamEvent> {
    const protocol = this.protocolFor(modelConfig);
    const ctx: ProtocolContext = {
      mangler: this.#mangler,
      baseUrl: this.baseUrl || "",
      apiKey: this.apiKey,
      sessionId: this.sessionId,
    };
    yield* protocol.parseStream(response, ctx);
  }

}
