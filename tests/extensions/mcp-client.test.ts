// Tests for mcp-client client.ts, transports.ts (HTTP) and connection.ts (HTTP mode).
// McpTool is covered in mcp-client-tools.test.ts; stdio mode in mcp-client-stdio.test.ts;
// the extension wiring (create/hooks) in mcp-extension.test.ts.

import { describe, it, expect } from "bun:test";
import { McpClient } from "../../src/extensions/mcp-client/client.ts";
import { McpError } from "../../src/extensions/mcp-client/types.ts";
import { McpConnection } from "../../src/extensions/mcp-client/connection.ts";
import { HttpTransport, MAX_TRANSPORT_BUFFER_CHARS } from "../../src/extensions/mcp-client/transports.ts";
import { withMockFetch, jsonResponse, textResponse } from "../helpers.ts";

// ── McpError ────────────────────────────────────────────────────────────────

describe("McpError", () => {
  it("creates error with default and custom codes", () => {
    const err = new McpError("something failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something failed");
    expect(err.name).toBe("McpError");
    expect(err.code).toBeNull();
    expect(new McpError("something failed", -32600).code).toBe(-32600);
  });
});

// ── McpClient ───────────────────────────────────────────────────────────────

describe("McpClient", () => {
  it("starts with no server info", () => {
    const client = new McpClient(new HttpTransport("http://localhost:3000/mcp"));
    expect(client.serverCapabilities).toBeNull();
    expect(client.serverInfo).toBeNull();
  });

  it("forHttp creates a client with the given url and headers", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp", { "X-Custom": "header" });
    const transport = client.transport as HttpTransport;
    expect(transport.url).toBe("http://localhost:3000/mcp");
    expect(transport.headers).toEqual({ "X-Custom": "header" });
    await client.shutdown();
  });
});

// ── HttpTransport: SSE parsing ──────────────────────────────────────────────

describe("HttpTransport SSE parsing", () => {
  async function sendSse(body: string): Promise<unknown> {
    return withMockFetch(async () => textResponse(body, 200, "text/event-stream"), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      return transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }));
    });
  }

  it("parses a single SSE event", async () => {
    expect(await sendSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n')).toEqual({ ok: true });
  });

  it("returns the last of multiple SSE events", async () => {
    expect(await sendSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n')).toEqual({ b: 2 });
  });

  it("parses SSE without an explicit event line", async () => {
    expect(await sendSse('data: {"jsonrpc":"2.0","id":1,"result":{"key":"value"}}\n\n')).toEqual({ key: "value" });
  });

  it("handles trailing data without a final empty line", async () => {
    expect(await sendSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"trailing":true}}')).toEqual({ trailing: true });
  });

  it("skips unparseable data fields", async () => {
    expect(await sendSse('data: not-valid-json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"valid":true}}\n\n')).toEqual({ valid: true });
  });

  it("handles CRLF line endings", async () => {
    expect(await sendSse('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"crlf":true}}\r\n\r\n')).toEqual({ crlf: true });
  });

  it("ignores non-data SSE fields and comments", async () => {
    expect(await sendSse(': comment\nid: 123\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ignored":true}}\nretry: 5000\n\n')).toEqual({ ignored: true });
  });

  it("throws when the body has no SSE messages", async () => {
    await expect(sendSse("garbage response")).rejects.toThrow("No SSE messages found");
  });

  it("throws when SSE has only event lines or empty data", async () => {
    for (const body of ["event: message\n\nevent: custom\n\n", "data: \n\n"]) {
      await expect(sendSse(body)).rejects.toThrow("No SSE messages found");
    }
  });
});

// ── HttpTransport: direct responses and errors ──────────────────────────────

describe("HttpTransport", () => {
  it("keeps url and custom headers from construction", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp", { "X-Custom": "header" });
    expect(transport.url).toBe("http://localhost:3000/mcp");
    expect(transport.headers).toEqual({ "X-Custom": "header" });
    expect(transport.isStreaming).toBe(false);
  });

  it("returns the result from a direct JSON response", async () =>
    withMockFetch(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      const result = (await transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))) as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2025-11-25");
    }));

  it("throws McpError with status and body on non-OK responses", async () =>
    withMockFetch(async () => textResponse("Internal Server Error", 500), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      await expect(transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })))
        .rejects.toThrow("MCP HTTP error (500)");
    }));

  it("throws McpError for JSON-RPC error responses", async () =>
    withMockFetch(async () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid request" } }), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      await expect(transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" })))
        .rejects.toThrow("Invalid request");
    }));

  it("destroy is idempotent", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    await transport.destroy();
    await expect(transport.destroy()).resolves.toBeUndefined();
  });
});

// ── HttpTransport: timeout and body cap ─────────────────────────────────────

describe("HttpTransport — timeout and body cap", () => {
  it("defaults to a 30s timeout when not given", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    expect(transport.timeoutMs).toBe(30_000);
  });

  it("keeps a custom timeout from construction", () => {
    const transport = new HttpTransport("http://localhost:3000/mcp", {}, 5000);
    expect(transport.timeoutMs).toBe(5000);
  });

  it("forHttp threads the timeout into the transport", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp", {}, 4500);
    try {
      expect((client.transport as HttpTransport).timeoutMs).toBe(4500);
    } finally {
      await client.shutdown();
    }
  });

  it("rejects with a timeout McpError when the request times out", async () =>
    withMockFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }, async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp", {}, 250);
      const err = await transport.send("{}").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as Error).message).toBe("MCP HTTP request to http://localhost:3000/mcp timed out after 250ms");
    }));

  it("wraps network failures in McpError", async () =>
    withMockFetch(async () => {
      throw new Error("ECONNREFUSED");
    }, async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      const err = await transport.send("{}").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as Error).message).toBe("MCP HTTP request to http://localhost:3000/mcp failed: ECONNREFUSED");
    }));

  it("refuses to parse a body truncated at the buffer cap", async () =>
    withMockFetch(async () => textResponse("x".repeat(MAX_TRANSPORT_BUFFER_CHARS + 10), 200, "application/json"), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      await expect(transport.send("{}")).rejects.toThrow("refusing to parse a truncated body");
    }));

  it("caps oversized error bodies and notes the truncation", async () =>
    withMockFetch(async () => textResponse("x".repeat(MAX_TRANSPORT_BUFFER_CHARS + 10), 500), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      const err = await transport.send("{}").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as Error).message).toContain("MCP HTTP error (500):");
      expect((err as Error).message).toContain("[truncated]");
    }));
});

// ── McpConnection HTTP mode ─────────────────────────────────────────────────

describe("McpConnection", () => {
  const initializeResult = {
    protocolVersion: "2025-11-25",
    capabilities: {},
    serverInfo: { name: "test", version: "1.0" },
  };

  it("connectHttp initializes and discovers tools", async () => {
    const methods: string[] = [];
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      methods.push(body.method);
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: initializeResult });
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: {} } }] },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    };

    await withMockFetch(handler, async () => {
      const conn = await McpConnection.connectHttp("test-server", "http://localhost:3000/mcp");
      try {
        expect(methods).toContain("initialize");
        expect(methods).toContain("tools/list");
        expect(conn.serverName).toBe("test-server");
        expect(conn.tools.map((t) => t.name)).toEqual(["echo"]);
      } finally {
        await conn.shutdown();
      }
    });
  });

  it("connectHttp sends custom headers", async () => {
    const headersSeen: Record<string, string> = {};
    const handler = async (_url: string, opts?: RequestInit) => {
      if (opts?.headers) {
        for (const [k, v] of Object.entries(opts.headers as Record<string, string>)) headersSeen[k] = v;
      }
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: initializeResult });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    };

    await withMockFetch(handler, async () => {
      const conn = await McpConnection.connectHttp("test-server", "http://localhost:3000/mcp", { Authorization: "Bearer token" });
      try {
        expect(headersSeen["Authorization"]).toBe("Bearer token");
      } finally {
        await conn.shutdown();
      }
    });
  });

  it("discoverTools follows pagination cursors", async () => {
    let listCalls = 0;
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: initializeResult });
      }
      if (body.method === "tools/list") {
        listCalls++;
        if (listCalls === 1) {
          return jsonResponse({
            jsonrpc: "2.0", id: body.id,
            result: { tools: [{ name: "tool1", description: "", inputSchema: {} }], nextCursor: "cursor1" },
          });
        }
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { tools: [{ name: "tool2", description: "", inputSchema: {} }] },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    };

    await withMockFetch(handler, async () => {
      const conn = await McpConnection.connectHttp("test-server", "http://localhost:3000/mcp");
      try {
        expect(conn.tools.map((t) => t.name)).toEqual(["tool1", "tool2"]);
        expect(listCalls).toBe(2);
      } finally {
        await conn.shutdown();
      }
    });
  });
});

// ── McpConnectionHandle (via HTTP) ──────────────────────────────────────────

describe("McpConnectionHandle", () => {
  const initializeResult = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test" } };

  /** Connect, run `withHandle` on the live handle, then shut the connection down. */
  async function withConnectedHandle<T>(toolCallResult: Record<string, unknown>, withHandle: (handle: ReturnType<McpConnection["handle"]>) => Promise<T>): Promise<T> {
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: initializeResult });
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { tools: [{ name: "echo", description: "", inputSchema: {} }] },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: toolCallResult });
    };
    return withMockFetch(handler, async () => {
      const conn = await McpConnection.connectHttp("test-server", "http://localhost:3000/mcp");
      try {
        return await withHandle(conn.handle());
      } finally {
        await conn.shutdown();
      }
    });
  }

  it("callTool forwards arguments and returns the text content", async () => {
    const result = await withConnectedHandle(
      { content: [{ type: "text", text: "echo result" }], isError: false },
      (handle) => handle.callTool("echo", { message: "hello" }),
    );
    expect(result).toBe("echo result");
  });

  it("callTool throws the server error message on isError responses", async () => {
    await expect(
      withConnectedHandle(
        { content: [{ type: "text", text: "something went wrong" }], isError: true },
        (handle) => handle.callTool("echo", {}),
      ),
    ).rejects.toThrow("something went wrong");
  });
});
