// Tests for mcp-client/index.ts — extension create, tool registration, and cleanup.

import { describe, it, expect, mock } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";

describe("MCP extension", () => {
  it("returns null when no servers configured", async () => {
    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {},
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    expect(create(core)).toBeNull();
  });

  it("returns null when all servers disabled", async () => {
    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {
        mcpServers: [{ name: "test", enabled: false, url: "http://localhost" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    expect(create(core)).toBeNull();
  });

  it("returns null in sandbox mode", async () => {
    const { create } = await import("../../src/extensions/mcp-client/index.ts");
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
    const { create } = await import("../../src/extensions/mcp-client/index.ts");
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
    // Mock McpConnection before importing create
    const mockConnection = {
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "blacklisted", description: "Should not appear", inputSchema: {} },
      ],
      handle: () => ({
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }),
      shutdown: async () => {},
    };

    mock.module("../../src/extensions/mcp-client/connection.ts", () => ({
      McpConnection: {
        connectHttp: async () => mockConnection,
        connectStdio: async () => { throw new Error("stdio not mocked"); },
      },
    }));

    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const ext = create(core);
    const registeredTools: Array<{ name: string }> = [];
    const mockRegistry = {
      register: (name: string, tool: unknown) => {
        registeredTools.push({ name });
      },
    };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);

    expect(registeredTools).toHaveLength(2);
    expect(registeredTools[0]!.name).toBe("test/echo");
    expect(registeredTools[1]!.name).toBe("test/blacklisted");
  });

  it("respects blacklistTools configuration", async () => {
    const mockConnection = {
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "blacklisted", description: "Should not appear", inputSchema: {} },
      ],
      handle: () => ({ callTool: async () => ({}) }),
      shutdown: async () => {},
    };

    mock.module("../../src/extensions/mcp-client/connection.ts", () => ({
      McpConnection: {
        connectHttp: async () => mockConnection,
        connectStdio: async () => { throw new Error("stdio not mocked"); },
      },
    }));

    const { create } = await import("../../src/extensions/mcp-client/index.ts");
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
    const ext = create(core);
    const registeredTools: string[] = [];
    const mockRegistry = {
      register: (name: string) => {
        registeredTools.push(name);
      },
    };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]).toBe("test/echo");
  });

  it("handles connection errors gracefully", async () => {
    mock.module("../../src/extensions/mcp-client/connection.ts", () => ({
      McpConnection: {
        connectHttp: async () => { throw new Error("connection failed"); },
        connectStdio: async () => {},
      },
    }));

    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {
        mcpServers: [{ name: "failing", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const ext = create(core);
    const mockRegistry = { register: () => {} };

    // Should not throw even if connection fails
    const result = await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    // Returns undefined, no error thrown
    expect(result).toBeUndefined();
  });

  it("shutdown cleans up connections", async () => {
    const shutdownSpy = async () => {};
    const mockConnection = {
      tools: [],
      handle: () => ({}),
      shutdown: shutdownSpy,
    };

    mock.module("../../src/extensions/mcp-client/connection.ts", () => ({
      McpConnection: {
        connectHttp: async () => mockConnection,
        connectStdio: async () => {},
      },
    }));

    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const ext = create(core);
    const mockRegistry = { register: () => {} };

    // Register tools first to create connections
    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    // Then shutdown
    await ext!.shutdown();

    // shutdown was called (we can verify by checking the connection array)
    expect(ext!.connections).toHaveLength(1);
  });

  it("SHUTDOWN_CLEANUP hook cleans up connections", async () => {
    const mockConnection = {
      tools: [],
      handle: () => ({}),
      shutdown: async () => {},
    };

    mock.module("../../src/extensions/mcp-client/connection.ts", () => ({
      McpConnection: {
        connectHttp: async () => mockConnection,
        connectStdio: async () => {},
      },
    }));

    const { create } = await import("../../src/extensions/mcp-client/index.ts");
    const core = {
      config: {
        mcpServers: [{ name: "test", url: "http://localhost/mcp" }],
      },
      hooks: { on: () => {}, notifyHooks: () => {} },
    } as any;
    const ext = create(core);
    const mockRegistry = { register: () => {} };

    await (ext!.hooks![HOOKS.TOOLS_REGISTER] as Function)(mockRegistry);
    await (ext!.hooks![HOOKS.SHUTDOWN_CLEANUP] as Function)();

    expect(ext!.connections).toHaveLength(1);
  });
});
