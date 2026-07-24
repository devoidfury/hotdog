// LLM client

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { retryWithBackoff } from "./retry.ts";
import { createMarkerMangler, MarkerMangler } from "../marker-mangler.ts";
import { LlmError } from "../error.ts";
import { logger } from "../logger.ts";
import { ToolDef } from "../extensions/tool-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, "../../../package.json");
let VERSION = "unknown";
try {
  const pkg = JSON.parse(await readFile(PKG_PATH, "utf-8"));
  VERSION = pkg.version || VERSION;
} catch {
  // Fall back to "unknown"
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
      const resp = await fetch(url + "/health");
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
      const toJSON = (msg as { toJSON?: () => Record<string, unknown> }).toJSON;
      const json = typeof toJSON === "function"
        ? (toJSON as () => Record<string, unknown>).call(msg)
        : { ...msg };
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

  async *chatStream(
    messages: Array<Record<string, unknown>>,
    model: string,
    tools: Array<ToolDef> = [],
    sessionId?: string,
  ): AsyncGenerator<StreamEvent> {
    const modelConfig: ModelConfig = {
      name: model,
      temperature: null,
    };
    yield* this.chatStreamWithModelConfig(messages, modelConfig, tools, sessionId);
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
            effectiveSessionId,
          );
        } finally {
          clearTimeout(timeoutId);
        }
      };

      const response = await retryWithBackoff<Response>(
        doRequestWithTimeout,
        this.maxRetries,
        {
          signal: abortController.signal,
        },
      );

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

  async _doRequest(
    url: string,
    apiKey: string | null,
    request: Record<string, unknown>,
    signal: AbortSignal | null,
    sessionId?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `hotdog/${VERSION}`,
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const effectiveSessionId = sessionId || this.sessionId;
    if (effectiveSessionId) headers["x-session-affinity"] = effectiveSessionId;
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

  async *_processSSE(response: Response): AsyncGenerator<StreamEvent> {
    const contentType =
      typeof response.headers?.get === "function"
        ? response.headers.get("content-type") || ""
        : "";
    const isSse =
      contentType.includes("text/event-stream") ||
      contentType.includes("text/plain") ||
      contentType === "";

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
    let currentEvent = "message";
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
          if (!trimmed) continue;
          if (trimmed.startsWith(":")) continue;
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;
          if (currentEvent !== "message" && currentEvent !== "") continue;
          if (trimmed === "data: [DONE]") {
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
          const payload = trimmed.slice(6);
          try {
            const data = JSON.parse(payload);
            yield* this._parseStreamData(data);
          } catch {
            jsonBuffer += payload;
            try {
              const data = JSON.parse(jsonBuffer);
              yield* this._parseStreamData(data);
              jsonBuffer = "";
            } catch {
              if (jsonBuffer.length > MAX_JSON_BUFFER) {
                logger.warn(`[sse] malformed JSON (${jsonBuffer.length} chars): ${jsonBuffer.slice(0, 100)}...`);
                jsonBuffer = "";
              }
            }
          }
        }
      }

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
        events.push({ type: "reasoning", content: content as string });
      }

      const contentVal = delta.content as string | null | undefined;
      if (contentVal) {
        let content = contentVal;
        if (this.#mangler) content = this.#mangler.unescape(content) ?? "";
        events.push({ type: "content", content: content as string });
      }

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

      if (choice.finish_reason) {
        events.push({ type: "finish", reason: choice.finish_reason as string });
      }
    }

    if (usage) {
      events.push({ type: "usage", data: usage });
    }

    return events;
  }
}
