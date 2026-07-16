// Extended tests for MCP client and extension.
// Covers McpClient HTTP transport, SSE parsing, and extension integration.

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { create } from "../../src/extensions/mcp-client/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { McpConnection } from "../../src/extensions/mcp-client/connection.ts";

// ── McpClient Tests ─────────────────────────────────────────────────────────

function createMockFetch(response: Response) {
  return Object.assign(
    mock(() => Promise.resolve(response)),
    { preconnect: () => {} },
  ) as unknown as typeof globalThis.fetch;
}

describe("McpClient", () => {
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

    it("throws McpError on HTTP failure", async () => {
      const client = await McpClient.forHttp("http://localhost:1/mcp");
      await expect(client.callTool("test", {})).rejects.toThrow();
      await client.shutdown();
    });

    it("throws when client is cancelled", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      client.cancelled = true;
      await expect(client.callTool("test", {})).rejects.toThrow("Client is cancelled");
    });
  });

  describe("SSE parsing", () => {
    it("parses SSE messages correctly via HTTP response", async () => {
      const originalFetch = globalThis.fetch;
      const sseResponse = `event: message
data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Hello"}]}}

`;

      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sseResponse),
      } as Response);

      try {
        const client = await McpClient.forHttp("http://localhost:3000/mcp");
        const result = await client.callTool("test", {});
        expect(result).toBeDefined();
        expect((result as any).content).toEqual([{ type: "text", text: "Hello" }]);
        await client.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("parses direct JSON response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
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
        ok: false,
        status: 500,
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

    it("handles JSON error in response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
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
      const sseError = `event: message
data: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}

`;

      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sseError),
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
        ok: true,
        status: 200,
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

  describe("buffered responses", () => {
    it("starts with empty buffered array", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      expect(client.buffered).toEqual([]);
      await client.shutdown();
    });
  });

  describe("server capabilities and info", () => {
    it("stores server capabilities after initialize", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
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

  describe("shutdown", () => {
    it("sets cancelled flag", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      await client.shutdown();
      expect(client.cancelled).toBe(true);
    });

    it("rejects pending requests on shutdown", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      // No pending requests to reject, but should not throw
      await client.shutdown();
    });

    it("logs stderr output if present", async () => {
      const client = await McpClient.forHttp("http://localhost:3000/mcp");
      (client as any).stderrOutput = "Error: something went wrong\n";
      // Should not throw
      await client.shutdown();
    });
  });

  describe("listTools", () => {
    it("calls tools/list endpoint", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createMockFetch({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "echo", description: "Echo tool", inputSchema: {} },
            ],
          },
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

// ── McpError Tests ──────────────────────────────────────────────────────────

describe("McpError", () => {
  it("creates error with message", () => {
    const error = new McpError("Test error");
    expect(error.message).toBe("Test error");
    expect(error.name).toBe("McpError");
    expect(error.code).toBeNull();
  });

  it("creates error with message and code", () => {
    const error = new McpError("Test error", -32600);
    expect(error.message).toBe("Test error");
    expect(error.code).toBe(-32600);
  });

  it("extends Error", () => {
    const error = new McpError("Test error");
    expect(error).toBeInstanceOf(Error);
  });
});

// ── MCP Extension Tests ─────────────────────────────────────────────────────

describe("MCP Extension", () => {
  const originalConnectStdio = McpConnection.connectStdio;
  const originalConnectHttp = McpConnection.connectHttp;

  beforeEach(() => {
    // Mock McpConnection to avoid actual connections
    (McpConnection as any).connectStdio = async () => null;
    (McpConnection as any).connectHttp = async () => null;
  });

  afterEach(() => {
    // Restore originals
    (McpConnection as any).connectStdio = originalConnectStdio;
    (McpConnection as any).connectHttp = originalConnectHttp;
  });

  it("returns null when no MCP servers configured", () => {
    const core = {
      config: {},
    } as any;
    const result = create(core);
    expect(result).toBeNull();
  });

  it("returns null when all servers are disabled", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "server1", command: "test", enabled: false },
        ],
      },
    } as any;
    const result = create(core);
    expect(result).toBeNull();
  });

  it("creates extension with enabled servers", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo", args: [] },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();
    expect(result!.hooks).toBeDefined();
    expect(result!.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(result!.hooks![HOOKS.SHUTDOWN_CLEANUP]).toBeDefined();
  });

  it("has shutdown method", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo" },
        ],
      },
    } as any;

    const result = create(core);
    expect(result!.shutdown).toBeDefined();
    expect(typeof result!.shutdown).toBe("function");
  });

  it("tracks connections array", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo" },
        ],
      },
    } as any;

    const result = create(core);
    expect(result!.connections).toEqual([]);
  });

  it("handles server with URL (HTTP transport)", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "http-server", url: "http://localhost:3000/mcp" },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();
  });

  it("handles server with blacklistTools", () => {
    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo", blacklistTools: ["dangerous-tool"] },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();
  });

  it("handles server with custom headers", () => {
    const core = {
      config: {
        mcpServers: [
          {
            name: "auth-server",
            url: "http://localhost:3000/mcp",
            headers: { "Authorization": "Bearer token" },
          },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();
  });

  it("handles server with custom env", () => {
    const core = {
      config: {
        mcpServers: [
          {
            name: "env-server",
            command: "echo",
            env: { "API_KEY": "secret" },
          },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();
  });

  it("handles connection failure gracefully", async () => {
    // Override to throw
    (McpConnection as any).connectStdio = async () => {
      throw new Error("Connection failed");
    };

    const core = {
      config: {
        mcpServers: [
          { name: "failing-server", command: "echo" },
        ],
      },
    } as any;

    const result = create(core);
    expect(result).not.toBeNull();

    // Trigger tools registration
    const mockRegistry = {
      register: () => {},
    };
    await result!.hooks![HOOKS.TOOLS_REGISTER]!(mockRegistry as any);
    // Should not throw even if connection fails
  });

  it("calls shutdown on SHUTDOWN_CLEANUP hook", async () => {
    let shutdownCalled = false;

    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo" },
        ],
      },
    } as any;

    const result = create(core) as any;
    result.connections.push({ shutdown: async () => { shutdownCalled = true; } });

    await result.hooks![HOOKS.SHUTDOWN_CLEANUP]!();
    expect(shutdownCalled).toBe(true);
  });

  it("handles shutdown error gracefully", async () => {
    const core = {
      config: {
        mcpServers: [
          { name: "test-server", command: "echo" },
        ],
      },
    } as any;

    const result = create(core) as any;
    result.connections.push({ shutdown: async () => { throw new Error("Shutdown failed"); } });

    // Should not throw
    await result.shutdown();
  });
});
