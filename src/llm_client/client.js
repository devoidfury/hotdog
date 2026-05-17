// LLM client for communicating with AI providers.
// Provides HTTP transport, streaming (SSE), and retry logic.

import {
  DEFAULT_AI_URL,
  DEFAULT_CHAT_TIMEOUT_SECS,
  DEFAULT_MAX_TOKENS,
} from "../config.js";
import { retryWithBackoff } from "./retry.js";
import { createMarkerMangler } from "../marker_mangler.js";

export class LlmError extends Error {
  constructor(message, type = "unknown") {
    super(message);
    this.type = type;
  }

  static Http(msg) {
    return new LlmError(msg, "http");
  }

  static Api(msg) {
    return new LlmError(msg, "api");
  }

  static Timeout(msg) {
    return new LlmError(msg, "timeout");
  }

  static Cancelled(msg) {
    return new LlmError(msg, "cancelled");
  }

  static InvalidResponse(msg) {
    return new LlmError(msg, "invalid_response");
  }

  static isCancelled(err) {
    return err instanceof LlmError && err.type === "cancelled";
  }
}

/**
 * LLM client builder.
 */
export class LlmClient {
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
   */
  resolveProviderSettings(modelName) {
    const providerName = modelName.split("/")[0];
    const provider = this.providers.find((p) => p.name === providerName);
    if (provider) {
      return { url: provider.url, apiKey: provider.apiKey };
    }
    return { url: this.baseUrl, apiKey: this.apiKey };
  }

  /**
   * Check connectivity to the AI URL.
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
   */
  _escapeMessages(messages) {
    if (!this._mangler) return messages;
    return messages.map((msg) => {
      const json = msg.toJSON();
      if (json.content !== undefined && json.content !== null) {
        json.content = this._mangler.escape(json.content);
      }
      if (json.tool_calls) {
        json.tool_calls = json.tool_calls.map((tc) => {
          const clonedTc = { ...tc };
          if (clonedTc.function) {
            const clonedFn = { ...clonedTc.function };
            if (clonedFn.name) clonedFn.name = this._mangler.escape(clonedFn.name);
            if (clonedFn.arguments) clonedFn.arguments = this._mangler.escape(clonedFn.arguments);
            clonedTc.function = clonedFn;
          }
          return clonedTc;
        });
      }
      return json;
    });
  }

  /**
   * Build a chat request body.
   */
  buildChatRequest(messages, modelConfig, tools, stream = this.stream) {
    const modelName = modelConfig.name.split("/").pop() || modelConfig.name;
    const escapedMessages = this._escapeMessages(messages);
    const request = {
      model: modelName,
      messages: escapedMessages,
      max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: modelConfig.temperature,
      tools: tools || [],
      parallel_tool_calls: true,
      function_choice: "auto",
      stream: stream,
    };
    if (stream) {
      request.stream_options = { include_usage: true };
    }
    return request;
  }

  /**
   * Send a chat request with retries.
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
   */
  async *chatStreamCancellable(
    messages,
    modelConfig,
    tools = [],
    cancelToken = null,
  ) {
    const request = this.buildChatRequest(messages, modelConfig, tools, true);
    const { url, apiKey } = this.resolveProviderSettings(modelConfig.name);

    // Build an AbortSignal for cancellation
    let abortController;
    let signal;
    if (cancelToken) {
      abortController = new AbortController();
      signal = abortController.signal;
      // Listen for cancellation
      const checkCancel = () => {
        if (cancelToken.aborted) {
          abortController.abort();
        } else {
          setTimeout(checkCancel, 50);
        }
      };
      checkCancel();
    } else {
      abortController = new AbortController();
      signal = abortController.signal;
    }

    // Wrap the request in a timeout
    const doRequestWithTimeout = async () => {
      const timeoutId = setTimeout(
        () => abortController.abort(),
        this.chatTimeoutSecs * 1000,
      );
      try {
        return await this._doRequest(url, apiKey, request, signal);
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Use retryWithBackoff for transient errors
    const response = await retryWithBackoff(
      doRequestWithTimeout,
      12,
      { signal },
    );

    yield* this._processSSE(response);
  }

  /**
   * Send an HTTP request to the chat completions endpoint.
   */
  async _doRequest(url, apiKey, request, signal) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "oa-agent/alpha",
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
