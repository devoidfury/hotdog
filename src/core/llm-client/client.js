// LLM client for communicating with AI providers.
// Provides HTTP transport, streaming (SSE), and retry logic.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_AI_URL, DEFAULT_AI_URL_FALLBACK } from "../config/defaults.js";
import { retryWithBackoff } from "./retry.js";
import { createMarkerMangler } from "../marker-mangler.js";
import { LlmError } from "../error.js";
import { logger } from "../logger.js";

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

/**
 * LLM client for communicating with AI providers.
 * Provides HTTP transport, streaming (SSE), and retry logic.
 */
export class LlmClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - Base URL for API requests
   * @param {string} [options.apiKey] - API key for authentication
   * @param {string} [options.sessionId] - Session ID for affinity
   * @param {boolean} [options.loud] - Log full JSON responses
   * @param {number} options.chatTimeoutSecs - Request timeout in seconds (from resolved config)
   * @param {number} options.maxRetries - Maximum retry attempts (from resolved config)
   * @param {boolean} [options.stream] - Enable streaming responses
   * @param {Array<{name: string, url: string, apiKey?: string}>} [options.providers] - Provider configurations
   * @param {boolean} [options.cancelled] - Cancellation flag
   * @param {Object} [options.markerMangler] - Custom marker mangler for escaping
   */
  constructor(options = {}) {
    if (options.chatTimeoutSecs == null) {
      throw new Error("missing required chatTimeoutSecs");
    }
    if (options.maxRetries == null) {
      throw new Error("missing required maxRetries");
    }
    this.baseUrl =
      options.baseUrl ||
      process.env.AI_URL ||
      DEFAULT_AI_URL ||
      DEFAULT_AI_URL_FALLBACK;
    this.apiKey = options.apiKey || process.env.AI_API_KEY || null;
    this.sessionId = options.sessionId || "";
    this.loud = options.loud || false;
    this.chatTimeoutSecs = options.chatTimeoutSecs;
    this.maxRetries = options.maxRetries;
    this.stream = options.stream !== false;
    this.providers = options.providers || [];
    this.cancelled = false;
    this._mangler =
      options.markerMangler !== undefined
        ? options.markerMangler
        : createMarkerMangler();
  }

  /**
   * Resolve provider-specific settings from a model name.
   * Model names are in `provider/model` format.
   *
   * @param {string} modelName - Model name with optional provider prefix (e.g., "openai/gpt-4").
   * @returns {{url: string, apiKey: string|null}} Provider-specific URL and API key.
   */
  resolveProviderSettings(modelName) {
    const providerName = modelName.split("/")[0];
    const provider = this.providers.find((p) => p.name === providerName);
    if (provider) {
      return {
        url: provider.url || this.baseUrl,
        apiKey: provider.apiKey || this.apiKey,
      };
    }
    return { url: this.baseUrl, apiKey: this.apiKey };
  }

  /**
   * Check connectivity to the AI URL.
   *
   * @returns {Promise<void>} Resolves if the URL is reachable, rejects on error.
   */
  async ping() {
    try {
      const resp = await fetch(this.baseUrl + "/health");
      if (resp.ok) return;
      throw LlmError.Api(`HTTP ${resp.status}`);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw LlmError.Http(e.message);
    }
  }

  /**
   * Escape protected markers in messages before sending to the model.
   * Returns a new array of cloned messages with escaped content.
   * Handles both string content and array content (with image_url parts).
   *
   * @private
   * @param {Array<{role: string, content: string|Array, toolCalls?: Array}>} messages - Messages to escape.
   * @returns {Array} Escaped messages.
   */
  _escapeMessages(messages) {
    if (!this._mangler) return messages;
    return messages.map((msg) => {
      const json = msg.toJSON();
      if (json.content != null) {
        if (Array.isArray(json.content)) {
          // Content is an array of parts (text + image_url)
          json.content = json.content.map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return { ...part, text: this._mangler.escape(part.text) };
            }
            return part; // image_url parts pass through unchanged
          });
        } else if (typeof json.content === "string") {
          json.content = this._mangler.escape(json.content);
        }
      }
      if (json.tool_calls) {
        json.tool_calls = json.tool_calls.map((tc) => {
          const clonedTc = { ...tc };
          if (clonedTc.function) {
            clonedTc.function = { ...clonedTc.function };
            if (clonedTc.function.name)
              clonedTc.function.name = this._mangler.escape(
                clonedTc.function.name,
              );
            if (clonedTc.function.arguments)
              clonedTc.function.arguments = this._mangler.escape(
                clonedTc.function.arguments,
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
   * @param {Array<{role: string, content: string|Array}>} messages - Chat messages.
   * @param {Object} modelConfig - Model configuration.
   * @param {string} modelConfig.name - Model name.
   * @param {number|null} [modelConfig.temperature] - Sampling temperature.
   * @param {number|null} [modelConfig.maxTokens] - Maximum tokens.
   * @param {number|null} [modelConfig.reasoningEffort] - Reasoning effort level.
   * @param {Array} [tools] - Tool definitions.
   * @param {boolean} [stream] - Whether to enable streaming.
   * @returns {Object} OpenAI-compatible request body.
   */
  buildChatRequest(messages, modelConfig, tools, stream = this.stream) {
    const modelName = modelConfig.name.split("/").pop() || modelConfig.name;
    const escapedMessages = this._escapeMessages(messages);
    const request = {
      model: modelName,
      messages: escapedMessages,
      max_tokens: modelConfig.maxTokens,
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
   * @param {Array<{role: string, content: string|Array}>} messages - Chat messages.
   * @param {string} model - Model name.
   * @param {Array} [tools] - Tool definitions.
   * @param {number} [maxTokens] - Maximum tokens.
   * @returns {AsyncGenerator<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Async generator yielding stream events.
   */
  async *chatStream(messages, model, tools = [], maxTokens) {
    const modelConfig = {
      name: model,
      temperature: null,
      maxTokens,
    };
    yield* this.chatStreamWithModelConfig(messages, modelConfig, tools);
  }

  /**
   * Send a chat request with streaming and cancellation support.
   * Uses retryWithBackoff for transient error handling.
   *
   * @param {Array<{role: string, content: string|Array}>} messages - Chat messages.
   * @param {Object} modelConfig - Model configuration.
   * @param {string} modelConfig.name - Model name.
   * @param {number|null} [modelConfig.temperature] - Sampling temperature.
   * @param {number|null} [modelConfig.maxTokens] - Maximum tokens.
   * @param {number|null} [modelConfig.reasoningEffort] - Reasoning effort level.
   * @param {Array} [tools] - Tool definitions.
   * @param {AbortSignal|null} [cancelToken] - AbortSignal for cancellation.
   * @returns {AsyncGenerator<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Async generator yielding stream events.
   */
  async *chatStreamCancellable(
    messages,
    modelConfig,
    tools = [],
    cancelToken = null,
  ) {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    // Build an AbortController for cancellation + timeout.
    // Uses event-based cancellation (no polling) when the cancelToken
    // is an AbortSignal or has a .signal property. Falls back to
    // directly checking .aborted for custom cancel tokens.
    const abortController = new AbortController();
    let removeCancelListener = null;

    if (cancelToken) {
      const onAbort = () => abortController.abort();

      // Prefer standard AbortSignal event listener
      if (
        cancelToken.signal &&
        typeof cancelToken.signal.addEventListener === "function"
      ) {
        cancelToken.signal.addEventListener("abort", onAbort, { once: true });
        removeCancelListener = () =>
          cancelToken.signal.removeEventListener("abort", onAbort);
      } else if (typeof cancelToken.addEventListener === "function") {
        // cancelToken itself is an AbortSignal
        cancelToken.addEventListener("abort", onAbort, { once: true });
        removeCancelListener = () =>
          cancelToken.removeEventListener("abort", onAbort);
      } else if (cancelToken.aborted) {
        // Already aborted — abort immediately
        abortController.abort();
      }
      // If cancelToken has neither addEventListener nor is already aborted,
      // we can't listen for it. The caller can still abort via the agent's
      // cancel() flag which is checked in the stream processing loop.
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
      const response = await retryWithBackoff(
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
   * Send an HTTP request to the chat completions endpoint.
   *
   * @private
   * @param {string} url - API endpoint URL.
   * @param {string|null} apiKey - API key for authentication.
   * @param {Object} request - Request body.
   * @param {AbortSignal} signal - Abort signal for cancellation.
   * @returns {Promise<Response>} HTTP response.
   */
  async _doRequest(url, apiKey, request, signal) {
    const headers = {
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
   * @param {Response} response - HTTP response object.
   * @returns {AsyncGenerator<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Async generator yielding stream events.
   */
  async *_processSSE(response) {
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
        const data = await response.json();
        yield* this._parseStreamData(data);
        return;
      } catch {
        throw LlmError.InvalidResponse(
          `Unexpected Content-Type: ${contentType}`,
        );
      }
    }

    const reader = response.body.getReader();
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
   * @param {Object} data - SSE data object.
   * @returns {Array<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Array of stream events.
   */
  _parseStreamData(data) {
    const events = [];
    const choices = data.choices || [];
    const usage = data.usage;

    for (const choice of choices) {
      const delta = choice.delta || {};

      // Reasoning/thinking content
      if (delta.reasoning_content) {
        let content = delta.reasoning_content;
        if (this._mangler) content = this._mangler.unescape(content);
        events.push({ type: "reasoning", content });
      }

      // Regular content
      if (delta.content) {
        let content = delta.content;
        if (this._mangler) content = this._mangler.unescape(content);
        events.push({ type: "content", content });
      }

      // Tool calls
      const toolCalls = delta.tool_calls || [];
      for (const tc of toolCalls) {
        if (tc.function) {
          let name = tc.function.name;
          let arguments_ = tc.function.arguments;
          if (this._mangler) {
            if (name) name = this._mangler.unescape(name);
            if (arguments_) arguments_ = this._mangler.unescape(arguments_);
          }
          if (name) {
            events.push({
              type: "toolName",
              index: tc.index || 0,
              name,
              toolCallId: tc.id || "",
            });
          }
          if (arguments_) {
            events.push({
              type: "toolArgument",
              index: tc.index || 0,
              arguments: arguments_,
            });
          }
        }
      }

      // Finish reason — emitted on the final chunk.
      // "stop" = normal completion, "tool_calls" = tool calls issued,
      // "length" = hit max token limit (truncated), "content_filter" = filtered.
      if (choice.finish_reason) {
        events.push({ type: "finish", reason: choice.finish_reason });
      }
    }

    // Usage
    if (usage) {
      events.push({ type: "usage", data: usage });
    }

    return events;
  }
}
