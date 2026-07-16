// LLM client for communicating with AI providers.
// Provides HTTP transport, streaming (SSE), and retry logic.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { retryWithBackoff } from "./retry.ts";
import { createMarkerMangler, MarkerMangler } from "../marker-mangler.ts";
import { LlmError } from "../error.ts";
import { logger } from "../logger.ts";

// Resolve version from package.json at module load time (cached, not per-request).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, "../../../package.json");
let VERSION = "unknown";
try {
  const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
  VERSION = pkg.version || VERSION;
} catch {
  // Silently fall back to "unknown" if package.json is unreadable.
}

export interface ProviderConfig {
  name: string;
  url: string;
  apiKey?: string | null;
}

export interface ModelConfig {
  name: string;
  temperature: number | null;
  reasoningEffort?: string;
}

export interface LlmClientOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  sessionId?: string;
  loud?: boolean;
  stream?: boolean;
  providers?: ProviderConfig[];
  cancelled?: boolean;
  markerMangler?: MarkerMangler;
}

export interface LlmClientRequiredOptions {
  chatTimeoutSecs: number;
  maxRetries: number;
}

export interface StreamEvent {
  type: string;
  content?: string;
  name?: string;
  index?: number;
  arguments?: string;
  data?: Record<string, unknown>;
  reason?: string;
  toolCallId?: string;
}

/**
 * LLM client for communicating with AI providers.
 * Provides HTTP transport, streaming (SSE), and retry logic.
 */
export class LlmClient {
  baseUrl: string | null;
  apiKey: string | null;
  sessionId: string;
  loud: boolean;
  chatTimeoutSecs: number;
  maxRetries: number;
  stream: boolean;
  providers: ProviderConfig[];
  cancelled: boolean;
  #mangler: MarkerMangler | null;

  /**
   * @param options
   * @param options.baseUrl - Base URL for API requests
   * @param options.apiKey - API key for authentication
   * @param options.sessionId - Session ID for affinity
   * @param options.loud - Log full JSON responses
   * @param options.chatTimeoutSecs - Request timeout in seconds (from resolved config)
   * @param options.maxRetries - Maximum retry attempts (from resolved config)
   * @param options.stream - Enable streaming responses
   * @param options.providers - Provider configurations
   * @param options.cancelled - Cancellation flag
   * @param options.markerMangler - Custom marker mangler for escaping
   */
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
    this.#mangler =
      options.markerMangler !== undefined
        ? options.markerMangler
        : createMarkerMangler();
  }

  /**
   * Get the marker mangler instance (exposed for testing).
   */
  get markerMangler(): MarkerMangler | null {
    return this.#mangler;
  }

  /**
   * Resolve provider-specific settings from a model name.
   * Model names are in `provider/model` format.
   *
   * @param modelName - Model name with optional provider prefix (e.g., "openai/gpt-4").
   * @returns Provider-specific URL and API key.
   */
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

  /**
   * Check connectivity to the AI URL.
   *
   * @returns Resolves if the URL is reachable, rejects on error.
   */
  async ping(): Promise<void> {
    try {
      const url = this.baseUrl ?? "";
      const resp = await fetch(url + "/health");
      if (resp.ok) return;
      throw LlmError.Api(`HTTP ${resp.status}`);
    } catch (e: unknown) {
      if (e instanceof LlmError) throw e;
      throw LlmError.Http((e as Error).message);
    }
  }

  /**
   * Escape protected markers in messages before sending to the model.
   * Returns a new array of cloned messages with escaped content.
   * Handles both string content and array content (with image_url parts).
   *
   * @private
   * @param messages - Messages to escape.
   * @returns Escaped messages.
   */
  _escapeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!this.#mangler) return messages;
    const mangler = this.#mangler;
    return messages.map((msg) => {
      const toJSON = (msg as { toJSON?: () => Record<string, unknown> }).toJSON;
      const json = typeof toJSON === "function"
        ? (toJSON as () => Record<string, unknown>).call(msg)
        : { ...msg };
      if (json.content != null) {
        if (Array.isArray(json.content)) {
          // Content is an array of parts (text + image_url)
          json.content = (json.content as Array<Record<string, unknown>>).map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return { ...part, text: mangler.escape(part.text as string) };
            }
            return part; // image_url parts pass through unchanged
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
            if (clonedTc.function && typeof (clonedTc.function as Record<string, unknown>).arguments === "string")
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

  /**
   * Build a chat request body for the LLM API.
   *
   * @param messages - Chat messages.
   * @param modelConfig - Model configuration.
   * @param tools - Tool definitions.
   * @param stream - Whether to enable streaming.
   * @returns OpenAI-compatible request body.
   */
  buildChatRequest(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<Record<string, unknown>> | null | undefined,
    stream: boolean = this.stream,
  ): Record<string, unknown> {
    const modelName = modelConfig.name.split("/").pop() || modelConfig.name;
    const escapedMessages = this._escapeMessages(messages);
    const request: Record<string, unknown> = {
      model: modelName,
      messages: escapedMessages,
      stream: stream,
    };

    // Only include temperature if it's a valid number (omit null/undefined)
    if (modelConfig.temperature != null) {
      request.temperature = modelConfig.temperature;
    }

    // Only include tool-related fields if tools are provided
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

  /**
   * Send a chat request with streaming. Returns an async generator of StreamEvents.
   *
   * @param messages - Chat messages.
   * @param model - Model name.
   * @param tools - Tool definitions.
   * @returns Async generator yielding stream events.
   */
  async *chatStream(
    messages: Array<Record<string, unknown>>,
    model: string,
    tools: Array<Record<string, unknown>> = [],
  ): AsyncGenerator<StreamEvent> {
    const modelConfig: ModelConfig = {
      name: model,
      temperature: null,
    };
    yield* this.chatStreamWithModelConfig(messages, modelConfig, tools);
  }

  /**
   * Send a chat request with streaming and cancellation support.
   * Uses retryWithBackoff for transient error handling.
   *
   * @param messages - Chat messages.
   * @param modelConfig - Model configuration.
   * @param tools - Tool definitions.
   * @param cancelToken - AbortSignal for cancellation.
   * @returns Async generator yielding stream events.
   */
  async *chatStreamCancellable(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<Record<string, unknown>> = [],
    cancelToken: AbortSignal | null = null,
  ): AsyncGenerator<StreamEvent> {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    // Build an AbortController for cancellation + timeout.
    const abortController = new AbortController();
    let removeCancelListener: (() => void) | null = null;

    if (cancelToken) {
      // If the signal is already aborted, abort immediately — addEventListener
      // won't fire on an already-aborted signal.
      if (cancelToken.aborted) {
        abortController.abort();
      } else {
        const onAbort = () => abortController.abort();
        cancelToken.addEventListener("abort", onAbort, { once: true });
        removeCancelListener = () => cancelToken.removeEventListener("abort", onAbort);
      }
    }

    try {
      // Wrap the request in a timeout
      const doRequestWithTimeout = async () => {
        const timeoutId = setTimeout(
          () => abortController.abort(),
          this.chatTimeoutSecs * 1000,
        );
        try {
          return await this._doRequest(
            url,
            apiKey,
            request,
            abortController.signal,
          );
        } finally {
          clearTimeout(timeoutId);
        }
      };

      // Use retryWithBackoff for transient errors
      const response = await retryWithBackoff<Response>(
        doRequestWithTimeout,
        this.maxRetries,
        {
          signal: abortController.signal,
        },
      );

      yield* this._processSSE(response);
    } finally {
      // Clean up the cancel listener so it doesn't fire after the request completes
      removeCancelListener?.();
    }
  }

  /**
   * Send a chat request with model config.
   * @param messages - Chat messages.
   * @param modelConfig - Model configuration.
   * @param tools - Tool definitions.
   * @returns Async generator yielding stream events.
   */
  async *chatStreamWithModelConfig(
    messages: Array<Record<string, unknown>>,
    modelConfig: ModelConfig,
    tools: Array<Record<string, unknown>> = [],
  ): AsyncGenerator<StreamEvent> {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    const resp = await this._doRequest(url, apiKey, request, null);
    yield* this._processSSE(resp);
  }

  /**
   * Send an HTTP request to the chat completions endpoint.
   *
   * @private
   * @param url - API endpoint URL.
   * @param apiKey - API key for authentication.
   * @param request - Request body.
   * @param signal - Abort signal for cancellation.
   * @returns HTTP response.
   */
  async _doRequest(
    url: string,
    apiKey: string | null,
    request: Record<string, unknown>,
    signal: AbortSignal | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `hotdog/${VERSION}`,
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    if (this.sessionId) headers["x-session-affinity"] = this.sessionId;
    headers["Connection"] = "keep-alive";

    const resp = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw LlmError.Api(`HTTP ${resp.status} (body: ${body})`);
    }
    return resp;
  }

  /**
   * Process an SSE response stream, yielding StreamEvents.
   *
   * Handles:
   *   - Multi-chunk JSON assembly (large payloads split across TCP packets)
   *   - SSE comment lines (`:` prefix)
   *   - Named event types (`event:` field) — only processes `message` events
   *   - Content-Type validation (falls back to JSON parse for non-SSE responses)
   *   - TextDecoder cleanup
   *   - Silent JSON parse failure detection (logs warning on large malformed payloads)
   *
   * @private
   * @param response - HTTP response object.
   * @returns Async generator yielding stream events.
   */
  async *_processSSE(response: Response): AsyncGenerator<StreamEvent> {
    // Content-Type validation — if the response isn't SSE, try to parse it
    // as a single JSON object (some backends return non-streaming responses).
    const contentType =
      typeof response.headers?.get === "function"
        ? response.headers.get("content-type") || ""
        : "";
    const isSse =
      contentType.includes("text/event-stream") ||
      contentType.includes("text/plain") ||
      contentType === ""; // Some backends omit Content-Type for SSE

    if (!isSse) {
      try {
        const data = (await response.json()) as Record<string, unknown>;
        yield* this._parseStreamData(data);
        return;
      } catch {
        throw LlmError.InvalidResponse(
          `Unexpected Content-Type: ${contentType}`,
        );
      }
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let jsonBuffer = "";
    let currentEvent = "message"; // Default SSE event type

    // Threshold for distinguishing incomplete JSON from real parse errors.
    // A single SSE data line for chat completions rarely exceeds this;
    // if we accumulate beyond it and still can't parse, it's likely a backend bug.
    const MAX_JSON_BUFFER = 500_000;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip empty lines (event boundary in SSE spec)
          if (!trimmed) continue;

          // SSE comment lines — spec says clients must ignore them
          if (trimmed.startsWith(":")) continue;

          // Event type field — track for filtering
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7);
            continue;
          }

          // Only process data lines for the default event type ("message")
          // Other event types (e.g., "ping", "heartbeat") are ignored.
          if (!trimmed.startsWith("data: ")) continue;
          if (currentEvent !== "message" && currentEvent !== "") continue;

          // Signal end of stream
          if (trimmed === "data: [DONE]") {
            // Flush any remaining jsonBuffer on [DONE]
            if (jsonBuffer) {
              try {
                const data = JSON.parse(jsonBuffer);
                yield* this._parseStreamData(data);
              } catch {
                logger.warn(
                  `[sse] malformed JSON on [DONE] flush (${jsonBuffer.length} chars)`,
                );
              }
              jsonBuffer = "";
            }
            continue;
          }

          // Accumulate data payload into jsonBuffer for multi-chunk assembly.
          // Large tool call arguments or content chunks can span multiple
          // data: lines when split across TCP packet boundaries.
          const payload = trimmed.slice(6);

          // Strategy: try parsing the payload on its own first (common case —
          // each data: line is a complete JSON object). If that fails and we
          // already have a jsonBuffer, try appending (multi-chunk assembly).
          // If both fail, the payload is garbage — reset and move on.
          try {
            const data = JSON.parse(payload);
            yield* this._parseStreamData(data);
          } catch {
            // Payload alone isn't valid JSON — try multi-chunk assembly
            jsonBuffer += payload;

            try {
              const data = JSON.parse(jsonBuffer);
              yield* this._parseStreamData(data);
              jsonBuffer = ""; // Reset on successful parse
            } catch {
              // Still can't parse — could be incomplete JSON or real error.
              // If we've accumulated a large buffer, it's likely a backend bug.
              if (jsonBuffer.length > MAX_JSON_BUFFER) {
                logger.warn(
                  `[sse] malformed JSON (${jsonBuffer.length} chars): ${jsonBuffer.slice(0, 100)}...`,
                );
                jsonBuffer = ""; // Reset to avoid memory leak
              }
              // Otherwise keep accumulating — the JSON is just split across chunks
            }
          }
        }
      }

      // Handle any remaining jsonBuffer at EOF (stream ended without [DONE])
      if (jsonBuffer) {
        try {
          const data = JSON.parse(jsonBuffer);
          yield* this._parseStreamData(data);
        } catch {
          logger.warn(
            `[sse] truncated JSON at EOF (${jsonBuffer.length} chars)`,
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse a single SSE data event into StreamEvents.
   *
   * Stream event shapes:
   *   { type: "content", content }
   *   { type: "reasoning", content }
   *   { type: "toolName", index, name, toolCallId }  — toolCallId is the OpenAI `id` field
   *   { type: "toolArgument", index, arguments }
   *   { type: "usage", data }
   *   { type: "finish", reason }  — finish_reason from the model (stop, tool_calls, length)
   *
   * @private
   * @param data - SSE data object.
   * @returns Array of stream events.
   */
  _parseStreamData(data: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    const choices = (data.choices as Array<Record<string, unknown>>) || [];
    const usage = data.usage as Record<string, unknown> | undefined;

    for (const choice of choices) {
      const delta = (choice.delta as Record<string, unknown>) || {};

      // Reasoning/thinking content
      const reasoningContent = delta.reasoning_content as string | null | undefined;
      if (reasoningContent) {
        let content = reasoningContent;
        if (this.#mangler) content = this.#mangler.unescape(content) ?? "";
        events.push({ type: "reasoning", content: content as string });
      }

      // Regular content
      const contentVal = delta.content as string | null | undefined;
      if (contentVal) {
        let content = contentVal;
        if (this.#mangler) content = this.#mangler.unescape(content) ?? "";
        events.push({ type: "content", content: content as string });
      }

      // Tool calls
      const toolCalls = (delta.tool_calls as Array<Record<string, unknown>>) || [];
      for (const tc of toolCalls) {
        if (tc.function) {
          let name = (tc.function as Record<string, unknown>).name as string | null | undefined;
          let arguments_ = (tc.function as Record<string, unknown>).arguments as string | null | undefined;
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

      // Finish reason — emitted on the final chunk.
      // "stop" = normal completion, "tool_calls" = tool calls issued,
      // "length" = hit max token limit (truncated), "content_filter" = filtered.
      if (choice.finish_reason) {
        events.push({ type: "finish", reason: choice.finish_reason as string });
      }
    }

    // Usage
    if (usage) {
      events.push({ type: "usage", data: usage });
    }

    return events;
  }
}
