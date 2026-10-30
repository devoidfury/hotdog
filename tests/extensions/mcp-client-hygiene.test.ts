// MCP client hygiene (improvement #10) -- negative cases:
//   1. Flooded buffered responses are capped and fail the connection cleanly
//      (no unbounded growth, no 30s-timeout limbo).
//   2. The stdio request timeout is configurable (config:
//      mcpClient.requestTimeoutSecs), defaulting to the historic 30s.
//   3. Transport close fails pending requests promptly -- a dead server
//      process is discovered at close, not at timeout.

import { describe, it, expect } from "bun:test";
import { McpClient, MAX_BUFFERED_RESPONSES, resolveRequestTimeoutMs } from "@extensions/mcp-client/client.ts";
import { McpConnection, MAX_DISCOVERED_TOOLS } from "@extensions/mcp-client/connection.ts";
import { StdioTransport } from "@extensions/mcp-client/transports.ts";
import { create } from "@extensions/mcp-client/index.ts";
import { processAlive, waitForExit, withMockFetch, jsonResponse } from "../helpers.ts";
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
    const client = await McpClient.forStdio("bun", 30_000, [
      "-e",
      `const seen = new Set(); let n = 0; ` +
        `setInterval(() => { n++; console.log(JSON.stringify({jsonrpc:"2.0",id:900000+n,result:{x:n}})); }, 0);`,
    ]);
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
    const client = await McpClient.forStdio("bun", 30_000, [
      "-e",
      `console.log(JSON.stringify({jsonrpc:"2.0",id:999,result:{data:'buffered'}})); setTimeout(() => {}, 15000);`,
    ]);
    try {
      // Poll until the reader dispatches the line (bounded), instead of a fixed nap.
      const deadline = t0() + 3000;
      while (client.buffered.length === 0 && t0() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(client.buffered.length).toBe(1);
      expect(client.transportClosed).toBe(false);
    } finally {
      await client.shutdown();
    }
  });
});

describe("stdio request timeout is config, default 30s", () => {
  it("the default is the historic 30_000 ms", async () => {
    const client = await McpClient.forStdio("bun", resolveRequestTimeoutMs(undefined), [
      "-e",
      "setTimeout(() => {}, 5000);",
    ]);
    try {
      expect(client.requestTimeoutMs).toBe(30_000);
      expect(resolveRequestTimeoutMs(undefined)).toBe(30_000); // the sanitized-default home
    } finally {
      await client.shutdown();
    }
  });

  it("a short resolved timeout fires promptly on a silent server", async () => {
    // requestTimeoutMs as the extension would pass it: resolved 0.25s -> 250ms
    const client = await McpClient.forStdio("bun", resolveRequestTimeoutMs(0.25), [
      "-e",
      "setTimeout(() => {}, 15000);",
    ]);
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
        requestTimeoutMs?: number,
        _args?: string[],
        _env?: Record<string, string>,
        _extra?: readonly string[],
        _scrubbing?: boolean,
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
          requestTimeoutMs?: number,
          _args?: string[],
          _env?: Record<string, string>,
          _extra?: readonly string[],
          _scrubbing?: boolean,
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
    const client = await McpClient.forStdio("bun", 30_000, [
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
    const client = await McpClient.forStdio("bun", 30_000, ["-e", "process.exit(0)"]);
    try {
      // Poll until the death notice lands (bounded), instead of a fixed nap.
      const deadline = t0() + 3000;
      while (!client.transportClosed && t0() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
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


// ── SF-01: destroy() escalates SIGTERM to SIGKILL (2026-10-28 review) ──────

/** Resolve once the transport has delivered its first stdout line. */
function ready(transport: StdioTransport, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = transport.onMessage(() => {
      cleanup();
      resolve();
    });
    setTimeout(() => {
      cleanup();
      reject(new Error("fake MCP server never became ready"));
    }, timeoutMs);
  });
}

describe("SIGTERM-trapping server is reaped on destroy (SF-01)", () => {
  // bun plays the third-party server: it ignores SIGTERM outright, so only
  // the grace-period SIGKILL escalation can take it down.
  const TRAP_SCRIPT = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 30000);";

  it("escalates to SIGKILL within the (injected) grace window", async () => {
    const transport = new StdioTransport("bun", ["-e", TRAP_SCRIPT], {}, undefined, true, 1000);
    try {
      await ready(transport);
      const pid = transport.child.pid!;
      const started = t0();
      await transport.destroy();
      expect(transport.killTimerArmed).toBe(true);
      // TERM is trapped: nothing happened yet, well inside the grace window.
      await new Promise((r) => setTimeout(r, 150));
      expect(processAlive(pid)).toBe(true);
      await waitForExit(pid, 5000);
      expect(processAlive(pid)).toBe(false);
      // Reaped by the escalation, not by the 2s default or a hang.
      expect(t0() - started).toBeLessThan(5000);
    } finally {
      await transport.destroy();
    }
  }, 15000);

  it("destroy stays idempotent while the escalation is armed", async () => {
    const transport = new StdioTransport("bun", ["-e", TRAP_SCRIPT], {}, undefined, true, 700);
    try {
      await ready(transport);
      const pid = transport.child.pid!;
      await transport.destroy();
      await expect(transport.destroy()).resolves.toBeUndefined();
      // Second destroy() must not re-arm a competing timer.
      expect(transport.killTimerArmed).toBe(true);
      await waitForExit(pid, 5000);
      expect(processAlive(pid)).toBe(false);
      expect(transport.killTimerArmed).toBe(false);
    } finally {
      await transport.destroy();
    }
  }, 15000);

  it("the grace timer is cleared when the child exits from TERM first", async () => {
    // Obeys TERM and exits promptly: with a 30s grace nobody should be left
    // holding a timer (or signaling a dead group) for half a minute.
    const transport = new StdioTransport(
      "bun",
      ["-e", "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 30000);"],
      {}, undefined, true, 30_000,
    );
    try {
      await ready(transport);
      await transport.destroy();
      const deadline = t0() + 3000;
      while (transport.killTimerArmed && t0() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transport.killTimerArmed).toBe(false);
    } finally {
      await transport.destroy();
    }
  }, 15000);

  it("no timer is armed for an already-dead child", async () => {
    const transport = new StdioTransport("bun", ["-e", "process.exit(0)"]);
    const deadline = t0() + 3000;
    while (!transport.exited && t0() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(transport.exited).toBe(true);
    await transport.destroy();
    expect(transport.killTimerArmed).toBe(false);
  }, 15000);
});

// ── SF-02: tools/list pagination is bounded (2026-10-28 review) ─────────────

describe("tools/list pagination bounds (SF-02)", () => {
  const initializeResult = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "t" } };
  const tool = (name: string) => ({ name, description: "", inputSchema: {} });
  const ok = (id: unknown, result: Record<string, unknown>) =>
    jsonResponse({ jsonrpc: "2.0", id, result });

  it("normal multi-page tools/list aggregates every page", async () => {
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      const cursor = (body.params as Record<string, unknown> | undefined)?.cursor;
      if (!cursor) return ok(body.id, { tools: [tool("a"), tool("b")], nextCursor: "c1" });
      if (cursor === "c1") return ok(body.id, { tools: [tool("c")], nextCursor: "c2" });
      if (cursor === "c2") return ok(body.id, { tools: [tool("d")] });
      throw new Error(`unexpected cursor ${String(cursor)}`);
    };
    await withMockFetch(handler, async () => {
      const conn = await McpConnection.connectHttp("paged", "http://localhost:1/mcp", 5000);
      try {
        expect(conn.tools.map((t) => t.name)).toEqual(["a", "b", "c", "d"]);
      } finally {
        await conn.shutdown();
      }
    });
  });

  it("a constant nextCursor aborts the loop instead of hanging", async () => {
    let listCalls = 0;
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      listCalls++;
      return ok(body.id, { tools: [tool("x")], nextCursor: "loop" });
    };
    await withMockFetch(handler, async () => {
      const started = t0();
      const err = await McpConnection
        .connectHttp("loop-server", "http://localhost:1/mcp", 5000)
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repeated tools\/list cursor/);
      expect(err!.message).toContain("loop-server");
      // Aborts on the second page: round-trips are bounded, not "run for a
      // while then bail".
      expect(listCalls).toBe(2);
      expect(t0() - started).toBeLessThan(5000);
    });
  });

  it("an oscillating cursor cycle is caught too", async () => {
    let listCalls = 0;
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      listCalls++;
      // c1, c2, c1, c2, ... -- the loop closes on the revisit.
      return ok(body.id, { tools: [tool("x")], nextCursor: listCalls % 2 ? "c1" : "c2" });
    };
    await withMockFetch(handler, async () => {
      const err = await McpConnection
        .connectHttp("osc-server", "http://localhost:1/mcp", 5000)
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repeated tools\/list cursor "c1"/);
      expect(listCalls).toBe(3);
    });
  });

  it("the total-tools cap trips on a fat-pages server", async () => {
    let listCalls = 0;
    const fatPage = () =>
      Array.from({ length: 600 }, (_, i) => tool(`t${listCalls}_${i}`));
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      listCalls++;
      // Distinct cursors evade repeat detection; only the ceiling saves us.
      return ok(body.id, { tools: fatPage(), nextCursor: `p${listCalls}` });
    };
    await withMockFetch(handler, async () => {
      const err = await McpConnection
        .connectHttp("fat-server", "http://localhost:1/mcp", 5000)
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(new RegExp(`exceeded the ${MAX_DISCOVERED_TOOLS}-tool discovery cap`));
      expect(err!.message).toContain("fat-server");
      // 600 tools/page: cap trips right after the second page.
      expect(listCalls).toBe(2);
    });
  });

  it("the page-count cap trips on distinct-cursor pagination", async () => {
    let listCalls = 0;
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      listCalls++;
      return ok(body.id, { tools: [tool(`t${listCalls}`)], nextCursor: `c${listCalls}` });
    };
    await withMockFetch(handler, async () => {
      const err = await McpConnection
        .connectHttp("endless-server", "http://localhost:1/mcp", 5000)
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/page tools\/list cap/);
      expect(err!.message).toContain("endless-server");
      expect(listCalls).toBeLessThanOrEqual(101);
    });
  }, 15000);

  it("a looping cursor surfaces as a per-server connection failure, not an unhandled rejection", async () => {
    // Drives the real extension path: create() + TOOLS_REGISTER against a
    // constant-cursor server. The failure must be caught per server (logged,
    // skipped) with zero tools registered -- bun:test fails on unhandled
    // rejections, so this also pins that half of the contract.
    const handler = async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (body.method === "initialize") return ok(body.id, initializeResult);
      return ok(body.id, { tools: [tool("x")], nextCursor: "loop" });
    };
    const core = {
      config: {
        mcpServers: [{ name: "loopy", url: "http://localhost:1/mcp" }],
        mcpClient: { httpTimeoutSecs: 5, requestTimeoutSecs: 5 },
      },
      hooks: { on: () => () => {}, notifyHooks: () => {} },
    } as never;
    const ext = create(core);
    const registered: string[] = [];
    const toolsRegister = ext?.hooks?.["tools:register"] as (r: unknown) => Promise<void>;
    await withMockFetch(handler, async () => {
      await toolsRegister({ register: (name: string) => registered.push(name) });
    });
    expect(registered).toEqual([]);
    await (ext as unknown as { shutdown?: () => Promise<void> }).shutdown?.();
  });
});
