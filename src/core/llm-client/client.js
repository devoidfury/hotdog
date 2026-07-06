// LLM client for communicating with AI providers.
// Provides HTTP transport, streaming (SSE), and retry logic.

import {
  DEFAULT_AI_URL,
  DEFAULT_CHAT_TIMEOUT_SECS,
  DEFAULT_MAX_TOKENS,
} from "../config/defaults.js";
import { retryWithBackoff } from "./retry.js";
import { createMarkerMangler } from "../marker-mangler.js";
import { LlmError } from "../error.js";

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
   * @param {number} [options.chatTimeoutSecs] - Request timeout in seconds
   * @param {boolean} [options.stream] - Enable streaming responses
   * @param {Array<{name: string, url: string, apiKey?: string}>} [options.providers] - Provider configurations
   * @param {boolean} [options.cancelled] - Cancellation flag
   * @param {Object} [options.markerMangler] - Custom marker mangler for escaping
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.AI_URL || DEFAULT_AI_URL;
    this.apiKey = options.apiKey || process.env.AI_API_KEY || null;
    this.sessionId = options.sessionId || "";
    this.loud = options.loud || false;
    this.chatTimeoutSecs = options.chatTimeoutSecs || DEFAULT_CHAT_TIMEOUT_SECS;
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
      max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS,
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
   * Send a chat request with retries.
   *
   * @param {Array<{role: string, content: string|Array}>} messages - Chat messages.
   * @param {string} model - Model name.
   * @param {Array} [tools] - Tool definitions.
   * @returns {Promise<Object>} Response with { type: "content", fullText, reasoningContent, toolCalls, usage }.
   */
  async chat(messages, model, tools = []) {
    const modelConfig = {
      name: model,
      temperature: null,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
    const response = await this.chatWithModelConfig(
      messages,
      modelConfig,
      tools,
    );
    if (response.type === "content") {
      return response;
    }
    throw LlmError.InvalidResponse("Unexpected tool calls in chat response");
  }

  /**
   * Send a chat request with streaming. Returns an async generator of StreamEvents.
   *
   * @param {Array<{role: string, content: string|Array}>} messages - Chat messages.
   * @param {string} model - Model name.
   * @param {Array} [tools] - Tool definitions.
   * @returns {AsyncGenerator<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Async generator yielding stream events.
   */
  async *chatStream(messages, model, tools = []) {
    const modelConfig = {
      name: model,
      temperature: null,
      maxTokens: DEFAULT_MAX_TOKENS,
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
      const response = await retryWithBackoff(doRequestWithTimeout, 12, {
        signal: abortController.signal,
      });

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
      "User-Agent": "hotdog/alpha",
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
   * @private
   * @param {Response} response - HTTP response object.
   * @returns {AsyncGenerator<{type: string, content?: string, reasoningContent?: string, name?: string, index?: number, arguments?: string, data?: Object}>} Async generator yielding stream events.
   */
  async *_processSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          let data;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          yield* this._parseStreamData(data);
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
    }

    // Usage
    if (usage) {
      events.push({ type: "usage", data: usage });
    }

    return events;
  }
}
