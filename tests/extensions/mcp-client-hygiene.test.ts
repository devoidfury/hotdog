// MCP client hygiene (improvement #10) -- negative cases:
//   1. Flooded buffered responses are capped and fail the connection cleanly
//      (no unbounded growth, no 30s-timeout limbo).
//   2. The stdio request timeout is configurable (config:
//      mcpClient.requestTimeoutSecs), defaulting to the historic 30s.
//   3. Transport close fails pending requests promptly -- a dead server
//      process is discovered at close, not at timeout.

import { describe, it, expect } from "bun:test";
import { McpClient, DEFAULT_REQUEST_TIMEOUT_MS, MAX_BUFFERED_RESPONSES } from "@extensions/mcp-client/client.ts";
import { McpConnection } from "@extensions/mcp-client/connection.ts";
import { create } from "@extensions/mcp-client/index.ts";
import type { McpConnectionHandle } from "@extensions/mcp-client/connection.ts";

const t0 = () => Date.now();

/** Fire TOOLS_REGISTER on a created extension instance (typed loosely on purpose). */
async function callToolsRegister(ext: { hooks?: Record<string, unknown> } | null): Promise<void> {
  const fn = ext?.hooks?.["tools:register"] as ((registry: unknown) => Promise<void>) | undefined;
  if (!fn) throw new Error("tools:register hook missing");
  await fn({ register: () => {} });
}

describe("buffered-response flood (bounded read buffer)", () => {
  it("more than MAX_BUFFERED_RESPONSES unmatched responses fail the connection, not memory", async () => {
    // Server spews unmatched responses continuously (ids no request owns).
    // A continuous drip is deliberate: a single synchronous burst can sit in
    // the pipe unflushed, which would test the harness instead of the cap.
    const client = await McpClient.forStdio(
      "bun",
      [
        "-e",
        `const seen = new Set(); let n = 0; ` +
          `setInterval(() => { n++; console.log(JSON.stringify({jsonrpc:"2.0",id:900000+n,result:{x:n}})); }, 0);`,
      ],
    );
    try {
      // The request in flight must reject with the flood error -- not sit
      // until the response timeout, and never buffer past the cap.
      const started = t0();
      let err: Error | null = null;
      try {
        await (client as unknown as { _sendRequest(m: string, p: unknown): Promise<unknown> })
          ._sendRequest("tools/list", {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      // Flood-fail or transport-close after the flood tore the connection
      // down -- never a timeout hang (well under the 30s default).
      expect(err!.message).toMatch(/no matching request|unmatched responses|transport closed|Transport is destroyed/);
      expect(t0() - started).toBeLessThan(10_000);
      expect(client.transportClosed).toBe(true);
      // The buffer stays bounded: cleared on the flood fail.
      expect(client.buffered.length).toBeLessThanOrEqual(MAX_BUFFERED_RESPONSES);
    } finally {
      await client.shutdown();
    }
  });

  it("a normal unmatched response still buffers (the cap is not the door)", async () => {
    const client = await McpClient.forStdio("bun", [
      "-e",
      `console.log(JSON.stringify({jsonrpc:"2.0",id:999,result:{data:'buffered'}})); setTimeout(() => {}, 15000);`,
    ]);
    try {
      // Give the reader a beat to dispatch the line.
      await new Promise((r) => setTimeout(r, 150));
      expect(client.buffered.length).toBe(1);
      expect(client.transportClosed).toBe(false);
    } finally {
      await client.shutdown();
    }
  });
});

describe("stdio request timeout is config, default 30s", () => {
  it("the default is the historic 30_000 ms", async () => {
    const client = await McpClient.forStdio("bun", ["-e", "setTimeout(() => {}, 5000);"]);
    try {
      expect(client.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    } finally {
      await client.shutdown();
    }
  });

  it("a short resolved timeout fires promptly on a silent server", async () => {
    const client = await McpClient.forStdio(
      "bun",
      ["-e", "setTimeout(() => {}, 15000);"],
      {},
      undefined,
      true,
      250, // resolved from mcpClient.requestTimeoutSecs (0.25 here)
    );
    try {
      const started = t0();
      await expect(
        (client as unknown as { _sendRequest(m: string, p: unknown): Promise<unknown> })
          ._sendRequest("tools/list", {}),
      ).rejects.toThrow(/Timeout/);
      expect(t0() - started).toBeLessThan(5_000);
    } finally {
      await client.shutdown();
    }
  });

  it("the extension passes resolved mcpClient.requestTimeoutSecs (in ms) to connectStdio", async () => {
    let seenTimeout: unknown = "unset";
    class FakeConnection {
      tools: Record<string, unknown>[] = [];
      static async connectStdio(
        _name: string,
        _command: string,
        _args: string[],
        _env: Record<string, string>,
        _extra?: readonly string[],
        _scrubbing?: boolean,
        requestTimeoutMs?: number,
      ): Promise<McpConnection> {
        seenTimeout = requestTimeoutMs;
        return {
          tools: [],
          handle: () => ({ callTool: async () => "ok" }) as unknown as McpConnectionHandle,
          shutdown: async () => {},
        } as unknown as McpConnection;
      }
      static async connectHttp(): Promise<McpConnection> {
        throw new Error("unused");
      }
    }
    const core = {
      config: {
        mcpServers: [{ name: "s1", command: "noop" }],
        mcpClient: { requestTimeoutSecs: 45 },
      },
      hooks: { on: () => () => {}, notifyHooks: () => {} },
    } as never;
    const ext = create(core, { Connection: FakeConnection as unknown as typeof McpConnection });
    await callToolsRegister(ext);
    expect(seenTimeout).toBe(45_000);
  });

  it("invalid requestTimeoutSecs falls back to 30s (never \"no timeout\")", async () => {
    for (const bad of [0, -5, "45", null, NaN]) {
      let seenTimeout: unknown = "unset";
      class FakeConnection {
        tools: Record<string, unknown>[] = [];
        static async connectStdio(
          _name: string,
          _command: string,
          _args: string[],
          _env: Record<string, string>,
          _extra?: readonly string[],
          _scrubbing?: boolean,
          requestTimeoutMs?: number,
        ): Promise<McpConnection> {
          seenTimeout = requestTimeoutMs;
          return {
            tools: [],
            handle: () => ({ callTool: async () => "ok" }) as unknown as McpConnectionHandle,
            shutdown: async () => {},
          } as unknown as McpConnection;
        }
        static async connectHttp(): Promise<McpConnection> {
          throw new Error("unused");
        }
      }
      const core = {
        config: {
          mcpServers: [{ name: "s1", command: "noop" }],
          mcpClient: { requestTimeoutSecs: bad },
        },
        hooks: { on: () => () => {}, notifyHooks: () => {} },
      } as never;
      const ext = create(core, { Connection: FakeConnection as unknown as typeof McpConnection });
      await callToolsRegister(ext);
      expect(seenTimeout, `requestTimeoutSecs=${String(bad)}`).toBe(30_000);
    }
  });
});

describe("fail-fast on transport close", () => {
  it("a pending request rejects when the server process dies, long before timeout", async () => {
    // The server exits after 100ms without ever answering. The response
    // timeout stays at the 30s default -- the rejection must NOT wait for it.
    const client = await McpClient.forStdio("bun", [
      "-e",
      "setTimeout(() => process.exit(0), 100);",
    ]);
    try {
      const started = t0();
      let err: Error | null = null;
      try {
        await (client as unknown as { _sendRequest(m: string, p: unknown): Promise<unknown> })
          ._sendRequest("tools/list", {});
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/transport closed/i);
      expect(t0() - started).toBeLessThan(10_000); // vs the 30s timeout
      expect(client.transportClosed).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  it("requests after the close fail immediately too (no timeout limbo per call)", async () => {
    const client = await McpClient.forStdio("bun", ["-e", "process.exit(0)"]);
    try {
      // Let the death notice land.
      await new Promise((r) => setTimeout(r, 250));
      expect(client.transportClosed).toBe(true);
      const started = t0();
      await expect(
        (client as unknown as { _sendRequest(m: string, p: unknown): Promise<unknown> })
          ._sendRequest("tools/list", {}),
      ).rejects.toThrow(/transport closed/i);
      expect(t0() - started).toBeLessThan(2_000);
    } finally {
      await client.shutdown();
    }
  });
});
