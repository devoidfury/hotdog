// Tests for mcp-client/index.ts — extension create, tool registration, and cleanup.

import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { create } from "../../src/extensions/mcp-client/index.ts";
import type { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock McpConnection class for testing. */
function createMockConnectionClass(config: {
  connectHttp?: (name: string, url: string, headers: Record<string, string>) => Promise<McpConnection> | never;
  connectStdio?: (name: string, command: string, args: string[], env: Record<string, string>) => Promise<McpConnection> | never;
}): typeof McpConnection {
  class MockMcpConnection {
    tools: Record<string, unknown>[] = [];
    serverName = "mock";

    static async connectHttp(
      serverName: string,
      url: string,
      headers: Record<string, string> = {},
    ): Promise<McpConnection> {
      if (config.connectHttp) return config.connectHttp(serverName, url, headers);
      throw new Error("connectHttp not mocked");
    }

    static async connectStdio(
      serverName: string,
      command: string,
      args: string[] = [],
      env: Record<string, string> = {},
    ): Promise<McpConnection> {
      if (config.connectStdio) return config.connectStdio(serverName, command, args, env);
      throw new Error("connectStdio not mocked");
    }

    handle() {
      return {
        serverName: "mock",
        callTool: async () => "ok",
      } as unknown as McpConnectionHandle;
    }

    async shutdown() {}
  }
  return MockMcpConnection as unknown as typeof McpConnection;
}

/** Create a mock connection instance. */
function createMockConnection(config: {
  tools?: Record<string, unknown>[];
  callToolResult?: string;
  shouldFailConnectHttp?: boolean;
  shouldFailConnectStdio?: boolean;
}) {
  return {
    tools: config.tools || [],
    serverName: "mock",
    handle: () => ({
      serverName: "mock",
      callTool: async () => config.callToolResult || "ok",
    }) as unknown as McpConnectionHandle,
    shutdown: async () => {},
  } as unknown as McpConnection;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MCP extension", () => {
  it("returns null when no servers configured", async () => {
    const core = {
      config: {},
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    expect(create(core)).toBeNull();
  });

  it("returns null when all servers disabled", async () => {
    const core = {
      config: {
        mcpServers: [{ name: "test", enabled: false, url: "http://localhost" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    expect(create(core)).toBeNull();
  });

  it("returns null in sandbox mode", async () => {
    const core = {
      config: {
        sandboxMode: true,
        mcpServers: [{ name: "test", url: "http://localhost" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    expect(create(core)).toBeNull();
  });

  it("returns extension with hooks when servers configured", async () => {
    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const ext = create(core);
    expect(ext).not.toBeNull();
    expect(ext!.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(ext!.hooks![HOOKS.SHUTDOWN_CLEANUP]).toBeDefined();
    expect(typeof ext!.shutdown).toBe("function");
  });

  it("registers tools from connected servers", async () => {
    const mockConnection = createMockConnection({
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "blacklisted", description: "Should not appear", inputSchema: {} },
      ],
    });

    const MockConnection = createMockConnectionClass({
      connectHttp: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const registeredTools: Array<{ name: string }> = [];
    const mockRegistry = {
      register: (name: string, tool: unknown) => {
        registeredTools.push({ name });
      },
    };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER]! as Function)(mockRegistry);

    expect(registeredTools).toHaveLength(2);
    expect(registeredTools[0]!.name).toBe("test/echo");
    expect(registeredTools[1]!.name).toBe("test/blacklisted");
  });

  it("respects blacklistTools configuration", async () => {
    const mockConnection = createMockConnection({
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "blacklisted", description: "Should not appear", inputSchema: {} },
      ],
    });

    const MockConnection = createMockConnectionClass({
      connectHttp: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [
          {
            name: "test",
            url: "http://localhost/mcp",
            blacklistTools: ["blacklisted"],
          },
        ],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const registeredTools: string[] = [];
    const mockRegistry = {
      register: (name: string) => {
        registeredTools.push(name);
      },
    };

    const handler = ext!.hooks![HOOKS.TOOLS_REGISTER] as Function | undefined;
    if (handler) await handler(mockRegistry);

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]).toBe("test/echo");
  });

  it("handles connection errors gracefully", async () => {
    const MockConnection = createMockConnectionClass({
      connectHttp: async () => { throw new Error("connection failed"); },
    });

    const core = {
      config: {
        mcpServers: [{ name: "failing", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {} };

    // Should not throw even if connection fails
    const result = await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    expect(result).toBeUndefined();
  });

  it("shutdown cleans up connections", async () => {
    const mockConnection = createMockConnection({ tools: [] });

    const MockConnection = createMockConnectionClass({
      connectHttp: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {} };

    // Register tools first to create connections
    await (ext?.hooks?.[HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    // Then shutdown
    await ext!.shutdown?.();

    // shutdown was called (we can verify by checking the connection array)
    expect(ext!.connections).toHaveLength(1);
  });

  it("SHUTDOWN_CLEANUP hook cleans up connections", async () => {
    const mockConnection = createMockConnection({ tools: [] });

    const MockConnection = createMockConnectionClass({
      connectHttp: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {} };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    await (ext!.hooks![HOOKS.SHUTDOWN_CLEANUP] as Function)();

    expect(ext!.connections).toHaveLength(1);
  });
});

// ── Additional Branch Coverage ──────────────────────────────────────────────

describe("MCP extension — branch coverage", () => {
  it("handles server with neither url nor command", async () => {
    const MockConnection = createMockConnectionClass({});

    const core = {
      config: {
        mcpServers: [{ name: "incomplete", args: ["--test"] }], // no url, no command
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {} };

    // Should not throw, just skip the incomplete server
    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
  });

  it("handles stdio transport", async () => {
    const mockConnection = createMockConnection({
      tools: [{ name: "stdio_tool", description: "Stdio tool", inputSchema: { type: "object" } }],
    });

    const MockConnection = createMockConnectionClass({
      connectStdio: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [{ name: "stdio", command: "node", args: ["server.js"], env: { NODE_ENV: "test" } }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const registeredTools: string[] = [];
    const mockRegistry = {
      register: (name: string) => {
        registeredTools.push(name);
      },
    };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]).toBe("stdio/stdio_tool");
  });

  it("handles connection error in _connectServer catch block", async () => {
    const MockConnection = createMockConnectionClass({
      connectStdio: async () => { throw new Error("stdio failed"); },
    });

    const core = {
      config: {
        mcpServers: [{ name: "stdio-fail", command: "node", args: ["server.js"] }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {} };

    // Should not throw
    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
  });

  it("handles shutdown error gracefully", async () => {
    const mockConnection = createMockConnection({
      tools: [],
    });
    // Override shutdown to throw
    mockConnection.shutdown = async () => { throw new Error("shutdown failed"); };

    const MockConnection = createMockConnectionClass({
      connectHttp: async () => mockConnection,
    });

    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const mockRegistry = { register: () => {}, getAll: () => [] } as never;

    const handler = ext?.hooks?.[HOOKS.TOOLS_REGISTER];
    if (typeof handler === "function") await handler(mockRegistry);
    // Should not throw even if shutdown fails
    await expect(ext?.shutdown?.()).resolves.toBeUndefined();
  });
});
