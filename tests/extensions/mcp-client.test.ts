import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";

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
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("parses multiple SSE events", () => {
    const client = new McpClient();
    const text =
      "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"b\":2}}\n\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].result).toEqual({ a: 1 });
    expect(messages[1].result).toEqual({ b: 2 });
  });

  it("parses SSE without explicit event line", () => {
    const client = new McpClient();
    const text = "data: {\"key\":\"value\"}\n\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ key: "value" });
  });

  it("handles trailing data without final empty line", () => {
    const client = new McpClient();
    const text = "event: message\ndata: {\"trailing\":true}";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ trailing: true });
  });

  it("skips unparseable data", () => {
    const client = new McpClient();
    const text = "data: not-valid-json\n\ndata: {\"valid\":true}\n\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ valid: true });
  });

  it("returns empty array for empty input", () => {
    const client = new McpClient();
    const messages = client._parseSse("");
    expect(messages).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const client = new McpClient();
    const text = "event: message\r\ndata: {\"crlf\":true}\r\n\r\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ crlf: true });
  });

  it("ignores non-data and non-event lines", () => {
    const client = new McpClient();
    const text = "id: 123\nevent: message\ndata: {\"ignored\":true}\nretry: 5000\n\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ ignored: true });
  });

  it("parses event type change", () => {
    const client = new McpClient();
    const text = "event: custom\ndata: {\"type\":\"custom\"}\n\nevent: message\ndata: {\"type\":\"message\"}\n\n";
    const messages = client._parseSse(text);
    expect(messages).toHaveLength(2);
  });
});

// ── McpClient HTTP mode ────────────────────────────────────────────────────

describe("McpClient HTTP mode", () => {
  it("creates HTTP client via forHttp", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp", {
      "X-Custom": "header",
    });
    expect(client._url).toBe("http://localhost:3000/mcp");
    expect(client._httpHeaders).toEqual({ "X-Custom": "header" });
  });

  it("forHttp with no headers", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    expect(client._httpHeaders).toEqual({});
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
    globalThis.fetch = mockFetch;

    try {
      const result = await client._httpRequest(
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
    globalThis.fetch = mockFetch;

    try {
      const result = await client._httpRequest(
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
    globalThis.fetch = mockFetch;

    try {
      await expect(
        client._httpRequest(
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
    globalThis.fetch = mockFetch;

    try {
      await expect(
        client._httpRequest(
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
          Promise.stringify?.({}) ||
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
    globalThis.fetch = mockFetch;

    try {
      await expect(
        client._httpRequest(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
        ),
      ).rejects.toThrow("Invalid request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("_sendRequest throws when client is cancelled", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    client._cancelled = true;
    await expect(client._sendRequest("test", {})).rejects.toThrow("Client is cancelled");
  });
});

// ── McpClient shutdown ─────────────────────────────────────────────────────

describe("McpClient shutdown", () => {
  it("shutdown sets cancelled flag", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
    expect(client._cancelled).toBe(true);
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
    globalThis.fetch = mockFetch;

    try {
      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
      );
      expect(initializeCalled).toBe(true);
      expect(listToolsCalled).toBe(true);
      expect(conn.serverName).toBe("test-server");
      expect(conn.tools).toHaveLength(1);
      expect(conn.tools[0].name).toBe("echo");
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
    globalThis.fetch = mockFetch;

    try {
      // This will fail on listTools but we can check headers were set
      const headersSet = {};
      mockFetch.mockImplementation((url, opts) => {
        if (opts?.headers) {
          Object.keys(opts.headers).forEach((k) => {
            headersSet[k] = opts.headers[k];
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
    globalThis.fetch = mockFetch;

    try {
      const conn = await McpConnection.connectHttp(
        "test-server",
        "http://localhost:3000/mcp",
      );
      expect(conn.tools).toHaveLength(2);
      expect(conn.tools[0].name).toBe("tool1");
      expect(conn.tools[1].name).toBe("tool2");
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
    globalThis.fetch = mockFetch;

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
      callTool: async (name, args) => ({
        content: [{ type: "text", text: "hello" }],
        isError: false,
      }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    const result = await handle.callTool("echo", { text: "hello" });
    expect(result).toBe("hello");
  });

  it("callTool throws McpError on error response", async () => {
    const mockClient = {
      callTool: async (name, args) => ({
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    await expect(
      handle.callTool("echo", { text: "hello" }),
    ).rejects.toThrow("Something went wrong");
  });

  it("callTool joins multiple text blocks", async () => {
    const mockClient = {
      callTool: async (name, args) => ({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        isError: false,
      }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    const result = await handle.callTool("echo", {});
    expect(result).toBe("line1\nline2");
  });

  it("serverName getter", () => {
    const handle = new McpConnectionHandle({}, "my-server");
    expect(handle.serverName).toBe("my-server");
  });
});
