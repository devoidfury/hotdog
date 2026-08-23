// Protocol path plumbing: LlmClient must use the path returned by
// protocol.buildRequest() instead of hardcoding /v1/chat/completions.

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { LlmClient } from "../../../src/core/llm-client/client.ts";
import { Message } from "../../../src/core/context/message.ts";
import type { ModelConfig } from "../../../src/core/config/providers.ts";
import { createLlmProtocolRegistry, type LlmProtocol } from "../../../src/core/llm-client/protocol.ts";
import { openaiProtocol } from "../../../src/core/llm-client/openai-protocol.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "prov/m1", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

describe("LlmClient uses the protocol's request path", () => {
  let capturedUrls: string[] = [];
  let capturedHeaders: Record<string, string>[] = [];

  beforeEach(() => {
    capturedUrls = [];
    capturedHeaders = [];
    mock.module("@utils/fetch.ts", () => ({
      hotdogFetch: async (url: string, init?: RequestInit) => {
        capturedUrls.push(url);
        capturedHeaders.push((init?.headers || {}) as Record<string, string>);
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }));
  });

  async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
    for await (const _ of stream) {
      // drain
    }
  }

  it("openai protocol keeps /v1/chat/completions", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://p.example",
      apiKey: "k",
    });
    await drain(
      client.chatStreamWithModelConfig([new Message({ role: "user", content: "hi" })], mc(), []),
    );
    expect(capturedUrls[0]).toBe("http://p.example/v1/chat/completions");
  });

  it("resolves the protocol from the provider level when the model has none", async () => {
    const customProtocol: LlmProtocol = {
      ...openaiProtocol,
      id: "provider-protocol",
      buildRequest(messages, modelConfig, toolDefs, stream, ctx) {
        return {
          ...openaiProtocol.buildRequest(messages, modelConfig, toolDefs, stream, ctx),
          path: "/v1/provider-path",
        };
      },
    };
    const reg = createLlmProtocolRegistry();
    reg.register(customProtocol);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://p.example",
      apiKey: "k",
      providers: [{ name: "prov", models: [], protocol: "provider-protocol" }],
      llmProtocolRegistry: reg,
    });
    // Model entry carries no `protocol`; the provider-level one must apply.
    await drain(
      client.chatStreamWithModelConfig([new Message({ role: "user", content: "hi" })], mc(), []),
    );
    expect(capturedUrls[0]).toBe("http://p.example/v1/provider-path");
  });

  it("model-level protocol wins over provider-level", async () => {
    const providerProto: LlmProtocol = {
      ...openaiProtocol,
      id: "provider-protocol",
      buildRequest(m, c, t, s, ctx) {
        return { ...openaiProtocol.buildRequest(m, c, t, s, ctx), path: "/v1/provider-path" };
      },
    };
    const modelProto: LlmProtocol = {
      ...openaiProtocol,
      id: "model-protocol",
      buildRequest(m, c, t, s, ctx) {
        return { ...openaiProtocol.buildRequest(m, c, t, s, ctx), path: "/v1/model-path" };
      },
    };
    const reg = createLlmProtocolRegistry();
    reg.register(providerProto);
    reg.register(modelProto);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://p.example",
      apiKey: "k",
      providers: [{ name: "prov", models: [], protocol: "provider-protocol" }],
      llmProtocolRegistry: reg,
    });
    await drain(
      client.chatStreamWithModelConfig(
        [new Message({ role: "user", content: "hi" })],
        mc({ protocol: "model-protocol" }),
        [],
      ),
    );
    expect(capturedUrls[0]).toBe("http://p.example/v1/model-path");
  });

  it("auth header uses the provider-level API key, not the global one", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://global.example",
      apiKey: "global-key",
      providers: [
        { name: "prov", models: [], url: "http://prov.example", apiKey: "provider-key" },
      ],
    });
    await drain(
      client.chatStreamWithModelConfig([new Message({ role: "user", content: "hi" })], mc(), []),
    );
    expect(capturedUrls[0]).toBe("http://prov.example/v1/chat/completions");
    expect(capturedHeaders[0]?.["Authorization"]).toBe("Bearer provider-key");
  });

  it("x-session-affinity uses the per-call sessionId, falling back to the client's", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://p.example",
      apiKey: "k",
      sessionId: "client-session",
    });
    // Per-call override wins.
    await drain(
      client.chatStreamWithModelConfig(
        [new Message({ role: "user", content: "hi" })],
        mc(),
        [],
        "call-session",
      ),
    );
    expect(capturedHeaders[0]?.["x-session-affinity"]).toBe("call-session");

    // Without an override, the client's session id applies.
    await drain(
      client.chatStreamWithModelConfig([new Message({ role: "user", content: "hi" })], mc(), []),
    );
    expect(capturedHeaders[1]?.["x-session-affinity"]).toBe("client-session");
  });

  it("auth header falls back to the global API key when the provider has none", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://global.example",
      apiKey: "global-key",
      providers: [{ name: "prov", models: [] }],
    });
    await drain(
      client.chatStreamWithModelConfig([new Message({ role: "user", content: "hi" })], mc(), []),
    );
    expect(capturedUrls[0]).toBe("http://global.example/v1/chat/completions");
    expect(capturedHeaders[0]?.["Authorization"]).toBe("Bearer global-key");
  });

  it("a custom protocol's buildRequest path is used verbatim", async () => {
    const customProtocol: LlmProtocol = {
      ...openaiProtocol,
      id: "custom-path",
      buildRequest(messages, modelConfig, toolDefs, stream, ctx) {
        return {
          ...openaiProtocol.buildRequest(messages, modelConfig, toolDefs, stream, ctx),
          path: "/v1/messages",
        };
      },
    };
    const reg = createLlmProtocolRegistry();
    reg.register(customProtocol);
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 0,
      markerMangler: null,
      baseUrl: "http://p.example",
      apiKey: "k",
      llmProtocolRegistry: reg,
    });
    await drain(
      client.chatStreamWithModelConfig(
        [new Message({ role: "user", content: "hi" })],
        mc({ protocol: "custom-path" }),
        [],
      ),
    );
    expect(capturedUrls[0]).toBe("http://p.example/v1/messages");
  });
});
