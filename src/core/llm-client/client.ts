import { retryWithBackoff } from "./retry.ts";
import { parseSse } from "./sse-parser.ts";
import { MarkerMangler } from "../marker-mangler.ts";
import { LlmError } from "../error.ts";
import { ToolDef } from "../extensions/tool-registry.ts";
import { hotdogFetch } from "@utils/fetch.ts";

import pkg from "@package.json" with { type: "json" };
import { ModelConfig, ProviderDef } from "@core/config/providers.ts";

export interface LlmClientOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  sessionId?: string;
  loud?: boolean;
  stream?: boolean;
  providers?: ProviderDef[];
  cancelled?: boolean;
  markerMangler?: MarkerMangler | null;
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

export class LlmClient {
  baseUrl: string | null;
  apiKey: string | null;
  sessionId: string;
  loud: boolean;
  chatTimeoutSecs: number;
  maxRetries: number;
  stream: boolean;
  providers: ProviderDef[];
  cancelled: boolean;
  #mangler: MarkerMangler | null;

  constructor(options: LlmClientOptions & LlmClientRequiredOptions) {
    this.baseUrl = options.baseUrl || null;
    this.apiKey = options.apiKey || null;
    this.sessionId = options.sessionId || "";
    this.loud = options.loud || false;
    this.chatTimeoutSecs = options.chatTimeoutSecs;
    this.maxRetries = options.maxRetries;
    this.stream = options.stream !== false;
    this.providers = options.providers || [];
    this.cancelled = false;
    this.#mangler = options.markerMangler !== undefined ? options.markerMangler : new MarkerMangler();
  }

  get markerMangler(): MarkerMangler | null {
    return this.#mangler;
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

  async ping(): Promise<void> {
    try {
      const url = this.baseUrl ?? "";
      const resp = await hotdogFetch(url + "/health");
      if (resp.ok) return;
      throw LlmError.Api(`HTTP ${resp.status}`);
    } catch (e: unknown) {
      if (e instanceof LlmError) throw e;
      throw LlmError.Http((e as Error).message);
    }
  }

  _escapeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!this.#mangler) return messages;
    const mangler = this.#mangler;
    return messages.map((msg) => {
      // Skip mangling system messages — they contain the authoritative tag names
      // the agent should use. Mangling them breaks the contract.
      if (msg.role === "system") return msg;
      const toJSON = (msg as { toJSON?: () => Record<string, unknown> }).toJSON;
      const json =
        typeof toJSON === "function" ? (toJSON as () => Record<string, unknown>).call(msg) : { ...msg };
      if (json.content != null) {
        if (Array.isArray(json.content)) {
          json.content = (json.content as Array<Record<string, unknown>>).map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return { ...part, text: mangler.escape(part.text as string) };
            }
            return part;
          });
        } else if (typeof json.content === "string") {
          json.content = mangler.escape(json.content);
        }
      }
      if (json.tool_calls) {
        json.tool_calls = (json.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const clonedTc: Record<string, unknown> = { ...tc };
          const fn = clonedTc.function as Record<string, unknown> | undefined;
          if (fn) {
            clonedTc.function = { ...fn };
            if (clonedTc.function && typeof (clonedTc.function as Record<string, unknown>).name === "string")
              (clonedTc.function as Record<string, unknown>).name = mangler.escape(
                (clonedTc.function as Record<string, unknown>).name as string,
              );
            if (
              clonedTc.function &&
              typeof (clonedTc.function as Record<string, unknown>).arguments === "string"
            )
              (clonedTc.function as Record<string, unknown>).arguments = mangler.escape(
                (clonedTc.function as Record<string, unknown>).arguments as string,
              );
          }
          return clonedTc;
        });
      }
      return json;
    });
  }

  buildChatRequest(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<ToolDef> | null | undefined,
    stream: boolean = this.stream,
  ): Record<string, unknown> {
    const modelName = modelConfig.name.split("/").pop() || modelConfig.name;
    const escapedMessages = this._escapeMessages(messages);
    const request: Record<string, unknown> = {
      model: modelName,
      messages: escapedMessages,
      stream: stream,
    };

    if (modelConfig.temperature != null) {
      request.temperature = modelConfig.temperature;
    }

    if (tools && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = "auto";
      request.parallel_tool_calls = true;
    }

    if (modelConfig.reasoningEffort != null) {
      request.reasoning_effort = modelConfig.reasoningEffort;
    }
    if (stream) {
      request.stream_options = { include_usage: true };
    }
    return request;
  }

  async *chatStreamCancellable(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<ToolDef> = [],
    cancelToken: AbortSignal | null = null,
    sessionId?: string,
  ): AsyncGenerator<StreamEvent> {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
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
          effectiveSessionId,
          this.chatTimeoutSecs * 1000,
        );

      const response = await retryWithBackoff<Response>(doRequestWithTimeout, this.maxRetries, {
        signal: abortController.signal,
      });

      yield* this._processSSE(response);
    } finally {
      removeCancelListener?.();
    }
  }

  async *chatStreamWithModelConfig(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<ToolDef> = [],
    sessionId?: string,
  ): AsyncGenerator<StreamEvent> {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    const resp = await this._doRequest(url, apiKey, request, null, sessionId || this.sessionId);
    yield* this._processSSE(resp);
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
    sessionId?: string,
    timeoutMs?: number | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `hotdog/${pkg.version}`,
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const effectiveSessionId = sessionId || this.sessionId;
    if (effectiveSessionId) headers["x-session-affinity"] = effectiveSessionId;
    headers["Connection"] = "keep-alive";

    let resp: Response;
    try {
      resp = await hotdogFetch(
        `${url}/v1/chat/completions`,
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

  async *_processSSE(response: Response): AsyncGenerator<StreamEvent> {
    const contentType =
      typeof response.headers?.get === "function" ? response.headers.get("content-type") || "" : "";
    const isSse =
      contentType.includes("text/event-stream") || contentType.includes("text/plain") || contentType === "";

    if (!isSse) {
      try {
        const data = (await response.json()) as Record<string, unknown>;
        yield* this._parseStreamData(data);
        return;
      } catch {
        throw LlmError.InvalidResponse(`Unexpected Content-Type: ${contentType}`);
      }
    }

    if (!response.body) {
      throw LlmError.InvalidResponse("Response body is null");
    }
    for await (const data of parseSse(response.body)) {
      yield* this._parseStreamData(data as Record<string, unknown>);
    }
  }

  _parseStreamData(data: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    const choices = (data.choices as Array<Record<string, unknown>>) || [];
    const usage = data.usage as Record<string, unknown> | undefined;

    for (const choice of choices) {
      const delta = (choice.delta as Record<string, unknown>) || {};

      const reasoningContent = delta.reasoning_content as string | null | undefined;
      if (reasoningContent) {
        let content = reasoningContent;
        if (this.#mangler) content = this.#mangler.unescape(content) ?? "";
        if (content) events.push({ type: "reasoning", content });
      }

      const contentVal = delta.content as string | null | undefined;
      if (contentVal) {
        let content = contentVal;
        if (this.#mangler) content = this.#mangler.unescape(content) ?? "";
        if (content) events.push({ type: "content", content });
      }

      const toolCalls = (delta.tool_calls as Array<Record<string, unknown>>) || [];
      for (const tc of toolCalls) {
        if (tc.function) {
          const fn = tc.function as Record<string, unknown>;
          let name = fn.name as string | null | undefined;
          let arguments_ = fn.arguments as string | null | undefined;
          if (this.#mangler) {
            if (name) name = this.#mangler.unescape(name);
            if (arguments_) arguments_ = this.#mangler.unescape(arguments_);
          }
          if (name) {
            events.push({
              type: "toolName",
              index: (tc.index as number) || 0,
              name,
              toolCallId: (tc.id as string) || "",
            });
          }
          if (arguments_) {
            events.push({
              type: "toolArgument",
              index: (tc.index as number) || 0,
              arguments: arguments_,
            });
          }
        }
      }

      const finishReason = choice.finish_reason as string | undefined;
      if (finishReason) {
        events.push({ type: "finish", reason: finishReason });
      }
    }

    if (usage) {
      events.push({ type: "usage", data: usage });
    }

    return events;
  }
}
