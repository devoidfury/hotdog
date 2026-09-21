// MCP 2025-11-25 + JSON-RPC 2.0 conformance for src/extensions/mcp-client/.
//
// Oracle: official example messages vendored from the spec pages (see each
// fixture's _provenance). The fake transport below is plumbing, not oracle:
// every byte the client parses comes from a spec fixture. This deliberately
// does NOT use tests/fixtures/mcp-test-server.ts -- that toy was written
// from the same assumptions as the client (the self-referential trap).
//
// KNOWN BUGS: none open. Three parser gaps found by this suite (nested
// resource, audio, resource_link) were fixed 2026-09-21; their assertions
// below are regular it()s. If they start failing, a fix regressed.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { McpClient } from "@extensions/mcp-client/client.ts";
import { HttpTransport } from "@extensions/mcp-client/transports.ts";
import type { McpTransport, TransportMessageHandler } from "@extensions/mcp-client/transports.ts";
import {
  jsonRpcRequest,
  jsonRpcNotification,
  mcpInitializeRequest,
  mcpToolCallRequest,
  parseMcpContentBlock,
  MCP_PROTOCOL_VERSION,
  McpError,
} from "@extensions/mcp-client/types.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";
import { loadJsonFixture } from "./helpers.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeTransport implements McpTransport {
  readonly isStreaming = true;
  sent: string[] = [];
  notifications: string[] = [];
  #handler: TransportMessageHandler | null = null;

  send(serialized: string): Promise<unknown> {
    this.sent.push(serialized);
    return Promise.resolve(undefined);
  }
  onMessage(handler: TransportMessageHandler): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = null;
    };
  }
  onClose(): () => void {
    return () => {};
  }
  sendNotification(serialized: string): void {
    this.notifications.push(serialized);
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
  deliver(line: string): void {
    this.#handler?.(line);
  }
}

// ── Logger capture (warn-and-continue assertions) ─────────────────────────
let logEvents: LogEvent[] = [];
const logHandlers: ((data: unknown) => void)[] = [];
const fakeHooks = {
  on: (_name: string, handler: (data: unknown) => void) => {
    logHandlers.push(handler);
    return () => {};
  },
  notifyHooks: (_name: string, data: unknown) => {
    for (const h of logHandlers) h(data);
  },
};

beforeEach(() => {
  logEvents = [];
  logHandlers.length = 0;
  logHandlers.push((data) => logEvents.push(data as LogEvent));
  resetLoggerForTesting();
  initializeLogger({ hooks: fakeHooks, minLevel: "warn", target: "none" });
});
afterEach(() => resetLoggerForTesting());

// ── Fixtures ───────────────────────────────────────────────────────────────
const initReq = (await loadJsonFixture("mcp/initialize-request.json")).data as Record<string, any>;
const initRespEnvelope = (await loadJsonFixture("mcp/initialize-response.json")).data as Record<string, any>;
const initRespMismatch = (await loadJsonFixture("mcp/initialize-response-version-mismatch.json")).data as Record<string, any>;
const initRespUnknown = (await loadJsonFixture("mcp/initialize-response-unknown-fields.json")).data as Record<string, any>;
const initedNotif = (await loadJsonFixture("mcp/initialized-notification.json")).data as Record<string, unknown>;
const toolsListResp = (await loadJsonFixture("mcp/tools-list-response.json")).data as Record<string, any>;
const toolsCallReq = (await loadJsonFixture("mcp/tools-call-request.json")).data as Record<string, any>;
const toolsCallResp = (await loadJsonFixture("mcp/tools-call-response.json")).data as Record<string, any>;
const toolExecError = (await loadJsonFixture("mcp/tool-execution-error.json")).data as Record<string, any>;
const contentBlocks = (await loadJsonFixture<Record<string, any>[]>("mcp/content-blocks.json")).data;
const methodNotFound = (await loadJsonFixture("mcp/jsonrpc-method-not-found.json")).data as Record<string, any>;

/** Start initialize() and deliver a response envelope, fixing its id to
 *  match the request (JSON-RPC 2.0 §5: response id MUST equal request id). */
async function initializeWith(t: FakeTransport, client: McpClient, envelope: Record<string, any>) {
  const p = client.initialize();
  await tick();
  const sentId = JSON.parse(t.sent[0]!).id;
  t.deliver(JSON.stringify({ ...envelope, id: sentId }));
  return p;
}

describe("JSON-RPC 2.0 outbound shapes (jsonrpc.org spec)", () => {
  it("JSON-RPC 4: request object carries jsonrpc '2.0', id, method; params MAY be omitted", () => {
    expect(jsonRpcRequest(1, "ping")).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    const withParams = jsonRpcRequest(2, "echo", { a: 1 }) as Record<string, unknown>;
    expect(withParams.params).toEqual({ a: 1 });
    expect(withParams.jsonrpc).toBe("2.0");
  });

  it("JSON-RPC 4.1: a Notification MUST NOT have an id member", () => {
    const n = jsonRpcNotification("log", { level: "info" }) as Record<string, unknown>;
    expect("id" in n).toBe(false);
    expect(n.jsonrpc).toBe("2.0");
  });

  it("MCP lifecycle: client sends initialize with protocolVersion, capabilities, clientInfo.name/version", () => {
    const params = mcpInitializeRequest() as Record<string, any>;
    // Spec requires exactly these three; the official example carries more
    // (elicitation, tasks, icons) -- presence, not deep-equality, is the pin.
    expect(params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(initReq.params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(typeof params.capabilities).toBe("object");
    expect(typeof params.clientInfo.name).toBe("string");
    expect(typeof params.clientInfo.version).toBe("string");
  });
});

describe("MCP initialize (lifecycle spec, official response example)", () => {
  it("MCP 2.6: initialize response parses protocolVersion / serverInfo / tools.listChanged from the official example", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const resp = (await initializeWith(t, client, initRespEnvelope)) as Record<string, any>;
    expect(resp.protocolVersion).toBe("2025-11-25");
    expect(resp.serverInfo.name).toBe("ExampleServer");
    expect(resp.serverInfo.version).toBe("1.0.0");
    expect(resp.capabilities.tools).toEqual({ listChanged: true });
    expect(resp.instructions).toBe("Optional instructions for the client");
  });

  it("MCP lifecycle: client sends notifications/initialized verbatim per the spec example", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await initializeWith(t, client, initRespEnvelope);
    expect(t.notifications.map((n) => JSON.parse(n))).toEqual([initedNotif]);
  });

  it("MCP lifecycle Version Negotiation: unsupported server version -> warn, do not throw (owner decision 2026-09-21: warn-and-continue; spec: SHOULD disconnect)", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const resp = (await initializeWith(t, client, initRespMismatch)) as Record<string, any>;
    expect(resp.protocolVersion).toBe("2024-11-05");
    const warns = logEvents.filter((e) => e.level === "warn" && /protocol version/i.test(e.message));
    expect(warns).toHaveLength(1);
  });

  it("MCP lifecycle Version Negotiation: matching version -> no warning", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await initializeWith(t, client, initRespEnvelope);
    expect(logEvents.filter((e) => e.level === "warn")).toHaveLength(0);
  });

  it("Forward compat: unknown result members are ignored, not errors (JSON-RPC 5 leaves them unspecified)", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const resp = (await initializeWith(t, client, initRespUnknown)) as Record<string, any>;
    expect(resp.protocolVersion).toBe("2025-11-25");
    expect(resp.serverInfo.name).toBe("ExampleServer");
  });
});

describe("MCP tools (server/tools spec, official examples)", () => {
  it("MCP tools/list: official response example parses name/title/description/inputSchema/nextCursor", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.listTools();
    await tick();
    const sentId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ ...toolsListResp, id: sentId }));
    const result = (await p) as Record<string, any>;
    expect(result.nextCursor).toBe("next-page-cursor");
    const tool = result.tools[0];
    expect(tool.name).toBe("get_weather");
    expect(tool.title).toBe("Weather Information Provider");
    expect(tool.description).toBe("Get current weather information for a location");
    expect(tool.inputSchema).toEqual(initSchema());
  });

  it("MCP tools/call: request params are {name, arguments} per the official example", () => {
    expect(mcpToolCallRequest("get_weather", { location: "New York" })).toEqual(
      toolsCallReq.params,
    );
  });

  it("MCP tools/call: official text-content response parses, isError false", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.callTool("get_weather", { location: "New York" });
    await tick();
    const sentId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ ...toolsCallResp, id: sentId }));
    const result = (await p) as Record<string, any>;
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Current weather in New York");
  });

  it("MCP tools Error Handling: execution error is isError:true INSIDE a JSON-RPC result, not a protocol error", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.callTool("book_flight", { date: "2020-01-01" });
    await tick();
    const sentId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ ...toolExecError, id: sentId }));
    const result = (await p) as Record<string, any>;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid departure date");
  });
});

describe("MCP content blocks (server/tools 'Tool Result' examples)", () => {
  it("MCP: text block parses to {type:'text', text}", () => {
    expect(parseMcpContentBlock(contentBlocks[0]!)).toEqual({
      type: "text",
      text: "Tool result text",
    });
  });

  it("MCP: image block carries data + mimeType", () => {
    const b = parseMcpContentBlock(contentBlocks[1]!);
    expect(b.type).toBe("image");
    expect(b.data).toBe("base64-encoded-data");
    expect(b.mimeType).toBe("image/png");
  });

  // Spec-conformant parsing (fixed 2026-09-21; was a documented bug --
  // see secret-sauce/spec-test-plan.md "What the suite found").
  it("MCP: embedded resource fields ride NESTED under block.resource (spec) -- parser reads them flat", () => {
    const b = parseMcpContentBlock(contentBlocks[4]!);
    expect(b.type).toBe("resource");
    expect(b.uri).toBe("file:///project/src/main.rs");
    expect(b.text).toContain("fn main()");
  });

  it("MCP: audio content block (2025-11-25) parses with data + mimeType", () => {
    const b = parseMcpContentBlock(contentBlocks[2]!);
    expect(b.type).toBe("audio");
    expect(b.data).toBe("base64-encoded-audio-data");
    expect(b.mimeType).toBe("audio/wav");
  });

  it("MCP: resource_link block (2025-11-25) parses uri + name", () => {
    const b = parseMcpContentBlock(contentBlocks[3]!) as unknown as Record<string, unknown>;
    expect(b.type).toBe("resource_link");
    expect(b.uri).toBe("file:///project/src/main.rs");
    expect(b.name).toBe("main.rs");
  });
});

describe("MCP JSON-RPC error + stdio framing", () => {
  it("JSON-RPC 5.1: a -32601 error response rejects the pending request with McpError carrying the code", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.listTools();
    await tick();
    const sentId = JSON.parse(t.sent[0]!).id;
    // id rewritten to our numeric request id -- JSON-RPC 5: the response id
    // MUST be the same as the request id (the spec example pairs them).
    t.deliver(JSON.stringify({ ...methodNotFound, id: sentId }));
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(-32601);
  });

  it("MCP lifecycle error example: 'Unsupported protocol version' (-32602) surfaces as McpError", async () => {
    const { data: versionError } = await loadJsonFixture("mcp/initialize-version-error.json");
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.initialize();
    await tick();
    t.deliver(JSON.stringify({ ...(versionError as Record<string, any>), id: JSON.parse(t.sent[0]!).id }));
    await expect(p).rejects.toThrow(/Unsupported protocol version/);
  });

  it("stdio framing (MCP transports): non-JSON lines are ignored between messages (server logs on stdout)", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.listTools();
    await tick();
    t.deliver("this is not JSON");
    t.deliver("[info] server starting up");
    const sentId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: sentId, result: { tools: [] } }));
    const result = (await p) as Record<string, any>;
    expect(result.tools).toEqual([]);
  });

  it("JSON-RPC 5: responses must carry result XOR error; a message with neither is not treated as a response", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    const p = client.listTools();
    await tick();
    const sentId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: sentId }));
    // Must not resolve the pending request; resolve it properly afterwards.
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: sentId, result: { tools: [] } }));
    await expect(p).resolves.toBeTruthy();
  });
});

function initSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { location: { type: "string", description: "City name or zip code" } },
    required: ["location"],
  };
}

describe("MCP HTTP transport (transports spec, Protocol Version Header)", () => {
  it("MCP transports: after initialize, every subsequent HTTP request MUST carry MCP-Protocol-Version: <negotiated>", async () => {
    const fetches: { headers: Record<string, string> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetches.push({ headers });
      const id = JSON.parse(String(init?.body)).id;
      const envelope =
        fetches.length === 1
          ? { ...initRespEnvelope, id }
          : { jsonrpc: "2.0", id, result: { tools: [] } };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new McpClient(new HttpTransport("http://mcp.test/rpc"));
      await client.initialize();
      await client.listTools();

      expect(fetches).toHaveLength(2);
      // The initialize request itself carries the version in params only.
      expect(fetches[0]!.headers["MCP-Protocol-Version"]).toBeUndefined();
      // Subsequent requests must carry the negotiated value.
      expect(fetches[1]!.headers["MCP-Protocol-Version"]).toBe("2025-11-25");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
