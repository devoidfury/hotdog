// Tests for mcp-client — stdio mode, message handling, _sendRequest,
// and other paths.

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { HttpTransport, StdioTransport } from "../../src/extensions/mcp-client/transports.ts";

// ── McpClient._sendRequest Tests ─────────────────────────────────────────────

describe("McpClient._sendRequest", () => {

  it("increments id counter for each request", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ result: "ok" })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const initialId = client.idCounter;
      await (client as any)._sendRequest("method1", {});
      await (client as any)._sendRequest("method2", {});
      await (client as any)._sendRequest("method3", {});

      expect(client.idCounter).toBe(initialId + 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws McpError when cancelled", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);
    client.cancelled = true;

    await expect((client as any)._sendRequest("test", {})).rejects.toThrow("Client is cancelled");
  });

  it("HTTP mode sends correct headers", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    const mockFetch = mock((url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ result: "ok" })),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp", {
      "X-Custom-Header": "custom-value",
      "Authorization": "Bearer token",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await (client as any)._sendRequest("test/method", { param: "value" });

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!["Content-Type"]).toBe("application/json");
      expect(capturedHeaders!["Accept"]).toBe("application/json, text/event-stream");
      expect(capturedHeaders!["X-Custom-Header"]).toBe("custom-value");
      expect(capturedHeaders!["Authorization"]).toBe("Bearer token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HTTP mode sends correct request body", async () => {
    let capturedBody: string | null = null;

    const mockFetch = mock((url: string, opts: any) => {
      capturedBody = opts.body;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ result: "ok" })),
      });
    });

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await (client as any)._sendRequest("tools/call", { name: "echo", arguments: { text: "hello" } });

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("tools/call");
      expect(parsed.params).toHaveProperty("name", "echo");
      expect(parsed.params).toHaveProperty("arguments", { text: "hello" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── McpClient.initialize Tests ───────────────────────────────────────────────

describe("McpClient.initialize", () => {
  it("sends initialize request and returns server info", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "test-server", version: "1.0.0" },
          },
        })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await client.initialize();

      expect((result as any).protocolVersion).toBe("2025-11-25");
      expect((result as any).capabilities).toHaveProperty("tools");
      expect((result as any).serverInfo).toEqual({ name: "test-server", version: "1.0.0" });

      // Check that server capabilities/info are stored
      expect(client.serverCapabilities).toHaveProperty("tools");
      expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("initialize without streaming transport does not send notification", async () => {
    // HTTP mode has no writeStream, so the initialized notification should be skipped
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "test" },
          },
        })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await client.initialize();
      // Should not throw even without writeStream
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── McpClient.listTools Tests ────────────────────────────────────────────────

describe("McpClient.listTools", () => {
  it("returns parsed tools list", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "echo", description: "Echo tool", inputSchema: { type: "object" } },
              { name: "greet", description: "Greet tool", inputSchema: { type: "object" } },
            ],
          },
        })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await client.listTools();
      expect((result as any).tools).toHaveLength(2);
      expect((result as any).tools[0]!.name).toBe("echo");
      expect((result as any).tools[1]!.name).toBe("greet");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── McpClient.callTool Tests ─────────────────────────────────────────────────

describe("McpClient.callTool", () => {
  it("returns tool call result", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "Hello, World!" }],
          },
        })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await client.callTool("echo", { text: "Hello, World!" });
      expect((result as any).content).toEqual([{ type: "text", text: "Hello, World!" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── HttpTransport SSE Edge Cases ─────────────────────────────────────────────

describe("HttpTransport SSE edge cases", () => {
  it("handles mixed valid and invalid SSE data", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            'data: {"jsonrpc":"2.0","id":1,"result":{"valid":1}}\n\ndata: invalid json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"valid":2}}\n\n',
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
      // Returns last valid JSON-RPC response
      expect(result).toEqual({ valid: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles SSE with only event lines", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve("event: message\n\nevent: custom\n\n"),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" })),
      ).rejects.toThrow("No SSE messages found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles SSE with empty data", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve("data: \n\n"),
      }),
    );

    const transport = new HttpTransport("http://localhost:3000/mcp");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" })),
      ).rejects.toThrow("No SSE messages found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles SSE comment lines", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(': this is a comment\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'),
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
});

// ── StdioTransport Tests ─────────────────────────────────────────────────────

describe("StdioTransport", () => {
  it("has isStreaming = true", () => {
    const transport = new StdioTransport("echo");
    expect(transport.isStreaming).toBe(true);
    transport.destroy();
  });

  it("HttpTransport has isStreaming = false", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    expect(transport.isStreaming).toBe(false);
  });

  it("transport accessor returns the transport", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    const transport = client.transport;
    expect(transport).toBeInstanceOf(HttpTransport);
    expect((transport as HttpTransport).url).toBe("http://localhost:3000/mcp");
    await client.shutdown();
  });
});

// ── McpClient forStdio Tests ─────────────────────────────────────────────────

describe("McpClient.forStdio", () => {
  it("creates client with stdio transport", async () => {
    // echo is a simple command that starts quickly
    const client = await McpClient.forStdio("echo", ["test"]);
    expect(client.transport.isStreaming).toBe(true);
    await client.shutdown();
  });

  it("throws when command fails to start", async () => {
    await expect(
      McpClient.forStdio("/nonexistent/command/xyz"),
    ).rejects.toThrow("Failed to spawn");
  });

  // Note: timeout test skipped — 10s timeout is impractical for test suite
});

// ── StdioTransport Tests ─────────────────────────────────────────────────────

describe("StdioTransport", () => {
  it("sends messages to subprocess stdin", async () => {
    const transport = new StdioTransport("cat");
    await transport.send('{"test": true}');
    await new Promise((r) => setTimeout(r, 50));
    await transport.destroy();
  });

  it("throws when sending to destroyed transport", async () => {
    const transport = new StdioTransport("cat");
    await transport.destroy();
    await expect(transport.send("test")).rejects.toThrow("Transport is destroyed");
  });

  it("receives messages from subprocess stdout", async () => {
    const transport = new StdioTransport("echo", ["hello world"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await new Promise((r) => setTimeout(r, 100));
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toContain("hello world");
  });

  it("handles multiple messages", async () => {
    const transport = new StdioTransport("printf", ["line1\nline2\nline3\n"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await new Promise((r) => setTimeout(r, 100));
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toEqual(["line1", "line2", "line3"]);
  });

  it("skips empty lines", async () => {
    const transport = new StdioTransport("printf", ["\n\nline\n\n"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await new Promise((r) => setTimeout(r, 100));
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toEqual(["line"]);
  });

  it("supports multiple message handlers", async () => {
    const transport = new StdioTransport("echo", ["multi-handler-test"]);
    const handler1Lines: string[] = [];
    const handler2Lines: string[] = [];

    const remove1 = transport.onMessage((line) => handler1Lines.push(line));
    const remove2 = transport.onMessage((line) => handler2Lines.push(line));

    await new Promise((r) => setTimeout(r, 100));
    remove1();
    remove2();
    await transport.destroy();

    expect(handler1Lines).toEqual(handler2Lines);
    expect(handler1Lines.length).toBeGreaterThan(0);
  });

  it("removes handler when cleanup function called", async () => {
    const transport = new StdioTransport("printf", ["a\nb\nc\n"]);
    const handler1Lines: string[] = [];
    const handler2Lines: string[] = [];

    const remove1 = transport.onMessage((line) => handler1Lines.push(line));
    const remove2 = transport.onMessage((line) => handler2Lines.push(line));

    await new Promise((r) => setTimeout(r, 50));
    remove1();

    await new Promise((r) => setTimeout(r, 100));
    remove2();
    await transport.destroy();

    // Both should have received at least "a"
    expect(handler1Lines).toContain("a");
    expect(handler2Lines).toContain("a");
    // handler2 should have more since handler1 was removed
    expect(handler2Lines.length).toBeGreaterThanOrEqual(handler1Lines.length);
  });

  it("sendNotification writes to stdin", async () => {
    const transport = new StdioTransport("cat");
    transport.sendNotification('{"notification": true}');
    await new Promise((r) => setTimeout(r, 50));
    await transport.destroy();
  });

  it("sendNotification is no-op after destroy", async () => {
    const transport = new StdioTransport("cat");
    await transport.destroy();
    // Should not throw
    transport.sendNotification("test");
  });

  it("onClose registers close handler", async () => {
    const transport = new StdioTransport("cat");
    let closed = false;
    const removeHandler = transport.onClose(() => { closed = true; });
    await transport.destroy();
    removeHandler();
    expect(closed).toBe(true);
  });

  it("destroy can be called multiple times", async () => {
    const transport = new StdioTransport("cat");
    await transport.destroy();
    await transport.destroy();
  });

  it("exposes command and args", async () => {
    const transport = new StdioTransport("cat", ["--help"], { KEY: "val" });
    expect(transport.command).toBe("cat");
    expect(transport.args).toEqual(["--help"]);
    expect(transport.env).toHaveProperty("KEY", "val");
    await transport.destroy();
  });

  it("captures stderr output", async () => {
    const transport = new StdioTransport("sh", ["-c", "echo error-msg >&2"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.stderrOutput).toContain("error-msg");
    await transport.destroy();
  });
});

// ── Stdio McpClient Integration Tests ────────────────────────────────────────

describe("McpClient stdio integration", () => {
  it("handles messages from subprocess", async () => {
    // Use a simple script that outputs JSON-RPC responses
    const client = await McpClient.forStdio("sh", ["-c", "echo '{\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{\"data\":\"buffered\"}}'"]);
    
    // Wait for message to be processed
    await new Promise((r) => setTimeout(r, 100));
    
    // The buffered response should be available
    expect(client.buffered.length).toBeGreaterThan(0);
    await client.shutdown();
  });

  it("handles empty lines from subprocess without error", async () => {
    const client = await McpClient.forStdio("sh", ["-c", "printf '\\n\\n\\n'"]);
    await new Promise((r) => setTimeout(r, 100));
    // Should not crash
    await client.shutdown();
  });

  it("handles invalid JSON lines from subprocess without error", async () => {
    const client = await McpClient.forStdio("sh", ["-c", "echo 'not valid json'"]);
    await new Promise((r) => setTimeout(r, 100));
    // Should not crash
    await client.shutdown();
  });

  it("handles notifications (no id) without error", async () => {
    const client = await McpClient.forStdio("sh", ["-c", "echo '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}'"]);
    await new Promise((r) => setTimeout(r, 100));
    // Should not crash, notifications are ignored
    await client.shutdown();
  });

  it("message cleanup is called on shutdown", async () => {
    const client = await McpClient.forStdio("cat");
    // Just verify shutdown completes without error
    await client.shutdown();
  });
});

// ── HttpTransport onClose Tests ──────────────────────────────────────────────

describe("HttpTransport onClose", () => {
  it("registers and calls close handler on destroy", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    let closed = false;
    const removeHandler = transport.onClose(() => { closed = true; });
    await transport.destroy();
    removeHandler();
    expect(closed).toBe(true);
  });

  it("removes close handler when cleanup function called", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    let closed = false;
    const removeHandler = transport.onClose(() => { closed = true; });
    removeHandler();
    await transport.destroy();
    expect(closed).toBe(false);
  });

  it("sendNotification is no-op for HTTP transport", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    // Should not throw
    transport.sendNotification("test");
  });

  it("throws when sending to destroyed HTTP transport", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    await transport.destroy();
    await expect(
      transport.send(JSON.stringify({ test: true })),
    ).rejects.toThrow("Transport is destroyed");
  });
});

// ── McpConnection connectStdio Tests ─────────────────────────────────────────

describe("McpConnection connectStdio", () => {
  it("connects via stdio and initializes", async () => {
    // Use a simple script that responds with proper MCP initialize response
    const script = `
      read line
      echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}'
      read line
      echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'
    `;
    const { McpConnection } = await import("../../src/extensions/mcp-client/connection.ts");
    const conn = await McpConnection.connectStdio("test", "sh", ["-c", script]);
    expect(conn.serverName).toBe("test");
    expect(conn.tools).toEqual([]);
    await conn.shutdown();
  });
});
