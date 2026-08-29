// Protocol path plumbing: LlmClient must use the path returned by
// protocol.buildRequest() instead of hardcoding /v1/chat/completions.
//
// Requests are captured on a real local HTTP server (no module mocks),
// which also keeps the interception scoped to this file's server.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { LlmClient } from "../../../src/core/llm-client/client.ts";
import { Message } from "../../../src/core/context/message.ts";
import type { ModelConfig } from "../../../src/core/config/providers.ts";
import { createLlmProtocolRegistry, type LlmProtocol } from "../../../src/core/llm-client/protocol.ts";
import { openaiProtocol } from "../../../src/core/llm-client/openai-protocol.ts";

// Ephemeral ports (0): fixed ports collide when two `bun test` runs are
// concurrent. Assigned in beforeAll, read by the tests at run time.
let TEST_PORT = 0;
let PROVIDER_PORT = 0;
let BASE_URL = "";
let PROVIDER_URL = "";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "prov/m1", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

describe("LlmClient uses the protocol's request path", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let capturedUrls: string[] = [];
  let capturedHeaders: Record<string, string>[] = [];

  function startServer(): number {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => (h[k] = v));
        capturedUrls.push(req.url);
        capturedHeaders.push(h);
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    servers.push(server);
    return server.port!;
  }

  beforeAll(() => {
    TEST_PORT = startServer();
    PROVIDER_PORT = startServer();
    BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
    PROVIDER_URL = `http://127.0.0.1:${PROVIDER_PORT}`;
  });

  afterAll(() => {
    for (const s of servers) s.stop(true);
    servers.length = 0;
  });

  beforeEach(() => {
    capturedUrls = [];
    capturedHeaders = [];
  });

  async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
    for await (const _ of stream) {
      // drain
    }
  }

  it("openai protocol keeps /v1/chat/completions", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "k",
    });
    await drain(
      client.chatStreamCancellable([new Message({ role: "user", content: "hi" })], mc(), [], null),
    );
    expect(capturedUrls[0]).toBe(`${BASE_URL}/v1/chat/completions`);
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
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "k",
      providers: [{ name: "prov", models: [], protocol: "provider-protocol" }],
      llmProtocolRegistry: reg,
    });
    // Model entry carries no `protocol`; the provider-level one must apply.
    await drain(
      client.chatStreamCancellable([new Message({ role: "user", content: "hi" })], mc(), [], null),
    );
    expect(capturedUrls[0]).toBe(`${BASE_URL}/v1/provider-path`);
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
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "k",
      providers: [{ name: "prov", models: [], protocol: "provider-protocol" }],
      llmProtocolRegistry: reg,
    });
    await drain(
      client.chatStreamCancellable(
        [new Message({ role: "user", content: "hi" })],
        mc({ protocol: "model-protocol" }),
        [],
        null,
      ),
    );
    expect(capturedUrls[0]).toBe(`${BASE_URL}/v1/model-path`);
  });

  it("auth header uses the provider-level API key and URL, not the global ones", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "global-key",
      providers: [
        { name: "prov", models: [], url: PROVIDER_URL, apiKey: "provider-key" },
      ],
    });
    await drain(
      client.chatStreamCancellable([new Message({ role: "user", content: "hi" })], mc(), [], null),
    );
    // The provider's own URL wins over the global base URL.
    expect(capturedUrls[0]).toBe(`${PROVIDER_URL}/v1/chat/completions`);
    expect(capturedHeaders[0]?.["authorization"]).toBe("Bearer provider-key");
  });

  it("x-session-affinity uses the per-call sessionId, falling back to the client's", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "k",
      sessionId: "client-session",
    });
    // Per-call override wins.
    await drain(
      client.chatStreamCancellable(
        [new Message({ role: "user", content: "hi" })],
        mc(),
        [],
        null,
        "call-session",
      ),
    );
    expect(capturedHeaders[0]?.["x-session-affinity"]).toBe("call-session");

    // Without an override, the client's session id applies.
    await drain(
      client.chatStreamCancellable([new Message({ role: "user", content: "hi" })], mc(), [], null),
    );
    expect(capturedHeaders[1]?.["x-session-affinity"]).toBe("client-session");
  });

  it("auth header falls back to the global API key when the provider has none", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 60,
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "global-key",
      providers: [{ name: "prov", models: [] }],
    });
    await drain(
      client.chatStreamCancellable([new Message({ role: "user", content: "hi" })], mc(), [], null),
    );
    expect(capturedUrls[0]).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(capturedHeaders[0]?.["authorization"]).toBe("Bearer global-key");
  });

  it("registry rejects protocols without a non-empty id", () => {
    const reg = createLlmProtocolRegistry();
    expect(() => reg.register(null as never)).toThrow("non-empty id");
    expect(() => reg.register({ ...openaiProtocol, id: "" })).toThrow("non-empty id");
    expect(reg.has("")).toBe(false);
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
      maxRetries: 1,
      markerMangler: null,
      baseUrl: BASE_URL,
      apiKey: "k",
      llmProtocolRegistry: reg,
    });
    await drain(
      client.chatStreamCancellable(
        [new Message({ role: "user", content: "hi" })],
        mc({ protocol: "custom-path" }),
        [],
        null,
      ),
    );
    expect(capturedUrls[0]).toBe(`${BASE_URL}/v1/messages`);
  });
});
