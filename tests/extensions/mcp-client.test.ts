import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";
import { create } from "../../src/extensions/mcp-client/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";

// ── McpError ────────────────────────────────────────────────────────────────

describe("McpError", () => {
  it("creates error with default code", () => {
    const err = new McpError("something failed");
    expect(err.message).toBe("something failed");
    expect(err.name).toBe("McpError");
    expect(err.code).toBeNull();
  });

  it("creates error with custom code", () => {
    const err = new McpError("something failed", -32600);
    expect(err.code).toBe(-32600);
  });

  it("is an instance of Error", () => {
    const err = new McpError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

// ── McpClient (constructor and basic methods) ──────────────────────────────

describe("McpClient constructor", () => {
  it("creates a client with default state", () => {
    const client = new McpClient();
    expect(client.serverCapabilities).toBeNull();
    expect(client.serverInfo).toBeNull();
  });
});

// ── McpClient._parseSSE ────────────────────────────────────────────────────

describe("McpClient._parseSSE", () => {
  it("parses single SSE event", () => {
    const client = new McpClient();
    const text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("parses multiple SSE events", () => {
    const client = new McpClient();
    const text =
      "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"b\":2}}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].result).toEqual({ a: 1 });
    expect(messages[1].result).toEqual({ b: 2 });
  });

  it("parses SSE without explicit event line", () => {
    const client = new McpClient();
    const text = "data: {\"key\":\"value\"}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ key: "value" });
  });

  it("handles trailing data without final empty line", () => {
    const client = new McpClient();
    const text = "event: message\ndata: {\"trailing\":true}";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ trailing: true });
  });

  it("skips unparseable data", () => {
    const client = new McpClient();
    const text = "data: not-valid-json\n\ndata: {\"valid\":true}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ valid: true });
  });

  it("returns empty array for empty input", () => {
    const client = new McpClient();
    const messages = (client as any)._parseSse("");
    expect(messages).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const client = new McpClient();
    const text = "event: message\r\ndata: {\"crlf\":true}\r\n\r\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ crlf: true });
  });

  it("ignores non-data and non-event lines", () => {
    const client = new McpClient();
    const text = "id: 123\nevent: message\ndata: {\"ignored\":true}\nretry: 5000\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ ignored: true });
  });

  it("parses event type change", () => {
    const client = new McpClient();
    const text = "event: custom\ndata: {\"type\":\"custom\"}\n\nevent: message\ndata: {\"type\":\"message\"}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(2);
  });
});

// ── McpClient HTTP mode ────────────────────────────────────────────────────

describe("McpClient HTTP mode", () => {
  it("creates HTTP client via forHttp", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp", {
      "X-Custom": "header",
    });
    expect((client as any)._url).toBe("http://localhost:3000/mcp");
    expect((client as any)._httpHeaders).toEqual({ "X-Custom": "header" });
  });

  it("forHttp with no headers", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    expect((client as any)._httpHeaders).toEqual({});
  });

  it("_httpRequest returns result from direct JSON response", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {} },
            }),
          ),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await (client as any)._httpRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      );
      expect(result.protocolVersion).toBe("2025-11-25");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_httpRequest returns result from SSE response", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
          ),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await (client as any)._httpRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      );
      expect(result.tools).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_httpRequest throws on non-OK response", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        (client as any)._httpRequest(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        ),
      ).rejects.toThrow("MCP HTTP error (500)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_httpRequest throws when SSE has no messages", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve("garbage response"),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        (client as any)._httpRequest(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
        ),
      ).rejects.toThrow("No SSE messages found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_httpRequest throws on JSON error response", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32600, message: "Invalid request" },
            }),
          ),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        (client as any)._httpRequest(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
        ),
      ).rejects.toThrow("Invalid request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_sendRequest throws when client is cancelled", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    client.cancelled = true;
    await expect((client as any)._sendRequest("test", {})).rejects.toThrow("Client is cancelled");
  });
});

// ── McpClient shutdown ─────────────────────────────────────────────────────

describe("McpClient shutdown", () => {
  it("shutdown sets cancelled flag", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
    expect(client.cancelled).toBe(true);
  });

  it("shutdown can be called multiple times", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
    await client.shutdown(); // should not throw
  });
});

// ── McpConnection ──────────────────────────────────────────────────────────

describe("McpConnection", () => {
  it("connectHttp creates connection and initializes", async () => {
    let initializeCalled = false;
    let listToolsCalled = false;

    const mockFetch = mock((url, opts) => {
      if (opts?.body && JSON.parse(opts.body).method === "initialize") {
        initializeCalled = true;
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "test", version: "1.0" },
                },
              }),
            ),
        });
      }
      if (opts?.body && JSON.parse(opts.body).method === "tools/list") {
        listToolsCalled = true;
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  tools: [
                    {
                      name: "echo",
                      description: "Echo tool",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                },
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
      );
      expect(initializeCalled).toBe(true);
      expect(listToolsCalled).toBe(true);
      expect(conn.serverName).toBe("test-server");
      expect(conn.tools).toHaveLength(1);
      expect(conn.tools[0]!.name).toBe("echo");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("connectHttp with headers", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test", version: "1.0" },
              },
            }),
          ),
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      // This will fail on listTools but we can check headers were set
      const headersSet: Record<string, string> = {};
      mockFetch.mockImplementation((url, opts) => {
        if (opts?.headers) {
          Object.keys(opts.headers).forEach((k) => {
            headersSet[k] = (opts.headers as Record<string, string>)[k]!;
          });
        }
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === "initialize") {
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    serverInfo: { name: "test" },
                  },
                }),
              ),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
            ),
        });
      });

      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
        { Authorization: "Bearer token" },
      );
      expect(headersSet["Authorization"]).toBe("Bearer token");
      expect(conn.serverName).toBe("test-server");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discoverTools with pagination cursor", async () => {
    let requestCount = 0;

    const mockFetch = mock((url, opts) => {
      requestCount++;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === "initialize") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "test" },
                },
              }),
            ),
        });
      }
      if (body.method === "tools/list") {
        if (requestCount === 2) {
          // First tools/list - return with cursor
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  result: {
                    tools: [
                      { name: "tool1", description: "", inputSchema: {} },
                    ],
                    nextCursor: "cursor1",
                  },
                }),
              ),
          });
        } else {
          // Second tools/list - no cursor
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  result: {
                    tools: [
                      { name: "tool2", description: "", inputSchema: {} },
                    ],
                  },
                }),
              ),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({})),
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
      );
      expect(conn.tools).toHaveLength(2);
      expect(conn.tools[0]!.name).toBe("tool1");
      expect(conn.tools[1]!.name).toBe("tool2");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handle() returns an McpConnectionHandle", async () => {
    const mockFetch = mock((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === "initialize") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "test" },
                },
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
          ),
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
      );
      const handle = conn.handle();
      expect(handle).toBeInstanceOf(McpConnectionHandle);
      expect(handle.serverName).toBe("test-server");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── McpConnectionHandle ────────────────────────────────────────────────────

describe("McpConnectionHandle", () => {
  it("callTool returns string content", async () => {
    const mockClient = {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({
        content: [{ type: "text", text: "hello" }],
        isError: false,
      }),
    } as any;
    const handle = new McpConnectionHandle(mockClient, "test-server");
    const result = await handle.callTool("echo", { text: "hello" });
    expect(result).toBe("hello");
  });

  it("callTool throws McpError on error response", async () => {
    const mockClient = {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      }),
    } as any;
    const handle = new McpConnectionHandle(mockClient, "test-server");
    await expect(
      handle.callTool("echo", { text: "hello" }),
    ).rejects.toThrow("Something went wrong");
  });

  it("callTool joins multiple text blocks", async () => {
    const mockClient = {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        isError: false,
      }),
    } as any;
    const handle = new McpConnectionHandle(mockClient, "test-server");
    const result = await handle.callTool("echo", {});
    expect(result).toBe("line1\nline2");
  });

  it("serverName getter", () => {
    const handle = new McpConnectionHandle({} as any, "my-server");
    expect(handle.serverName).toBe("my-server");
  });
});

// ── McpClient HTTP Integration Tests ────────────────────────────────────────

function createMockFetch(response: Response) {
  return Object.assign(
    mock(() => Promise.resolve(response)),
    { preconnect: () => {} },
  ) as unknown as typeof globalThis.fetch;
}

describe("McpClient HTTP integration", () => {
  describe("forHttp", () => {
    it("creates client with HTTP transport", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      expect(client).toBeDefined();
      expect(client.idCounter).toBe(0);
      expect(client.pending.size).toBe(0);
      expect(client.buffered).toEqual([]);
      expect(client.cancelled).toBe(false);
      await client.shutdown();
    });

    it("creates client with custom headers", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp", {
        "Authorization": "Bearer token",
      });
      expect(client).toBeDefined();
      await client.shutdown();
    });

    it("throws when client is cancelled", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      client.cancelled = true;
      await expect(client.callTool("test", {})).rejects.toThrow("Client is cancelled");
    });
  });

  describe("SSE parsing via HTTP", () => {
    it("parses SSE messages correctly", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Hello"}]}}\n\n',
        ),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        const result = await client.callTool("test", {});
        expect((result as any).content).toEqual([{ type: "text", text: "Hello" }]);
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("parses direct JSON response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { content: [{ type: "text", text: "Direct JSON" }] },
        })),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        const result = await client.callTool("test", {});
        expect((result as any).content).toEqual([{ type: "text", text: "Direct JSON" }]);
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles HTTP error response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: false, status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        await expect(client.callTool("test", {})).rejects.toThrow("MCP HTTP error (500)");
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles JSON-RPC error in response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          error: { code: -32600, message: "Invalid Request" },
        })),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        await expect(client.callTool("test", {})).rejects.toThrow("Invalid Request");
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles SSE error response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n\n',
        ),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        await expect(client.callTool("test", {})).rejects.toThrow("Method not found");
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles response with no SSE messages", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve("Not an SSE response"),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        await expect(client.callTool("test", {})).rejects.toThrow("No SSE messages found");
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("server capabilities", () => {
    it("stores server capabilities after initialize", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "test-server", version: "1.0.0" },
          },
        })),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        await client.initialize();
        expect(client.serverCapabilities).toBeDefined();
        expect(client.serverInfo).toBeDefined();
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("listTools", () => {
    it("calls tools/list endpoint", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { tools: [{ name: "echo", description: "Echo tool", inputSchema: {} }] },
        })),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        const result = await client.listTools();
        expect((result as any).tools).toHaveLength(1);
        expect((result as any).tools[0].name).toBe("echo");
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// ── MCP Extension Tests ─────────────────────────────────────────────────────

describe("MCP Extension", () => {
  const originalConnectStdio = McpConnection.connectStdio;
  const originalConnectHttp = McpConnection.connectHttp;

  beforeEach(() => {
    (McpConnection as any).connectStdio = async () => null;
    (McpConnection as any).connectHttp = async () => null;
  });

  afterEach(() => {
    (McpConnection as any).connectStdio = originalConnectStdio;
    (McpConnection as any).connectHttp = originalConnectHttp;
  });

  it("returns null when no MCP servers configured", () => {
    expect(create({ config: {} } as any)).toBeNull();
  });

  it("returns null when all servers are disabled", () => {
    expect(create({ config: { mcpServers: [{ name: "s1", command: "t", enabled: false }] } } as any)).toBeNull();
  });

  it("creates extension with enabled servers", () => {
    const result = create({ config: { mcpServers: [{ name: "test", command: "echo" }] } } as any);
    expect(result).not.toBeNull();
    expect(result!.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(result!.hooks![HOOKS.SHUTDOWN_CLEANUP]).toBeDefined();
  });

  it("has shutdown method", () => {
    const result = create({ config: { mcpServers: [{ name: "test", command: "echo" }] } } as any);
    expect(typeof result!.shutdown).toBe("function");
  });

  it("tracks connections array", () => {
    const result = create({ config: { mcpServers: [{ name: "test", command: "echo" }] } } as any);
    expect(result!.connections).toEqual([]);
  });

  it("handles server with URL (HTTP transport)", () => {
    expect(create({ config: { mcpServers: [{ name: "s", url: "http://localhost:3000/mcp" }] } } as any)).not.toBeNull();
  });

  it("handles server with blacklistTools", () => {
    expect(create({ config: { mcpServers: [{ name: "s", command: "echo", blacklistTools: ["dangerous"] }] } } as any)).not.toBeNull();
  });

  it("handles server with custom headers", () => {
    expect(create({ config: { mcpServers: [{ name: "s", url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer token" } }] } } as any)).not.toBeNull();
  });

  it("handles server with custom env", () => {
    expect(create({ config: { mcpServers: [{ name: "s", command: "echo", env: { API_KEY: "secret" } }] } } as any)).not.toBeNull();
  });

  it("handles connection failure gracefully", async () => {
    (McpConnection as any).connectStdio = async () => { throw new Error("Connection failed"); };
    const result = create({ config: { mcpServers: [{ name: "failing", command: "echo" }] } } as any);
    expect(result).not.toBeNull();
    await result!.hooks![HOOKS.TOOLS_REGISTER]!({ register: () => {} } as any);
  });

  it("calls shutdown on SHUTDOWN_CLEANUP hook", async () => {
    let shutdownCalled = false;
    const result = create({ config: { mcpServers: [{ name: "test", command: "echo" }] } } as any) as any;
    result.connections.push({ shutdown: async () => { shutdownCalled = true; } });
    await result.hooks![HOOKS.SHUTDOWN_CLEANUP]!();
    expect(shutdownCalled).toBe(true);
  });

  it("handles shutdown error gracefully", async () => {
    const result = create({ config: { mcpServers: [{ name: "test", command: "echo" }] } } as any) as any;
    result.connections.push({ shutdown: async () => { throw new Error("fail"); } });
    await expect(result.shutdown()).resolves.toBeUndefined();
  });
});
