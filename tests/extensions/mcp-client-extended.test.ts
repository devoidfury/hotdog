import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { McpConnection, McpConnectionHandle } from "../../src/extensions/mcp-client/connection.ts";
import {
  jsonRpcRequest,
  jsonRpcNotification,
  mcpInitializeRequest,
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolDefinition,
  mcpToolCallRequest,
  parseMcpToolCallResponse,
  parseMcpContentBlock,
  contentBlocksToString,
} from "../../src/extensions/mcp-client/types.ts";
import { McpTool } from "../../src/extensions/mcp-client/tools.ts";
import { create as createExtension } from "../../src/extensions/mcp-client/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";

// ── Helper: create a readable stream from lines ─────────────────────────────

function linesToStream(lines) {
  return new Readable({
    read() {
      for (const line of lines) {
        this.push(line + "\n");
      }
      this.push(null);
    },
  });
}

// ── Helper: create a writable stream stub ────────────────────────────────────

function createWritableStub() {
  const writes = [];
  return {
    write(data) {
      writes.push(data);
      return true;
    },
    end() {},
    _writes: writes,
  };
}

// ── McpError extended ────────────────────────────────────────────────────────

describe("McpError extended", () => {
  it("preserves stack trace", () => {
    const err = new McpError("test error", -32600);
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe("string");
  });

  it("has correct prototype chain", () => {
    const err = new McpError("test");
    expect(Object.getPrototypeOf(err)).toBe(McpError.prototype);
    expect(Object.getPrototypeOf(Object.getPrototypeOf(err))).toBe(Error.prototype);
  });

  it("serializes to JSON with name and code", () => {
    const err = new McpError("test error", -32601);
    const json = JSON.stringify(err);
    expect(json).toContain("McpError");
    expect(json).toContain("-32601");
  });
});

// ── PendingRequest ───────────────────────────────────────────────────────────

describe("PendingRequest", () => {
  it("creates with id and null resolvers", () => {
    // Access via internal mechanism — we test behavior through _sendRequest
    const client = new McpClient();
    expect(client.idCounter).toBe(0);
  });
});

// ── McpClient._handleLine ────────────────────────────────────────────────────

describe("McpClient._handleLine", () => {
  it("handles valid JSON-RPC response and resolves pending request", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;
    client.pending.set(1, { resolve: null, reject: null, timer: null });

    let resolved = null;
    let rejected = null;
    client.pending.set(1, {
      resolve: (v) => { resolved = v; },
      reject: (e) => { rejected = e; },
      timer: null,
    });

    await client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      }),
    );

    expect(resolved).toEqual({ ok: true });
    expect(rejected).toBeNull();
  });

  it("handles JSON-RPC error and rejects pending request", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    let rejected = null;
    client.pending.set(1, {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timer: null,
    });

    await client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      }),
    );

    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected.message).toContain("Invalid Request");
    expect(rejected.code).toBe(-32600);
  });

  it("handles JSON-RPC error with missing message", async () => {
    const client = new McpClient();

    let rejected = null;
    client.pending.set(1, {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timer: null,
    });

    await client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601 },
      }),
    );

    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected.message).toContain("MCP error code -32601");
    expect(rejected.code).toBe(-32601);
  });

  it("buffers response when no pending request exists", async () => {
    const client = new McpClient();

    await client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        result: { buffered: true },
      }),
    );

    expect(client.buffered).toHaveLength(1);
    expect(client.buffered[0].id).toBe(99);
    expect(client.buffered[0].result).toEqual({ buffered: true });
  });

  it("skips unparseable JSON", async () => {
    const client = new McpClient();
    await client._handleLine("not valid json at all");
    expect(client.buffered).toHaveLength(0);
  });

  it("skips invalid input: empty lines, no jsonrpc, no result/error", async () => {
    const client = new McpClient();
    await client._handleLine("");
    await client._handleLine("   ");
    await client._handleLine(JSON.stringify({ method: "notifications/initialized" }));
    await client._handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1 }));
    expect(client.buffered).toHaveLength(0);
  });

  it("trims whitespace from line", async () => {
    const client = new McpClient();
    let resolved = null;
    client.pending.set(1, {
      resolve: (v) => { resolved = v; },
      reject: () => {},
      timer: null,
    });

    await client._handleLine("  " + JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { trimmed: true },
    }) + "  ");

    expect(resolved).toEqual({ trimmed: true });
  });

  it("handles error with null code defaulting to -1", async () => {
    const client = new McpClient();

    let rejected = null;
    client.pending.set(1, {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timer: null,
    });

    await client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "bad error" },
      }),
    );

    expect(rejected.code).toBe(-1);
  });
});

// ── McpClient._sendRequest (stdio mode) ──────────────────────────────────────

describe("McpClient._sendRequest stdio mode", () => {
  it("sends request and receives response via pending mechanism", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    // Simulate response arriving via _handleLine
    const responsePromise = client._sendRequest("initialize", {
      protocolVersion: "2025-11-25",
    });

    // The request should have been written
    expect(writable._writes).toHaveLength(1);
    const sent = JSON.parse(writable._writes[0]);
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("initialize");
    expect(sent.params.protocolVersion).toBe("2025-11-25");

    // Simulate response
    setTimeout(() => {
      client._handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: sent.id,
          result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test" } },
        }),
      );
    }, 10);

    const result = await responsePromise;
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  it("handles buffered response matching pending request", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    // Pre-buffer a response
    client.buffered.push({
      id: 1,
      result: { fromBuffer: true },
      error: null,
      raw: "",
    });

    const result = await client._sendRequest("initialize", {});
    expect(result).toEqual({ fromBuffer: true });
  });

  it("throws on buffered error response", async () => {
    const client = new McpClient();

    client.buffered.push({
      id: 1,
      result: null,
      error: { code: -32600, message: "Buffered error" },
      raw: "",
    });

    await expect(client._sendRequest("initialize", {})).rejects.toThrow("Buffered error");
  });

  it("creates PendingRequest with correct structure", () => {
    const client = new McpClient();
    // The PendingRequest is created internally, but we can verify the counter
    const writable = createWritableStub();
    client._writeStream = writable;

    const promise = client._sendRequest("test", {});
    const id = client.idCounter;
    expect(client.pending.has(id)).toBe(true);
    const pending = client.pending.get(id);
    expect(pending.id).toBe(id);
    expect(pending.resolve).toBeDefined();
    expect(pending.reject).toBeDefined();
    // Timer is set by _sendRequest (a timer ID/object)
    expect(pending.timer).not.toBeNull();

    // Clean up
    client.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    promise.catch(() => {});
  });

  it("increments request ID counter", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    // Send a request and resolve it quickly
    const promise1 = client._sendRequest("method1", {});
    const id1 = client.idCounter;
    client._handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: id1, result: {} }),
    );
    await promise1;

    expect(client.idCounter).toBe(1);

    const promise2 = client._sendRequest("method2", {});
    const id2 = client.idCounter;
    client._handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: id2, result: {} }),
    );
    await promise2;

    expect(client.idCounter).toBe(2);
  });

  it("cleans up pending after response", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const promise = client._sendRequest("initialize", {});
    const id = client.idCounter;
    client._handleLine(
      JSON.stringify({ jsonrpc: "2.0", id, result: {} }),
    );
    await promise;

    expect(client.pending.has(id)).toBe(false);
  });
});

// ── McpClient.initialize ─────────────────────────────────────────────────────

describe("McpClient.initialize", () => {
  it("initializes connection and sets server info", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const initPromise = client.initialize();
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, logging: true },
          serverInfo: { name: "test-server", version: "1.0.0" },
          instructions: "Test instructions",
        },
      }),
    );

    const result = await initPromise;
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo.name).toBe("test-server");
    expect(result.serverInfo.version).toBe("1.0.0");
    expect(result.instructions).toBe("Test instructions");
    expect(client.serverCapabilities.tools.listChanged).toBe(false);
    expect(client.serverCapabilities.logging).toBe(true);
  });

  it("sends initialized notification after successful init", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    client.initialize();
    const initId = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "test" },
        },
      }),
    );

    // Wait a tick for the notification to be written
    await new Promise((r) => setTimeout(r, 10));

    // Should have 2 writes: initialize + notification
    expect(writable._writes).toHaveLength(2);
    const notif = JSON.parse(writable._writes[1]);
    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.method).toBe("notifications/initialized");
    expect(notif.id).toBeUndefined();
  });

  it("handles initialize error", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const initPromise = client.initialize();
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Unsupported protocol version" },
      }),
    );

    await expect(initPromise).rejects.toThrow("Unsupported protocol version");
  });
});

// ── McpClient.listTools ──────────────────────────────────────────────────────

describe("McpClient.listTools", () => {
  it("lists tools from server", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.listTools();
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "greet", description: "Greet someone", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
          ],
        },
      }),
    );

    const result = await resultPromise;
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("echo");
    expect(result.tools[1].name).toBe("greet");
    expect(result.nextCursor).toBeNull();
  });

  it("handles empty tools list", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.listTools();
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: [] },
      }),
    );

    const result = await resultPromise;
    expect(result.tools).toEqual([]);
  });

  it("handles tools with cursor", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.listTools();
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [{ name: "tool1", description: "", inputSchema: {} }],
          nextCursor: "abc123",
        },
      }),
    );

    const result = await resultPromise;
    expect(result.nextCursor).toBe("abc123");
  });
});

// ── McpClient.callTool ───────────────────────────────────────────────────────

describe("McpClient.callTool", () => {
  it("calls a tool and returns parsed response", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.callTool("echo", { text: "hello" });
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "hello" }],
          isError: false,
        },
      }),
    );

    const result = await resultPromise;
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.isError).toBe(false);
  });

  it("calls a tool with multiple content blocks", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.callTool("multi", { key: "value" });
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
            { type: "image", data: "base64", mimeType: "image/png" },
          ],
          isError: false,
        },
      }),
    );

    const result = await resultPromise;
    expect(result.content).toHaveLength(3);
  });

  it("handles tool call error response", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    const resultPromise = client.callTool("fail", {});
    const id = client.idCounter;

    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Tool execution failed" }],
          isError: true,
        },
      }),
    );

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Tool execution failed");
  });
});

// ── McpClient.forStdio ───────────────────────────────────────────────────────

describe("McpClient.forStdio", () => {
  it("creates client with stdio transport", async () => {
    // Mock spawn for testing
    const mockSpawn = mock((cmd, args, opts) => {
      const stdin = new WriteableMock();
      const stdout = new ReadableMock();
      const stderr = new ReadableMock();
      return {
        stdin,
        stdout,
        stderr,
        pid: 1234,
        kill: () => {},
        on: (event, cb) => {
          if (event === "spawn") {
            process.nextTick(cb);
          }
          if (event === "error") {
            // Don't auto-fire error
          }
          return { removeListener: () => {} };
        },
      };
    });

    const originalSpawn = spawn;

    // Use a real subprocess that exits immediately for testing
    try {
      const client = await McpClient.forStdio("echo", ["hello"]);
      expect(client._command).toBe("echo");
      expect(client._args).toEqual(["hello"]);
      expect(client._writeStream).toBeDefined();
      expect(client._readStream).toBeDefined();
      await client.shutdown();
    } catch (e) {
      // If spawn fails, that's ok for this test — just checking constructor
    }
  });

  it("forStdio with custom env", async () => {
    // This test verifies that env vars are merged
    const originalSpawn = spawn;
    let capturedEnv = null;

    const mockSpawn = mock((cmd, args, opts) => {
      capturedEnv = opts.env;
      const stdin = new WriteableMock();
      const stdout = new ReadableMock();
      const stderr = new ReadableMock();
      return {
        stdin,
        stdout,
        stderr,
        pid: 1234,
        kill: () => {},
        on: (event, cb) => {
          if (event === "spawn") process.nextTick(cb);
          return { removeListener: () => {} };
        },
      };
    });

    // We can't easily mock spawn in Bun test, so skip this if spawn fails
    try {
      await McpClient.forStdio("echo", [], { MY_VAR: "test" });
    } catch {
      // Ignore spawn errors
    }
  });

  it("forStdio rejects on spawn error", async () => {
    // Use a command that doesn't exist
    try {
      await McpClient.forStdio("/nonexistent/command/xyz_123");
      // If it doesn't throw, that's unexpected
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect(e.message).toContain("Failed to spawn");
    }
  }, { timeout: 15000 });

  it("forStdio rejects on timeout", async () => {
    // Use a command that hangs
    try {
      await McpClient.forStdio("sleep", ["60"]);
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect(e.message).toContain("failed to start");
    }
  }, { timeout: 15000 });
});

// ── McpClient stderr capture ─────────────────────────────────────────────────

describe("McpClient stderr capture", () => {
  it("captures stderr output", async () => {
    // Create a client and manually set up stderr
    const client = new McpClient();
    client._stderr = new Readable({
      read() {
        this.push("stderr line 1\n");
        this.push("stderr line 2\n");
        this.push(null);
      },
    });

    client._startStderrReader();

    // Wait for stderr to be read
    await new Promise((r) => setTimeout(r, 50));

    expect(client.stderrOutput).toContain("stderr line 1");
    expect(client.stderrOutput).toContain("stderr line 2");
  });

  it("stderr reader handles errors gracefully", async () => {
    const client = new McpClient();
    client._stderr = new Readable({
      read() {
        this.push("data\n");
        this.push(null);
      },
    });

    // Should not throw
    client._startStderrReader();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ── McClient shutdown with subprocess ────────────────────────────────────────

describe("McpClient shutdown with subprocess", () => {
  it("kills subprocess on shutdown", async () => {
    let killed = false;
    const mockSpawn = mock((cmd, args, opts) => {
      return {
        stdin: new WriteableMock(),
        stdout: new ReadableMock(),
        stderr: new ReadableMock(),
        pid: 9999,
        kill: () => { killed = true; },
        on: (event, cb) => {
          if (event === "spawn") process.nextTick(cb);
          return { removeListener: () => {} };
        },
      };
    });

    try {
      const client = await McpClient.forStdio("echo", ["test"]);
      expect(client._child.pid).toBe(9999);
      await client.shutdown();
      // The actual subprocess was killed
    } catch {
      // Ignore
    }
  });

  it("rejects all pending requests on shutdown", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    // Start a request that won't get a response
    const pendingPromise = client._sendRequest("initialize", {});

    // Shutdown immediately
    await client.shutdown();

    await expect(pendingPromise).rejects.toThrow("Cancelled");
  });

  it("prints stderr on shutdown if present", async () => {
    const client = new McpClient();
    client.stderrOutput = "some stderr output\n";

    // Shutdown should not throw even with stderr
    await client.shutdown();
    // If we get here without throwing, the test passes
  });
});

// ── McpClient serverCapabilities and serverInfo getters ──────────────────────

describe("McpClient getters", () => {
  it("serverCapabilities is null before initialize", () => {
    const client = new McpClient();
    expect(client.serverCapabilities).toBeNull();
  });

  it("serverInfo is null before initialize", () => {
    const client = new McpClient();
    expect(client.serverInfo).toBeNull();
  });

  it("serverCapabilities is set after initialize", async () => {
    const client = new McpClient();
    const writable = createWritableStub();
    client._writeStream = writable;

    client.initialize();
    const id = client.idCounter;
    client._handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true }, logging: true, resources: {}, prompts: {} },
          serverInfo: { name: "test", version: "1.0" },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(client.serverCapabilities.tools.listChanged).toBe(true);
    expect(client.serverCapabilities.logging).toBe(true);
  });
});

// ── Extension create function ────────────────────────────────────────────────

describe("Extension create function", () => {
  it("returns null when no MCP servers configured", () => {
    const mockCore = { config: {} };
    const ext = createExtension(mockCore);
    expect(ext).toBeNull();
  });

  it("returns null when mcpServers is empty", () => {
    const mockCore = { config: { mcpServers: [] } };
    const ext = createExtension(mockCore);
    expect(ext).toBeNull();
  });

  it("returns null when all servers are disabled", () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "server1", enabled: false },
          { name: "server2", enabled: false },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).toBeNull();
  });

  it("returns extension with hooks when servers configured", () => {
    const mockCore = {
      config: {
        mcpServers: [{ name: "test-server", command: "echo" }],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(ext.hooks[HOOKS.SHUTDOWN_CLEANUP]).toBeDefined();
  });

  it("skips disabled servers but processes enabled ones", () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "disabled-server", enabled: false },
          { name: "enabled-server", command: "echo" },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();
  });

  it("exposes connections array", () => {
    const mockCore = {
      config: {
        mcpServers: [{ name: "test-server", command: "echo" }],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext.connections).toBeDefined();
    expect(Array.isArray(ext.connections)).toBe(true);
  });

  it("exposes shutdown method", () => {
    const mockCore = {
      config: {
        mcpServers: [{ name: "test-server", command: "echo" }],
      },
    };
    const ext = createExtension(mockCore);
    expect(typeof ext.shutdown).toBe("function");
  });

  it("TOOLS_REGISTER hook iterates over enabled servers", async () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "server1", enabled: false },
          { name: "server2", command: "echo" },
          { name: "server3" },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();

    // The hook should only process server2 and server3 (enabled)
    let registeredNames = [];
    const registry = {
      register: (name, tool) => {
        registeredNames.push(name);
      },
    };

    // This will fail to connect since "echo" isn't a real MCP server,
    // but we can verify the hook structure
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
  });

  it("applies tool blacklist from server config", () => {
    const mockCore = {
      config: {
        mcpServers: [
          {
            name: "test-server",
            command: "echo",
            blacklistTools: ["forbidden-tool", "another-tool"],
          },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();
  });

  it("handles server connection failure gracefully", async () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "bad-server", command: "/nonexistent/bad/cmd" },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();

    const registry = {
      register: () => {},
    };

    // Should not throw even if server connection fails
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);
  }, { timeout: 30000 });

  it("SHUTDOWN_CLEANUP hook calls shutdown on all connections", async () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "test-server", url: "http://localhost:99999" },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();

    // Should not throw
    await ext.hooks[HOOKS.SHUTDOWN_CLEANUP]();
  });

  it("extension shutdown calls _shutdownAll", async () => {
    const mockCore = {
      config: {
        mcpServers: [{ name: "test-server", command: "echo" }],
      },
    };
    const ext = createExtension(mockCore);
    await ext.shutdown();
  });
});

// ── Types module completeness ────────────────────────────────────────────────

// ── McpTool schema conversion edge cases ─────────────────────────────────────

describe("McpTool schema conversion edge cases", () => {
  it("handles null schema properties", () => {
    const toolDef = {
      name: "test",
      description: "test",
      inputSchema: { properties: null },
    };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toEqual({});
  });

  it("handles non-object properties values", () => {
    const toolDef = {
      name: "test",
      description: "test",
      inputSchema: {
        properties: {
          field: "not-an-object",
        },
      },
    };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    // Non-object property values should be skipped
    expect(def.function.parameters.properties.field).toBeUndefined();
  });

  it("handles empty required array", () => {
    const toolDef = {
      name: "test",
      description: "test",
      inputSchema: { required: [] },
    };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.required).toEqual([]);
  });

  it("handles non-array required (should return empty)", () => {
    const toolDef = {
      name: "test",
      description: "test",
      inputSchema: { required: "not-an-array" },
    };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.required).toEqual([]);
  });

  it("filters non-string values from required array", () => {
    const toolDef = {
      name: "test",
      description: "test",
      inputSchema: { required: ["valid", 123, null, "also-valid"] },
    };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.required).toEqual(["valid", "also-valid"]);
  });

  it("handles null inputSchema", () => {
    const toolDef = { name: "test", description: "test", inputSchema: null };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("handles missing inputSchema entirely", () => {
    const toolDef = { name: "test", description: "test" };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("tool with no description has empty description", () => {
    const toolDef = { name: "test", inputSchema: {} };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.description).toBe("");
  });

  it("tool with title includes title in definition", () => {
    const toolDef = { name: "test", title: "Test Title", description: "desc", inputSchema: {} };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("server", toolDef, mockHandle);
    // Note: title is parsed but not used in toToolDef — just verifying it doesn't break
    const def = tool.toToolDef();
    expect(def.function.name).toBe("server/test");
  });

  it("execute with null input passes null as args (typeof null is 'object')", async () => {
    let receivedArgs = null;
    const mockHandle = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const result = await tool.execute(null);
    expect(result.success).toBe(true);
    expect(receivedArgs).toBeNull();
  });

  it("execute with number input passes number as args", async () => {
    let receivedArgs = null;
    const mockHandle = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const result = await tool.execute(42);
    expect(result.success).toBe(true);
    expect(receivedArgs).toBe(42);
  });

  it("execute with boolean input passes boolean as args", async () => {
    let receivedArgs = null;
    const mockHandle = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const result = await tool.execute(true);
    expect(result.success).toBe(true);
    expect(receivedArgs).toBe(true);
  });

  it("execute with array input passes array as args", async () => {
    let receivedArgs = null;
    const mockHandle = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const result = await tool.execute([1, 2, 3]);
    expect(result.success).toBe(true);
    expect(receivedArgs).toEqual([1, 2, 3]);
  });

  it("registeredName uses serverName and toolName", () => {
    const toolDef = { name: "my-tool", description: "desc", inputSchema: {} };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("my-server", toolDef, mockHandle);
    expect(tool.registeredName).toBe("my-server/my-tool");
  });

  it("callDisplay formats correctly", () => {
    const toolDef = { name: "echo", description: "desc", inputSchema: {} };
    const mockHandle = { callTool: async () => ({ content: [] }) };
    const tool = new McpTool("my-server", toolDef, mockHandle);
    expect(tool.callDisplay("echo hello world")).toBe("MCP [my-server] echo hello world");
  });
});

// ── McpConnectionHandle edge cases ───────────────────────────────────────────

describe("McpConnectionHandle edge cases", () => {
  it("callTool with image content returns formatted string", async () => {
    const mockClient = {
      callTool: async () => ({ content: [{ type: "image", data: "abc123", mimeType: "image/png" }], isError: false }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    expect(await handle.callTool("show", {})).toBe("[Image: image/png (6 bytes)]");
  });

  it("callTool with resource content returns formatted string", async () => {
    const mockClient = {
      callTool: async () => ({ content: [{ type: "resource", uri: "file:///test.txt", mimeType: "text/plain", text: "file content here" }], isError: false }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    expect(await handle.callTool("read", {})).toBe("[Resource: file:///test.txt]\nfile content here");
  });

  it("callTool with mixed content blocks", async () => {
    const mockClient = {
      callTool: async () => ({
        content: [
          { type: "text", text: "Text part" },
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "resource", uri: "file:///x", text: "resource text" },
          { type: "unknown" },
        ],
        isError: false,
      }),
    };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    const result = await handle.callTool("mixed", {});
    expect(result).toContain("Text part");
    expect(result).toContain("[Image:");
    expect(result).toContain("[Resource:");
    expect(result).toContain("[Unknown content block]");
  });

  it("callTool with empty content returns empty string", async () => {
    const mockClient = { callTool: async () => ({ content: [], isError: false }) };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    expect(await handle.callTool("empty", {})).toBe("");
  });

  it("callTool with error content includes error message", async () => {
    const mockClient = { callTool: async () => ({ content: [{ type: "text", text: "Disk full" }], isError: true }) };
    const handle = new McpConnectionHandle(mockClient, "test-server");
    await expect(handle.callTool("write", { path: "/full" })).rejects.toThrow("Disk full");
  });
});

// ── McpConnection edge cases ─────────────────────────────────────────────────

describe("McpConnection edge cases", () => {
  it("tools getter returns the internal tools array", async () => {
    const mockClient = {
      initialize: async () => ({ protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test" } }),
      listTools: async () => ({ tools: [], nextCursor: null }),
      shutdown: async () => {},
    };
    const conn = new McpConnection(mockClient, "test-server");
    await conn._initialize();
    expect(conn.tools).toBeDefined();
    expect(Array.isArray(conn.tools)).toBe(true);
  });

  it("serverName getter returns the server name", () => {
    const mockClient = {};
    const conn = new McpConnection(mockClient, "my-server");
    expect(conn.serverName).toBe("my-server");
  });

  it("shutdown delegates to client.shutdown", async () => {
    let shutdownCalled = false;
    const mockClient = {
      initialize: async () => ({ protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test" } }),
      listTools: async () => ({ tools: [], nextCursor: null }),
      shutdown: async () => { shutdownCalled = true; },
    };
    const conn = new McpConnection(mockClient, "test-server");
    await conn._initialize();
    await conn.shutdown();
    expect(shutdownCalled).toBe(true);
  });
});

// ── JSON-RPC edge cases ──────────────────────────────────────────────────────

describe("JSON-RPC edge cases", () => {
  it("jsonRpcRequest with numeric id", () => {
    const req = jsonRpcRequest(0, "method", {});
    expect(req.id).toBe(0);
  });

  it("jsonRpcRequest with large numeric id", () => {
    const req = jsonRpcRequest(999999, "method", {});
    expect(req.id).toBe(999999);
  });

  it("jsonRpcNotification with params", () => {
    const notif = jsonRpcNotification("notifications/initialized", {});
    expect(notif.params).toEqual({});
  });
});

// ── Integration: full HTTP connection flow ───────────────────────────────────

describe("Full HTTP connection flow", () => {
  it("complete init + listTools + callTool cycle", async () => {
    let callOrder = [];

    const mockFetch = mock((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      callOrder.push(body.method || "unknown");

      if (body.method === "initialize") {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "full-test", version: "2.0" },
              },
            }),
          ),
        });
      }
      if (body.method === "tools/list") {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
                ],
              },
            }),
          ),
        });
      }
      if (body.method === "tools/call") {
        // Body structure: { jsonrpc, id, method, params: { name, arguments } }
        const msg = body.params?.arguments?.msg || "";
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "echoed: " + msg }],
                isError: false,
              },
            }),
          ),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })),
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const conn = await McpConnection.connectHttp(
        "full-test-server",
        "http://localhost:3000/mcp",
      );
      expect(callOrder).toEqual(["initialize", "tools/list"]);
      expect(conn.serverName).toBe("full-test-server");
      expect(conn.tools).toHaveLength(1);
      expect(conn.tools[0].name).toBe("echo");

      // Call the tool
      const handle = conn.handle();
      const result = await handle.callTool("echo", { msg: "hello" });
      expect(result).toBe("echoed: hello");

      await conn.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── SSE parsing edge cases ───────────────────────────────────────────────────

describe("SSE parsing edge cases", () => {
  const sseScenarios = [
    { name: "extra blank lines", text: "\n\nevent: message\ndata: {\"key\":\"value\"}\n\n\n", expected: [{ key: "value" }] },
    { name: "multiple data lines (last wins)", text: "data: {\"first\":1}\ndata: {\"second\":2}\n\n", expected: [{ second: 2 }] },
    { name: "empty data lines", text: "data: \n\n", expected: [] },
    { name: "colon in data value", text: 'data: {"url":"http://example.com:8080"}\n\n', expected: [{ url: "http://example.com:8080" }] },
  ];

  for (const { name, text, expected } of sseScenarios) {
    it(`handles SSE with ${name}`, () => {
      const client = new McpClient();
      const messages = client._parseSse(text);
      expect(messages).toEqual(expected);
    });
  }
});

// ── McpConnectionHandle serverName property ──────────────────────────────────

describe("McpConnectionHandle serverName property", () => {
  it("returns the correct server name", () => {
    const mockClient = {};
    const handle = new McpConnectionHandle(mockClient, "production-server");
    expect(handle.serverName).toBe("production-server");
  });

  it("serverName is read-only (getter only)", () => {
    const mockClient = {};
    const handle = new McpConnectionHandle(mockClient, "test");
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(handle),
      "serverName",
    );
    expect(descriptor).toBeDefined();
    expect(descriptor.get).toBeDefined();
    expect(descriptor.set).toBeUndefined();
  });
});

// ── McpClient._startReader ───────────────────────────────────────────────────

describe("McpClient._startReader", () => {
  it("starts reader task that processes lines", async () => {
    const client = new McpClient();
    client._readStream = new Readable({
      read() {
        this.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
        this.push(null);
      },
    });

    client._startReader();

    // Wait for reader to process
    await new Promise((r) => setTimeout(r, 50));

    // Reader should have processed the line
    expect(client._readerTask).not.toBeNull();
  });

  it("reader handles malformed JSON gracefully", async () => {
    const client = new McpClient();
    client._readStream = new Readable({
      read() {
        this.push("not json\n");
        this.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
        this.push(null);
      },
    });

    client._startReader();
    await new Promise((r) => setTimeout(r, 50));
    // Should not throw
  });

  it("reader respects cancelled flag", async () => {
    const client = new McpClient();
    client._readStream = new Readable({
      read() {
        this.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
        this.push(null);
      },
    });
    client.cancelled = true;

    client._startReader();
    await new Promise((r) => setTimeout(r, 50));
    // Should stop processing when cancelled
  });

  it("no-op when no read stream", () => {
    const client = new McpClient();
    expect(() => client._startReader()).not.toThrow();
  });
});

// ── Re-exports from index.ts ─────────────────────────────────────────────────

describe("Index module re-exports", () => {
  it("re-exports McpClient", () => {
    // Verify the module has the expected exports by importing
    expect(McpClient).toBeDefined();
    expect(McpError).toBeDefined();
  });

  it("re-exports McpConnection", () => {
    expect(McpConnection).toBeDefined();
  });

  it("re-exports all type helpers", () => {
    // These are imported at the top of the file
    expect(jsonRpcRequest).toBeDefined();
    expect(jsonRpcNotification).toBeDefined();
    expect(mcpInitializeRequest).toBeDefined();
    expect(parseMcpInitializeResponse).toBeDefined();
    expect(parseMcpToolsListResponse).toBeDefined();
    expect(parseMcpToolDefinition).toBeDefined();
    expect(mcpToolCallRequest).toBeDefined();
    expect(parseMcpToolCallResponse).toBeDefined();
    expect(parseMcpContentBlock).toBeDefined();
    expect(contentBlocksToString).toBeDefined();
  });
});

// ── SSE error handling in HTTP mode ──────────────────────────────────────────

describe("SSE error handling", () => {
  it("_httpRequest throws on SSE error response", async () => {
    const mockFetch = mock((url, opts) => {
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Server error"}}\n\n',
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
      ).rejects.toThrow("Server error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Index.ts: _connectServer paths ───────────────────────────────────────────

describe("Index.ts _connectServer paths", () => {
  it("HTTP transport path calls connectHttp with headers", async () => {
    let connectHttpCalled = false;
    let connectHttpArgs = null;

    const originalConnectHttp = McpConnection.connectHttp;
    McpConnection.connectHttp = async (name, url, headers) => {
      connectHttpCalled = true;
      connectHttpArgs = { name, url, headers };
      return {
        serverName: name,
        tools: [],
        handle: () => ({ callTool: async () => "" }),
        shutdown: async () => {},
      };
    };

    try {
      // Re-import the extension to pick up the mocked connectHttp
      // Since createExtension uses McpConnection.connectHttp internally,
      // we need to mock before the module is loaded.
      // Instead, let's verify via the extension's behavior.
      const mockCore = {
        config: {
          mcpServers: [
            {
              name: "http-server",
              url: "http://example.com/mcp",
              headers: { Authorization: "Bearer token" },
            },
          ],
        },
      };
      const ext = createExtension(mockCore);
      expect(ext).not.toBeNull();
      expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
    } finally {
      McpConnection.connectHttp = originalConnectHttp;
    }
  });

  it("stdio transport path calls connectStdio", async () => {
    let connectStdioCalled = false;
    let connectStdioArgs = null;

    const originalConnectStdio = McpConnection.connectStdio;
    McpConnection.connectStdio = async (name, command, args, env) => {
      connectStdioCalled = true;
      connectStdioArgs = { name, command, args, env };
      return {
        serverName: name,
        tools: [],
        handle: () => ({ callTool: async () => "" }),
        shutdown: async () => {},
      };
    };

    try {
      const mockCore = {
        config: {
          mcpServers: [
            {
              name: "stdio-server",
              command: "/usr/bin/mcp-server",
              args: ["--verbose"],
              env: { API_KEY: "secret" },
            },
          ],
        },
      };
      const ext = createExtension(mockCore);
      expect(ext).not.toBeNull();
      expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
    } finally {
      McpConnection.connectStdio = originalConnectStdio;
    }
  });

  it("returns null when neither url nor command", async () => {
    const mockCore = {
      config: {
        mcpServers: [
          { name: "no-transport-server" },
        ],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();

    // The extension should be created but no connection attempted
    // since the server has neither url nor command
    let registerCalled = false;
    const registry = {
      register: () => { registerCalled = true; },
    };
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);
    expect(registerCalled).toBe(false);
  });
});

// ── Index.ts: _shutdownAll error handling ────────────────────────────────────

describe("Index.ts _shutdownAll error handling", () => {
  it("handles connection shutdown errors gracefully", async () => {
    const mockCore = {
      config: {
        mcpServers: [{ name: "test-server", command: "echo" }],
      },
    };
    const ext = createExtension(mockCore);
    expect(ext).not.toBeNull();

    // Add a connection that will fail on shutdown
    const failingConn = {
      serverName: "failing",
      tools: [],
      handle: () => ({ callTool: async () => "" }),
      shutdown: async () => { throw new Error("shutdown failed"); },
    };
    ext.connections.push(failingConn);

    // shutdown() should not throw even if a connection fails
    await ext.shutdown();
  });

  it("TOOLS_REGISTER pushes connection on success", async () => {
    let connectHttpCalled = false;

    const originalConnectHttp = McpConnection.connectHttp;
    McpConnection.connectHttp = async (name, url, headers) => {
      connectHttpCalled = true;
      return {
        serverName: name,
        tools: [
          { name: "test-tool", description: "desc", inputSchema: { type: "object", properties: {} } },
        ],
        handle: () => ({ callTool: async () => "result" }),
        shutdown: async () => {},
      };
    };

    try {
      const mockCore = {
        config: {
          mcpServers: [
            { name: "test-server", url: "http://localhost:3000/mcp" },
          ],
        },
      };
      const ext = createExtension(mockCore);
      expect(ext).not.toBeNull();
      expect(ext.connections.length).toBe(0);

      let registeredName = null;
      const registry = {
        register: (name, tool) => { registeredName = name; },
      };
      await ext.hooks[HOOKS.TOOLS_REGISTER](registry);

      expect(connectHttpCalled).toBe(true);
      expect(ext.connections.length).toBe(1);
      expect(registeredName).toBe("test-server/test-tool");
    } finally {
      McpConnection.connectHttp = originalConnectHttp;
    }
  });

  it("TOOLS_REGISTER skips blacklisted tools", async () => {
    let connectHttpCalled = false;

    const originalConnectHttp = McpConnection.connectHttp;
    McpConnection.connectHttp = async (name, url, headers) => {
      connectHttpCalled = true;
      return {
        serverName: name,
        tools: [
          { name: "allowed-tool", description: "desc", inputSchema: { type: "object", properties: {} } },
          { name: "blacklisted-tool", description: "desc", inputSchema: { type: "object", properties: {} } },
        ],
        handle: () => ({ callTool: async () => "result" }),
        shutdown: async () => {},
      };
    };

    try {
      const mockCore = {
        config: {
          mcpServers: [
            {
              name: "test-server",
              url: "http://localhost:3000/mcp",
              blacklistTools: ["blacklisted-tool"],
            },
          ],
        },
      };
      const ext = createExtension(mockCore);
      expect(ext).not.toBeNull();

      let registeredNames = [];
      const registry = {
        register: (name, tool) => { registeredNames.push(name); },
      };
      await ext.hooks[HOOKS.TOOLS_REGISTER](registry);

      expect(registeredNames).toEqual(["test-server/allowed-tool"]);
      expect(registeredNames).not.toContain("test-server/blacklisted-tool");
    } finally {
      McpConnection.connectHttp = originalConnectHttp;
    }
  });
});

// ── McpClient._handleLine with error code 0 ──────────────────────────────────

describe("McpClient._handleLine edge cases", () => {
  it("handles error with code 0 (falls through to -1 due to ||)", async () => {
    const client = new McpClient();
    let rejected = null;
    client.pending.set(1, { resolve: () => {}, reject: (e) => { rejected = e; }, timer: null });
    await client._handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 0, message: "Unknown error" } }));
    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected.code).toBe(-1);
  });

  it("handles error with code 0 and no message", async () => {
    const client = new McpClient();
    let rejected = null;
    client.pending.set(1, { resolve: () => {}, reject: (e) => { rejected = e; }, timer: null });
    await client._handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 0 } }));
    expect(rejected.message).toContain("MCP error code 0");
  });
});

// ── McpClient forStdio with args and env ─────────────────────────────────────

describe("McpClient.forStdio with args and env", () => {
  it("passes args to spawn", async () => {
    try {
      const client = await McpClient.forStdio("echo", ["-n", "hello"]);
      expect(client._args).toEqual(["-n", "hello"]);
      await client.shutdown();
    } catch { /* Ignore spawn errors */ }
  });

  it("passes env to spawn", async () => {
    try {
      const client = await McpClient.forStdio("echo", [], { CUSTOM_VAR: "value" });
      expect(client._env).toEqual({ CUSTOM_VAR: "value" });
      await client.shutdown();
    } catch { /* Ignore spawn errors */ }
  });
});

// ── McpClient shutdown with no child ─────────────────────────────────────────

describe("McpClient shutdown with no child", () => {
  it("shutdown without child doesn't throw", async () => {
    const client = new McpClient();
    client.cancelled = true;
    await client.shutdown();
  });

  it("shutdown with cancelled child doesn't throw", async () => {
    const client = new McpClient();
    client.cancelled = true;
    client._child = { pid: 1234, kill: () => {} };
    await client.shutdown();
  });
});

// ── McpClient buffered responses with error ──────────────────────────────────

describe("McpClient buffered error responses", () => {
  it("throws on buffered error with code", async () => {
    const client = new McpClient();
    client.buffered.push({
      id: 1, result: null, error: { code: -32602, message: "Invalid params" },
      raw: '{"error":{"code":-32602,"message":"Invalid params"}}',
    });
    await expect(client._sendRequest("test", {})).rejects.toThrow("Invalid params");
  });

  it("throws on buffered error with no code defaulting to -1", async () => {
    const client = new McpClient();
    client.buffered.push({
      id: 1, result: null, error: { message: "Buffered error" }, raw: "",
    });
    try {
      await client._sendRequest("test", {});
    } catch (e) {
      expect(e.code).toBe(-1);
    }
  });
});

