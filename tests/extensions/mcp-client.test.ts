import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";
import { HttpTransport, StdioTransport } from "../../src/extensions/mcp-client/transports.ts";
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
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);
    expect(client.serverCapabilities).toBeNull();
    expect(client.serverInfo).toBeNull();
  });
});

// ── HttpTransport._parseSSE ────────────────────────────────────────────────

describe("HttpTransport SSE parsing", () => {
  it("parses single SSE event", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
          ),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses multiple SSE events and returns last", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n',
          ),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ b: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses SSE without explicit event line", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve('data: {"jsonrpc":"2.0","id":1,"result":{"key":"value"}}\n\n'),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ key: "value" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles trailing data without final empty line", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"trailing":true}}'),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ trailing: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips unparseable data", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve('data: not-valid-json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"valid":true}}\n\n'),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ valid: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles CRLF line endings", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"crlf":true}}\r\n\r\n'),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ crlf: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores non-data and non-event lines", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve('id: 123\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ignored":true}}\nretry: 5000\n\n'),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ ignored: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── HttpTransport ──────────────────────────────────────────────────────────

describe("HttpTransport", () => {
  it("creates transport with url and headers", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp", {
      "X-Custom": "header",
    });
    expect(transport.url).toBe("http://localhost:3000/mcp");
    expect(transport.headers).toEqual({ "X-Custom": "header" });
    expect(transport.isStreaming).toBe(false);
  });

  it("creates transport with no headers", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    expect(transport.headers).toEqual({});
  });

  it("send returns result from direct JSON response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {} },
            }),
          ),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      );
      expect((result as Record<string, unknown>).protocolVersion).toBe("2025-11-25");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("send returns result from SSE response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
          ),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      );
      expect((result as Record<string, unknown>).tools).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("send throws on non-OK response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        transport.send(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        ),
      ).rejects.toThrow("MCP HTTP error (500)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("send throws when SSE has no messages", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve("garbage response"),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        transport.send(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
        ),
      ).rejects.toThrow("No SSE messages found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("send throws on JSON error response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32600, message: "Invalid request" },
            }),
          ),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        transport.send(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
        ),
      ).rejects.toThrow("Invalid request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("destroy can be called multiple times", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    await transport.destroy();
    await transport.destroy(); // should not throw
  });
});

// ── McpClient HTTP mode ────────────────────────────────────────────────────

describe("McpClient HTTP mode", () => {
  it("creates HTTP client via forHttp", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp", {
      "X-Custom": "header",
    });
    const transport = client.transport as HttpTransport;
    expect(transport.url).toBe("http://localhost:3000/mcp");
    expect(transport.headers).toEqual({ "X-Custom": "header" });
  });

  it("forHttp with no headers", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const transport = client.transport as HttpTransport;
    expect(transport.headers).toEqual({});
  });

  it("_sendRequest throws when client is cancelled", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    client.cancelled = true;
    await expect(
      (client as any)._sendRequest("test", {}),
    ).rejects.toThrow("Client is cancelled");
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
    const originalFetch = globalThis.fetch;
    const headersSet: Record<string, string> = {};

    const mockFetch = mock((url, opts) => {
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

    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
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
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  result: {
                    tools: [{ name: "tool1", description: "", inputSchema: {} }],
                    nextCursor: "cursor1",
                  },
                }),
              ),
          });
        } else {
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  result: {
                    tools: [{ name: "tool2", description: "", inputSchema: {} }],
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
});

// ── McpConnectionHandle ────────────────────────────────────────────────────

describe("MpConnectionHandle", () => {
  it("callTool forwards to client and returns output", async () => {
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
      if (body.method === "tools/list") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  tools: [{ name: "echo", description: "", inputSchema: {} }],
                },
              }),
            ),
        });
      }
      if (body.method === "tools/call") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                result: {
                  content: [{ type: "text", text: "echo result" }],
                  isError: false,
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
      const handle = conn.handle();
      const result = await handle.callTool("echo", { message: "hello" });
      expect(result).toBe("echo result");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("callTool throws on error response", async () => {
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
      if (body.method === "tools/list") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: { tools: [{ name: "fail", description: "", inputSchema: {} }] },
              }),
            ),
        });
      }
      if (body.method === "tools/call") {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                result: {
                  content: [{ type: "text", text: "something went wrong" }],
                  isError: true,
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
      const handle = conn.handle();
      await expect(handle.callTool("fail", {})).rejects.toThrow("something went wrong");
      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Extension create ───────────────────────────────────────────────────────

describe("MCP extension create", () => {
  it("returns null when no servers configured", () => {
    const core = {
      config: {},
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const result = create(core);
    expect(result).toBeNull();
  });

  it("returns null when all servers disabled", () => {
    const core = {
      config: {
        mcpServers: [{ name: "test", enabled: false, command: "test" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const result = create(core);
    expect(result).toBeNull();
  });

  it("returns extension when servers configured", () => {
    const core = {
      config: {
        mcpServers: [{ name: "test", command: "test" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const result = create(core);
    expect(result).not.toBeNull();
    expect(result!.hooks?.[HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(result!.hooks?.[HOOKS.SHUTDOWN_CLEANUP]).toBeDefined();
  });
});
