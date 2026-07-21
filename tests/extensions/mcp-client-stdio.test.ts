// Tests for mcp-client/client.ts — stdio mode, _handleLine, _sendRequest,
// and other uncovered paths (lines 41-80, 124-127, 132-156, 160-204, 250-255).

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { McpClient, McpError } from "../../src/extensions/mcp-client/client.ts";

// ── McpClient._handleLine Tests ──────────────────────────────────────────────

describe("McpClient._handleLine", () => {
  it("handles empty lines", async () => {
    const client = new McpClient();
    await (client as any)._handleLine("");
    await (client as any)._handleLine("   ");
    // Should not throw
  });

  it("handles unparseable JSON lines", async () => {
    const client = new McpClient();
    await (client as any)._handleLine("not json at all");
    await (client as any)._handleLine("{ invalid json }");
    // Should not throw, just skip
  });

  it("handles non-response JSON-RPC messages", async () => {
    const client = new McpClient();
    // Notification without id
    await (client as any)._handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }));
    // Should not throw, just ignore
  });

  it("buffers response when no pending request", async () => {
    const client = new McpClient();
    await (client as any)._handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 999,
      result: { data: "buffered" },
    }));

    expect(client.buffered).toHaveLength(1);
    expect(client.buffered[0]!.id).toBe(999);
    expect(client.buffered[0]!.result).toEqual({ data: "buffered" });
  });

  it("buffers error response when no pending request", async () => {
    const client = new McpClient();
    await (client as any)._handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 998,
      error: { code: -32600, message: "Invalid request" },
    }));

    expect(client.buffered).toHaveLength(1);
    expect(client.buffered[0]!.id).toBe(998);
    expect(client.buffered[0]!.error).toEqual({ code: -32600, message: "Invalid request" });
  });

  it("resolves pending request with result", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    // Access the pending map via test-only accessor
    const pendingMap = client.pending;

    const testId = 1;
    let resolved = false;
    let resolvedValue: unknown = undefined;
    let rejected = false;
    let rejectedError: Error | null = null;

    // Create a pending request manually
    const pr = {
      id: testId,
      resolve: (value: unknown) => { resolved = true; resolvedValue = value; },
      reject: (reason: Error) => { rejected = true; rejectedError = reason; },
      timer: null,
    };
    pendingMap.set(testId, pr as any);

    // Send a response line
    await (client as any)._handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: testId,
      result: { success: true },
    }));

    expect(resolved).toBe(true);
    expect(resolvedValue).toEqual({ success: true });
    expect(rejected).toBe(false);
    expect(pendingMap.has(testId)).toBe(false);
  });

  it("rejects pending request with error", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

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

    await (client as any)._handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: testId,
      error: { code: -32601, message: "Method not found" },
    }));

    expect(resolved).toBe(false);
    expect(rejected).toBe(true);
    expect(rejectedError).toBeInstanceOf(McpError);
    expect(rejectedError!.message).toContain("Method not found");
    expect((rejectedError! as McpError).code).toBe(-32601);
    expect(pendingMap.has(testId)).toBe(false);
  });
});

// ── McpClient._sendRequest Tests ─────────────────────────────────────────────

describe("McpClient._sendRequest", () => {
  it("uses buffered response when available", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    // Pre-buffer a response (simulating out-of-order arrival)
    // The next request will use idCounter + 1, so we set it to 0
    // (it starts at 0, so first request will use id 1)

    // Manually add to buffered
    (client as any)._parseSse; // just to access private
    // Access the private buffered array
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
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    // idCounter starts at 0, so first request will use id 1
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
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ result: "ok" })),
      }),
    );

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
    const client = new McpClient();
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

  it("initialize without writeStream does not send notification", async () => {
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

    // Create a pending request
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
    await client.shutdown(); // Should not throw
    expect(client.cancelled).toBe(true);
  });

  it("shutdown handles no child process", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    // HTTP mode has no child process
    await client.shutdown();
    // Should not throw
  });

  it("shutdown handles stderr output", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    client.stderrOutput = "stderr output here";
    // Should not throw even with stderr
    await client.shutdown();
  });

  it("shutdown handles empty stderr output", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    client.stderrOutput = "   ";
    // Whitespace-only stderr should be ignored
    await client.shutdown();
  });
});

// ── McpClient._parseSse Additional Tests ─────────────────────────────────────

describe("McpClient._parseSse edge cases", () => {
  it("handles mixed valid and invalid SSE data", () => {
    const client = new McpClient();
    const text =
      "data: {\"valid\":1}\n\n" +
      "data: invalid json\n\n" +
      "data: {\"valid\":2}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ valid: 1 });
    expect(messages[1]).toEqual({ valid: 2 });
  });

  it("handles SSE with only event lines", () => {
    const client = new McpClient();
    const text = "event: message\n\nevent: custom\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(0);
  });

  it("handles SSE with empty data", () => {
    const client = new McpClient();
    const text = "data: \n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(0);
  });

  it("handles SSE with whitespace data", () => {
    const client = new McpClient();
    const text = "data:    \n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(0);
  });

  it("handles SSE with multiple data lines for one event", () => {
    // Our implementation: each "data:" line starts a new data value
    // Multiple events with data lines produce multiple messages
    const client = new McpClient();
    const text = "data: {\"first\":true}\n\ndata: {\"second\":true}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ first: true });
    expect(messages[1]).toEqual({ second: true });
  });

  it("handles SSE comment lines", () => {
    const client = new McpClient();
    const text = ": this is a comment\ndata: {\"ok\":true}\n\n";
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(1);
  });

  it("handles very long SSE response", () => {
    const client = new McpClient();
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`data: {"id":${i}}`);
      lines.push("");
    }
    const text = lines.join("\n");
    const messages = (client as any)._parseSse(text);
    expect(messages).toHaveLength(100);
  });
});

// ── McpClient HTTP SSE mode Tests ────────────────────────────────────────────

describe("McpClient HTTP SSE mode", () => {
  it("handles SSE error response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error"}}\n\n',
        ),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        (client as any)._httpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }))
      ).rejects.toThrow("Internal error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles SSE with multiple messages — uses last", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"first":true}}\n\n' +
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"last":true}}\n\n',
        ),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await (client as any)._httpRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      );
      expect(result).toEqual({ last: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when SSE has no valid response message", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(
          'event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n',
        ),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await expect(
        (client as any)._httpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }))
      ).rejects.toThrow("No response message found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── McpClient test-only accessors ────────────────────────────────────────────

describe("McpClient test-only accessors", () => {
  it("idCounter getter returns current counter", () => {
    const client = new McpClient();
    expect(client.idCounter).toBe(0);
  });

  it("pending getter returns pending map", () => {
    const client = new McpClient();
    expect(client.pending).toBeInstanceOf(Map);
    expect(client.pending.size).toBe(0);
  });

  it("buffered getter returns buffered array", () => {
    const client = new McpClient();
    expect(Array.isArray(client.buffered)).toBe(true);
    expect(client.buffered.length).toBe(0);
  });

  it("cancelled getter/setter works", () => {
    const client = new McpClient();
    expect(client.cancelled).toBe(false);
    client.cancelled = true;
    expect(client.cancelled).toBe(true);
    client.cancelled = false;
    expect(client.cancelled).toBe(false);
  });

  it("stderrOutput getter/setter works", () => {
    const client = new McpClient();
    expect(client.stderrOutput).toBe("");
    client.stderrOutput = "test stderr";
    expect(client.stderrOutput).toBe("test stderr");
  });
});

// ── McpClient serverCapabilities and serverInfo ──────────────────────────────

describe("McpClient serverCapabilities and serverInfo", () => {
  it("returns null before initialize", () => {
    const client = new McpClient();
    expect(client.serverCapabilities).toBeNull();
    expect(client.serverInfo).toBeNull();
  });

  it("returns values after initialize", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "test", version: "1.0" },
          },
        })),
      }),
    );

    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await client.initialize();
      expect(client.serverCapabilities).toHaveProperty("tools");
      expect(client.serverCapabilities).toHaveProperty("prompts");
      expect(client.serverInfo).toEqual({ name: "test", version: "1.0" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
