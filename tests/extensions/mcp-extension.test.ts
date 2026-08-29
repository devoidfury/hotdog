// Tests for mcp-client/index.ts — extension create, tool registration, and cleanup.

import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { create } from "../../src/extensions/mcp-client/index.ts";
import type { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock McpConnection class for testing. */
function createMockConnectionClass(config: {
  connectHttp?: (name: string, url: string, headers: Record<string, string>, timeoutMs?: number) => Promise<McpConnection> | never;
  connectStdio?: (name: string, command: string, args: string[], env: Record<string, string>) => Promise<McpConnection> | never;
}): typeof McpConnection {
  class MockMcpConnection {
    tools: Record<string, unknown>[] = [];
    serverName = "mock";

    static async connectHttp(
      serverName: string,
      url: string,
      headers: Record<string, string> = {},
      timeoutMs?: number,
    ): Promise<McpConnection> {
      if (config.connectHttp) return config.connectHttp(serverName, url, headers, timeoutMs);
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

/** Create a mock connection instance. `shutdown` records its calls. */
function createMockConnection(config: {
  tools?: Record<string, unknown>[];
  callToolResult?: string;
  shouldFailConnectHttp?: boolean;
  shouldFailConnectStdio?: boolean;
} = {}) {
  const shutdownCalls: number[] = [];
  return {
    tools: config.tools || [],
    serverName: "mock",
    shutdownCalls,
    handle: () => ({
      serverName: "mock",
      callTool: async () => config.callToolResult || "ok",
    }) as unknown as McpConnectionHandle,
    shutdown: async () => { shutdownCalls.push(1); },
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
      register: (name: string, _tool: unknown) => {
        registeredTools.push({ name });
      },
    };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER]! as Function)(mockRegistry);

    expect(registeredTools).toHaveLength(2);
    expect(registeredTools[0]!.name).toBe("test__echo");
    expect(registeredTools[1]!.name).toBe("test__blacklisted");
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

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]).toBe("test__echo");
  });

  it("shutdown calls shutdown on every connected server", async () => {
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

    const ext = create(core, MockConnection)!;
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({ register: () => {}, getAll: () => [] });
    expect(ext.connections).toHaveLength(1);

    await ext.shutdown!();
    expect((mockConnection as any).shutdownCalls).toHaveLength(1);
  });

  it("SHUTDOWN_CLEANUP hook calls shutdown on every connected server", async () => {
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

    const ext = create(core, MockConnection)!;
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({ register: () => {}, getAll: () => [] });
    await ext.hooks![HOOKS.SHUTDOWN_CLEANUP]!({});

    expect((mockConnection as any).shutdownCalls).toHaveLength(1);
  });
});

// ── Additional Branch Coverage ──────────────────────────────────────────────

describe("MCP extension — branch coverage", () => {
  it("skips server with neither url nor command", async () => {
    let connectAttempts = 0;
    const MockConnection = createMockConnectionClass({
      connectHttp: async () => { connectAttempts++; throw new Error("should not connect"); },
      connectStdio: async () => { connectAttempts++; throw new Error("should not connect"); },
    });

    const core = {
      config: {
        mcpServers: [{ name: "incomplete", args: ["--test"] }], // no url, no command
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;

    const ext = create(core, MockConnection);
    const registeredTools: string[] = [];

    // Incomplete servers are skipped: no connection, no tools.
    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)({
      register: (name: string) => { registeredTools.push(name); },
    });

    expect(connectAttempts).toBe(0);
    expect(registeredTools).toEqual([]);
    expect(ext!.connections).toHaveLength(0);
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
    expect(registeredTools[0]).toBe("stdio__stdio_tool");
  });

  it("skips server when connectStdio throws", async () => {
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
    const registeredTools: string[] = [];

    // A failed connection is swallowed: no crash, no tools, no connection.
    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)({
      register: (name: string) => { registeredTools.push(name); },
    });

    expect(registeredTools).toEqual([]);
    expect(ext!.connections).toHaveLength(0);
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

    const ext = create(core, MockConnection)!;
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({ register: () => {}, getAll: () => [] } as never);
    // A failing connection shutdown must not break ext.shutdown()
    await expect(ext.shutdown!()).resolves.toBeUndefined();
  });
});

// ── HTTP timeout config (mcpClient.httpTimeoutSecs) ─────────────────────────

describe("MCP extension — HTTP timeout config", () => {
  /** Connect one HTTP server with the given config; return the timeoutMs the transport saw. */
  async function connectTimeoutMs(config: Record<string, unknown>): Promise<number | undefined> {
    const mockConnection = createMockConnection({ tools: [] });
    let seenTimeout: number | undefined;
    const MockConnection = createMockConnectionClass({
      connectHttp: async (_n: string, _u: string, _h: Record<string, string>, timeoutMs?: number) => {
        seenTimeout = timeoutMs;
        return mockConnection;
      },
    });
    const core = { config, hooks: { on: () => {}, notifyHooks: () => {} } } as any;
    const ext = create(core, MockConnection);
    await (ext!.hooks![HOOKS.TOOLS_REGISTER]! as Function)({ register: () => {} });
    await ext!.shutdown!();
    return seenTimeout;
  }

  const baseConfig = { mcpServers: [{ name: "test", url: "http://localhost/mcp" }] };

  it("passes mcpClient.httpTimeoutSecs to connectHttp in ms", async () => {
    expect(await connectTimeoutMs({ ...baseConfig, mcpClient: { httpTimeoutSecs: 45 } })).toBe(45_000);
  });

  it("falls back to the 30s default when mcpClient config is absent", async () => {
    expect(await connectTimeoutMs(baseConfig)).toBe(30_000);
  });

  it("falls back to the default for invalid values (never 'no timeout')", async () => {
    for (const bad of [0, -5, NaN, "fast"]) {
      const seen = await connectTimeoutMs({ ...baseConfig, mcpClient: { httpTimeoutSecs: bad } });
      expect(seen, `httpTimeoutSecs=${String(bad)}`).toBe(30_000);
    }
  });
});
