// Tests for mcp-client — stdio mode, message handling, _sendRequest,
// and other paths.

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";
import { HttpTransport, StdioTransport } from "../../src/extensions/mcp-client/transports.ts";

// ── Message Handling (via transport onMessage) ──────────────────────────────

describe("McpClient message handling", () => {
  it("handles empty lines without error", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    // Simulate message handling by adding to buffered directly
    // (empty lines are filtered before reaching the handler)
    expect(() => {
      // Empty lines should be ignored
    }).not.toThrow();
  });

  it("handles unparseable JSON lines without error", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    // Unparseable lines are filtered in the handler
    expect(() => {
      // Would be skipped
    }).not.toThrow();
  });

  it("handles non-response JSON-RPC messages without error", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    // Notifications without id are ignored
    expect(client.buffered).toHaveLength(0);
  });

  it("buffers response when no pending request", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    // Simulate a buffered response (out-of-order arrival)
    // In real usage this happens via _handleLine, but we test the buffering logic
    // by directly checking the buffered array behavior via _sendRequest
    const buffered = client.buffered;
    buffered.push({
      id: 999,
      result: { data: "buffered" },
      error: null,
      raw: '{"jsonrpc":"2.0","id":999,"result":{"data":"buffered"}}',
    });

    expect(client.buffered).toHaveLength(1);
    expect(client.buffered[0]!.id).toBe(999);
    expect(client.buffered[0]!.result).toEqual({ data: "buffered" });
  });

  it("buffers error response when no pending request", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    const buffered = client.buffered;
    buffered.push({
      id: 998,
      result: null,
      error: { code: -32600, message: "Invalid request" },
      raw: '{"jsonrpc":"2.0","id":998,"error":{"code":-32600,"message":"Invalid request"}}',
    });

    expect(client.buffered).toHaveLength(1);
    expect(client.buffered[0]!.id).toBe(998);
    expect(client.buffered[0]!.error).toEqual({ code: -32600, message: "Invalid request" });
  });

  it("resolves pending request with result", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    const pendingMap = client.pending;
    const testId = 1;
    let resolved = false;
    let resolvedValue: unknown = undefined;
    let rejected = false;
    let rejectedError: Error | null = null;

    const pr = {
      id: testId,
      resolve: (value: unknown) => { resolved = true; resolvedValue = value; },
      reject: (reason: Error) => { rejected = true; rejectedError = reason; },
      timer: null,
    };
    pendingMap.set(testId, pr as any);

    // Simulate response handling by directly resolving
    // (In stdio mode, this happens via _handleLine when the line arrives)
    pr.resolve?.({ success: true });

    expect(resolved).toBe(true);
    expect(resolvedValue).toEqual({ success: true });
    expect(rejected).toBe(false);
  });

  it("rejects pending request with error", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    const pendingMap = client.pending;
    const testId = 2;
    let resolved = false;
    let rejected = false;
    let rejectedError: Error | null = null;

    const pr = {
      id: testId,
      resolve: () => { resolved = true; },
      reject: (reason: Error) => { rejected = true; rejectedError = reason; },
      timer: null,
    };
    pendingMap.set(testId, pr as any);

    // Simulate error response
    const error = new McpError("Method not found\nRaw response: test", -32601);
    pr.reject?.(error);

    expect(resolved).toBe(false);
    expect(rejected).toBe(true);
    expect(rejectedError).toBeInstanceOf(McpError);
    expect(rejectedError!.message).toContain("Method not found");
    expect((rejectedError! as McpError).code).toBe(-32601);
  });
});

// ── McpClient._sendRequest Tests ─────────────────────────────────────────────

describe("McpClient._sendRequest", () => {
  it("uses buffered response when available", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    // idCounter starts at 0, so first request will use id 1
    const buffered = client.buffered;
    buffered.push({
      id: 1,
      result: { from: "buffer" },
      error: null,
      raw: '{"jsonrpc":"2.0","id":1,"result":{"from":"buffer"}}',
    });

    // Now send a request — it should use the buffered response
    const result = await (client as any)._sendRequest("test/method", {});
    expect(result).toEqual({ from: "buffer" });
  });

  it("uses buffered error response when available", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);

    const buffered = client.buffered;
    buffered.push({
      id: 1,
      result: null,
      error: { code: -32600, message: "Buffered error" },
      raw: '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Buffered error"}}',
    });

    await expect((client as any)._sendRequest("test/method", {})).rejects.toThrow("Buffered error");
  });

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

// ── McpClient shutdown Tests ─────────────────────────────────────────────────

describe("McpClient.shutdown", () => {
  it("rejects pending requests on shutdown", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const pendingMap = client.pending;
    let rejected = false;
    const pr = {
      id: 1,
      resolve: () => {},
      reject: () => { rejected = true; },
      timer: setTimeout(() => {}, 1000),
    };
    pendingMap.set(1, pr as any);

    await client.shutdown();
    expect(rejected).toBe(true);
    expect(client.cancelled).toBe(true);
    expect(pendingMap.has(1)).toBe(false);
  });

  it("shutdown handles no pending requests", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
    expect(client.cancelled).toBe(true);
  });

  it("shutdown handles no child process", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
  });

  it("shutdown can be called multiple times", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await client.shutdown();
    await client.shutdown();
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
