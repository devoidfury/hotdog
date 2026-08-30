// Tests for mcp-client — stdio mode, message handling, _sendRequest,
// and other paths.

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import { McpClient } from "../../src/extensions/mcp-client/client.ts";
import { McpConnection } from "../../src/extensions/mcp-client/connection.ts";
import { HttpTransport, StdioTransport } from "../../src/extensions/mcp-client/transports.ts";
import { tmpDir, cleanupDir, processAlive, waitForExit, withMockFetch, jsonResponse, textResponse } from "../helpers.ts";

// ── McpClient._sendRequest Tests ─────────────────────────────────────────────

describe("McpClient._sendRequest", () => {

  it("increments id counter for each request", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await withMockFetch(async () => jsonResponse({ result: "ok" }), async () => {
      const initialId = client.idCounter;
      await (client as any)._sendRequest("method1", {});
      await (client as any)._sendRequest("method2", {});
      await (client as any)._sendRequest("method3", {});
      expect(client.idCounter).toBe(initialId + 3);
    });
    await client.shutdown();
  });

  it("throws McpError when cancelled", async () => {
    const transport = new HttpTransport("http://localhost:3000/mcp");
    const client = new McpClient(transport);
    client.cancelled = true;

    await expect((client as any)._sendRequest("test", {})).rejects.toThrow("Client is cancelled");
  });

  it("HTTP mode sends correct headers", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    const client = await McpClient.forHttp("http://localhost:3000/mcp", {
      "X-Custom-Header": "custom-value",
      "Authorization": "Bearer token",
    });

    await withMockFetch(async (_url, opts) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      return jsonResponse({ result: "ok" });
    }, async () => {
      await (client as any)._sendRequest("test/method", { param: "value" });
    });
    await client.shutdown();

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
    expect(capturedHeaders!["Accept"]).toBe("application/json, text/event-stream");
    expect(capturedHeaders!["X-Custom-Header"]).toBe("custom-value");
    expect(capturedHeaders!["Authorization"]).toBe("Bearer token");
  });

  it("HTTP mode sends correct request body", async () => {
    let capturedBody: string | null = null;
    const client = await McpClient.forHttp("http://localhost:3000/mcp");

    await withMockFetch(async (_url, opts) => {
      capturedBody = opts?.body as string;
      return jsonResponse({ result: "ok" });
    }, async () => {
      await (client as any)._sendRequest("tools/call", { name: "echo", arguments: { text: "hello" } });
    });
    await client.shutdown();

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params).toHaveProperty("name", "echo");
    expect(parsed.params).toHaveProperty("arguments", { text: "hello" });
  });
});

// ── McpClient.initialize Tests ───────────────────────────────────────────────

describe("McpClient.initialize", () => {
  it("sends initialize request and stores server info", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await withMockFetch(async () => jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test-server", version: "1.0.0" },
      },
    }), async () => {
      const result = await client.initialize();
      expect((result as any).protocolVersion).toBe("2025-11-25");
      expect((result as any).capabilities).toHaveProperty("tools");
      expect((result as any).serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
      // Server capabilities/info are stored on the client for later use.
      expect(client.serverCapabilities).toHaveProperty("tools");
      expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
    });
    await client.shutdown();
  });

  it("initialize works without a streaming transport (no initialized notification)", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await withMockFetch(async () => jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "test" },
      },
    }), async () => {
      const result = await client.initialize();
      expect(result).not.toBeNull();
      // Missing version falls back to the "unknown" default.
      expect(client.serverInfo).toEqual({ name: "test", version: "unknown" });
      // No tools capability advertised, so it stays null.
      expect((client.serverCapabilities as Record<string, unknown>).tools).toBeNull();
    });
    await client.shutdown();
  });
});

// ── McpClient.listTools Tests ────────────────────────────────────────────────

describe("McpClient.listTools", () => {
  it("returns parsed tools list", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await withMockFetch(async () => jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "echo", description: "Echo tool", inputSchema: { type: "object" } },
          { name: "greet", description: "Greet tool", inputSchema: { type: "object" } },
        ],
      },
    }), async () => {
      const result = await client.listTools();
      expect((result as any).tools.map((t: any) => t.name)).toEqual(["echo", "greet"]);
    });
    await client.shutdown();
  });
});

// ── McpClient.callTool Tests ─────────────────────────────────────────────────

describe("McpClient.callTool", () => {
  it("returns tool call result", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    await withMockFetch(async () => jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "Hello, World!" }] },
    }), async () => {
      const result = await client.callTool("echo", { text: "Hello, World!" });
      expect((result as any).content).toEqual([{ type: "text", text: "Hello, World!" }]);
    });
    await client.shutdown();
  });
});

// ── HttpTransport SSE Edge Cases ─────────────────────────────────────────────

describe("HttpTransport SSE edge cases", () => {
  async function sendSse(body: string): Promise<unknown> {
    return withMockFetch(async () => textResponse(body, 200, "text/event-stream"), async () => {
      const transport = new HttpTransport("http://localhost:3000/mcp");
      return transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }));
    });
  }

  it("returns the last valid message from mixed valid and invalid SSE data", async () => {
    expect(await sendSse('data: {"jsonrpc":"2.0","id":1,"result":{"valid":1}}\n\ndata: invalid json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"valid":2}}\n\n')).toEqual({ valid: 2 });
  });

  it("throws when SSE has no parseable data", async () => {
    await expect(sendSse("event: message\n\nevent: custom\n\n")).rejects.toThrow("No SSE messages found");
    await expect(sendSse("data: \n\n")).rejects.toThrow("No SSE messages found");
  });

  it("ignores SSE comment lines", async () => {
    expect(await sendSse(': this is a comment\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n')).toEqual({ ok: true });
  });
});

// ── Transport basics ─────────────────────────────────────────────────────────

describe("Transport basics", () => {
  it("exposes isStreaming per transport type", async () => {
    const stdio = new StdioTransport("echo");
    expect(stdio.isStreaming).toBe(true);
    await stdio.destroy();
    expect(new HttpTransport("http://localhost:3000/mcp").isStreaming).toBe(false);
  });

  it("client.transport accessor returns the underlying transport", async () => {
    const client = await McpClient.forHttp("http://localhost:3000/mcp");
    expect(client.transport).toBeInstanceOf(HttpTransport);
    await client.shutdown();
  });
});

// ── McpClient forStdio Tests ─────────────────────────────────────────────────

describe("McpClient.forStdio", () => {
  it("creates client with stdio transport", async () => {
    const client = await McpClient.forStdio("bun", [
      "--preload",
      "./tests/setup.ts",
      "./tests/fixtures/mcp-test-server.ts",
    ]);
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
  // Subprocess spawn time varies wildly on cold runners; never rely on a fixed sleep.
  async function until(cond: () => boolean, timeoutMs = 5000) {
    const start = Date.now();
    while (!cond() && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("sends messages to subprocess stdin and receives the response", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"]);
    const lines: string[] = [];
    const removeHandler = transport.onMessage((line) => lines.push(line));
    try {
      await transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
      // Wait for the server's initialize response instead of a fixed sleep.
      const start = Date.now();
      while (lines.length === 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const reply = JSON.parse(lines[0]!);
      expect(reply.id).toBe(1);
      expect(reply.result.serverInfo.name).toBe("test-server");
    } finally {
      removeHandler();
      await transport.destroy();
    }
  });

  it("throws when sending to destroyed transport", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"]);
    await transport.destroy();
    await expect(transport.send("test")).rejects.toThrow("Transport is destroyed");
  });

  it("receives messages from subprocess stdout", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.log('hello world')"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await until(() => receivedLines.includes("hello world"));
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toContain("hello world");
  });

  it("handles multiple messages", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.log('line1'); console.log('line2'); console.log('line3');"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await until(() => receivedLines.length === 3);
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toEqual(["line1", "line2", "line3"]);
  });

  it("scrubs sensitive process env vars from the subprocess environment", async () => {
    process.env.HOTDOG_TEST_FAKE_TOKEN = "should-not-leak";
    process.env.TEST_SCRUB_SAFE_VAR = "safe-value";
    try {
      const transport = new StdioTransport(
        "bun",
        ["-e", "console.log(JSON.stringify({secret: process.env.HOTDOG_TEST_FAKE_TOKEN ?? 'ABSENT', safe: process.env.TEST_SCRUB_SAFE_VAR ?? 'ABSENT', override: process.env.TEST_SCRUB_OVERRIDE ?? 'ABSENT'}))"],
        { TEST_SCRUB_OVERRIDE: "explicit" },
      );
      const lines: string[] = [];
      const removeHandler = transport.onMessage((line) => lines.push(line));
      await until(() => lines.length > 0);
      removeHandler();
      await transport.destroy();

      const data = JSON.parse(lines[0]!);
      expect(data.secret).toBe("ABSENT");
      expect(data.safe).toBe("safe-value");
      // Caller-supplied env (user config) is trusted and merged on top.
      expect(data.override).toBe("explicit");
    } finally {
      delete process.env.HOTDOG_TEST_FAKE_TOKEN;
      delete process.env.TEST_SCRUB_SAFE_VAR;
    }
  });

  it("kills grandchild processes on destroy (process group)", async () => {
    const dir = tmpDir("hotdog-mcp-group-");
    const pidFile = `${dir}/pid`;
    try {
      // sh plays the MCP server; the backgrounded sleep is a worker it
      // spawned. destroy() must take down the whole group, not just sh --
      // otherwise the worker leaks when the server goes away.
      const transport = new StdioTransport(
        "sh",
        ["-c", `sleep 300 & echo $! > ${pidFile}; cat`],
      );

      // Poll until the file holds a full pid: under load the file can exist
      // momentarily empty before `echo $!` finishes writing it.
      const start = Date.now();
      let workerPid = NaN;
      while (Number.isNaN(workerPid)) {
        if (Date.now() - start > 5000) throw new Error("worker pid never written");
        const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf-8").trim() : "";
        if (/^\d+$/.test(raw)) workerPid = parseInt(raw, 10);
        else await new Promise((r) => setTimeout(r, 20));
      }
      expect(processAlive(workerPid)).toBe(true);

      await transport.destroy();

      await waitForExit(workerPid);
      expect(processAlive(workerPid)).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  }, 15000);

  it("skips empty lines", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.log(''); console.log(''); console.log('line'); console.log('');"]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    await until(() => receivedLines.length > 0);
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toEqual(["line"]);
  });

  it("supports multiple message handlers", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.log('multi-handler-test')"]);
    const handler1Lines: string[] = [];
    const handler2Lines: string[] = [];

    const remove1 = transport.onMessage((line) => handler1Lines.push(line));
    const remove2 = transport.onMessage((line) => handler2Lines.push(line));

    await until(() => handler1Lines.length > 0 && handler2Lines.length > 0);
    remove1();
    remove2();
    await transport.destroy();

    expect(handler1Lines).toEqual(handler2Lines);
    expect(handler1Lines.length).toBeGreaterThan(0);
  });

  it("stops delivering lines to a removed handler but not others", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.log('a'); setTimeout(() => { console.log('b'); console.log('c'); }, 100);"]);
    const handler1Lines: string[] = [];
    const handler2Lines: string[] = [];

    const remove1 = transport.onMessage((line) => handler1Lines.push(line));
    const remove2 = transport.onMessage((line) => handler2Lines.push(line));

    // Wait for "a" to be delivered to both handlers, then remove handler1.
    const start = Date.now();
    while (handler1Lines.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    remove1();

    // Wait for the delayed lines to arrive.
    const start2 = Date.now();
    while (handler2Lines.length < 3 && Date.now() - start2 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    remove2();
    await transport.destroy();

    // Handler1 got only "a"; handler2 got everything.
    expect(handler1Lines).toEqual(["a"]);
    expect(handler2Lines).toEqual(["a", "b", "c"]);
  });

  it("sendNotification is no-op after destroy", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"]);
    await transport.destroy();
    expect(() => transport.sendNotification("test")).not.toThrow();
  });

  it("onClose registers close handler", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"]);
    let closed = false;
    const removeHandler = transport.onClose(() => { closed = true; });
    await transport.destroy();
    removeHandler();
    expect(closed).toBe(true);
  });

  it("destroy can be called multiple times", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"]);
    await transport.destroy();
    await expect(transport.destroy()).resolves.toBeUndefined();
  });

  it("exposes command and args", async () => {
    const transport = new StdioTransport("bun", ["./tests/fixtures/mcp-test-server.ts"], { KEY: "val" });
    expect(transport.command).toBe("bun");
    expect(transport.args).toEqual(["./tests/fixtures/mcp-test-server.ts"]);
    expect(transport.env).toHaveProperty("KEY", "val");
    await transport.destroy();
  });

  it("captures stderr output", async () => {
    const transport = new StdioTransport("bun", ["-e", "console.error('error-msg')"]);
    await until(() => transport.stderrOutput.includes("error-msg"));
    expect(transport.stderrOutput).toContain("error-msg");
    await transport.destroy();
  });

  it("discards an oversized stdout line and keeps framing for later lines", async () => {
    // A 5MB line (2.5x MAX_TRANSPORT_BUFFER_CHARS of 2_000_000) must be
    // drained, not buffered, and the messages after it must still arrive
    // correctly framed.
    const transport = new StdioTransport("bun", [
      "-e",
      "console.log('before'); console.log('x'.repeat(5000000)); console.log('after');",
    ]);
    const receivedLines: string[] = [];
    const removeHandler = transport.onMessage((line) => {
      receivedLines.push(line);
    });

    const start = Date.now();
    while (receivedLines.length < 2 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    removeHandler();
    await transport.destroy();

    expect(receivedLines).toEqual(["before", "after"]);
  });

  it("caps stderr accumulation at the transport buffer limit", async () => {
    // 2.5MB of stderr (cap is MAX_TRANSPORT_BUFFER_CHARS of 2_000_000) must
    // stop accumulating once the cap is hit.
    const transport = new StdioTransport("bun", [
      "-e",
      "process.stderr.write('e'.repeat(2500000));",
    ]);

    const start = Date.now();
    while (!transport.stderrTruncated && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await transport.destroy();

    expect(transport.stderrTruncated).toBe(true);
    expect(transport.stderrOutput.length).toBe(2000000);
    expect(transport.stderrOutput).toBe("e".repeat(2000000));
  });
});

// ── Stdio McpClient Integration Tests ────────────────────────────────────────

describe("McpClient stdio integration", () => {
  it("buffers unsolicited responses (no matching pending request)", async () => {
    // A response whose id matches no pending request is buffered for later.
    const client = await McpClient.forStdio("bun", ["-e", "console.log(JSON.stringify({jsonrpc:'2.0',id:999,result:{data:'buffered'}}))"]);

    const start = Date.now();
    while (client.buffered.length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    try {
      expect(client.buffered.map((b) => b.id)).toEqual([999]);
    } finally {
      await client.shutdown();
    }
  });

  it("tolerates empty, non-JSON, and notification lines from the subprocess", async () => {
    // A misbehaving server must not crash the client: empty lines,
    // non-JSON lines, and id-less notifications are all ignored.
    const client = await McpClient.forStdio("bun", [
      "-e",
      "console.log(''); console.log('not valid json'); console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}));",
    ]);
    await new Promise((r) => setTimeout(r, 50));
    await expect(client.shutdown()).resolves.toBeUndefined();
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
    expect(() => transport.sendNotification("test")).not.toThrow();
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
    const conn = await McpConnection.connectStdio("test", "bun", ["./tests/fixtures/mcp-test-server.ts"]);
    expect(conn.serverName).toBe("test");
    expect(conn.tools).toEqual([]);
    await conn.shutdown();
  });
});
