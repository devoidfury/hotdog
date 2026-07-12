// Tests for MCP types and McpTool.
// Merged from mcp.test.ts + mcp-extended.test.ts to reduce duplication.

import { describe, it, expect } from "bun:test";
import {
  parseMcpToolDefinition,
  parseMcpToolCallResponse,
  parseMcpContentBlock,
  contentBlocksToString,
  mcpToolCallRequest,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpInitializeRequest,
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
} from "../../src/extensions/mcp-client/types.ts";
import { McpTool } from "../../src/extensions/mcp-client/tools.ts";

// ── MCP types ───────────────────────────────────────────────────────────────

describe("jsonRpcRequest", () => {
  it("creates a request with params", () => {
    const req = jsonRpcRequest(1, "method", { key: "value" });
    expect(req).toEqual({ jsonrpc: "2.0", id: 1, method: "method", params: { key: "value" } });
  });

  it("creates a request without params", () => {
    const req = jsonRpcRequest(1, "method");
    expect(req).toEqual({ jsonrpc: "2.0", id: 1, method: "method" });
    expect(req.params).toBeUndefined();
  });

  it("creates a request with null params", () => {
    const req = jsonRpcRequest(1, "method", null);
    expect(req.params).toBeUndefined();
  });
});

describe("jsonRpcNotification", () => {
  it("creates a notification with params", () => {
    const notif = jsonRpcNotification("method", { key: "value" });
    expect(notif).toEqual({ jsonrpc: "2.0", method: "method", params: { key: "value" } });
  });

  it("creates a notification without params", () => {
    const notif = jsonRpcNotification("method");
    expect(notif).toEqual({ jsonrpc: "2.0", method: "method" });
    expect(notif.params).toBeUndefined();
  });
});

describe("mcpInitializeRequest", () => {
  it("creates initialize request", () => {
    const req = mcpInitializeRequest();
    expect(req.protocolVersion).toBe("2025-11-25");
    expect(req.capabilities.roots).toBeDefined();
    expect(req.clientInfo.name).toBe("hotdog");
  });
});

describe("parseMcpInitializeResponse", () => {
  it("parses full response", () => {
    const data = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: true }, logging: true },
      serverInfo: { name: "test-server", version: "1.0.0" },
      instructions: "Some instructions",
    };
    const result = parseMcpInitializeResponse(data);
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.capabilities.tools.listChanged).toBe(true);
    expect(result.capabilities.logging).toBe(true);
    expect(result.serverInfo.name).toBe("test-server");
    expect(result.instructions).toBe("Some instructions");
  });

  it("parses minimal response", () => {
    const result = parseMcpInitializeResponse({});
    expect(result.protocolVersion).toBeNull();
    expect(result.serverInfo.name).toBe("unknown");
    expect(result.instructions).toBeNull();
  });

  it("handles no tools capability", () => {
    const result = parseMcpInitializeResponse({ capabilities: {} });
    expect(result.capabilities.tools).toBeNull();
  });
});

describe("parseMcpToolsListResponse", () => {
  it("parses tools list", () => {
    const data = {
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
        { name: "greet", description: "Greet", inputSchema: { type: "object", properties: {} } },
      ],
      nextCursor: "abc123",
    };
    const result = parseMcpToolsListResponse(data);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("echo");
    expect(result.tools[1].name).toBe("greet");
    expect(result.nextCursor).toBe("abc123");
  });

  it("handles missing tools", () => {
    const result = parseMcpToolsListResponse({});
    expect(result.tools).toEqual([]);
  });
});

describe("parseMcpToolDefinition", () => {
  it("parses full tool definition", () => {
    const tool = {
      name: "test",
      description: "A test tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const result = parseMcpToolDefinition(tool);
    expect(result.name).toBe("test");
    expect(result.description).toBe("A test tool");
    expect(result.inputSchema.required).toEqual(["query"]);
  });

  it("parses minimal tool definition", () => {
    const result = parseMcpToolDefinition({});
    expect(result.name).toBe("");
    expect(result.description).toBeNull();
    expect(result.inputSchema).toEqual({});
  });
});

describe("mcpToolCallRequest", () => {
  it("creates tool call request with arguments", () => {
    const req = mcpToolCallRequest("echo", { text: "hello" });
    expect(req).toEqual({ name: "echo", arguments: { text: "hello" } });
  });

  it("creates tool call request without arguments", () => {
    const req = mcpToolCallRequest("echo");
    expect(req.arguments).toBeUndefined();
  });
});

describe("parseMcpToolCallResponse", () => {
  it("parses text content", () => {
    const data = { content: [{ type: "text", text: "Hello world" }], isError: false };
    const result = parseMcpToolCallResponse(data);
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.isError).toBe(false);
  });

  it("parses error response", () => {
    const data = { content: [{ type: "text", text: "Error occurred" }], isError: true };
    const result = parseMcpToolCallResponse(data);
    expect(result.isError).toBe(true);
  });

  it("parses empty content", () => {
    const result = parseMcpToolCallResponse({});
    expect(result.content).toEqual([]);
    expect(result.isError).toBe(false);
  });
});

describe("parseMcpContentBlock", () => {
  it("parses text block", () => {
    expect(parseMcpContentBlock({ type: "text", text: "Hello" })).toEqual({ type: "text", text: "Hello" });
  });

  it("parses image block", () => {
    const result = parseMcpContentBlock({ type: "image", data: "base64data", mimeType: "image/png" });
    expect(result.type).toBe("image");
    expect(result.data).toBe("base64data");
  });

  it("parses resource block with text", () => {
    const result = parseMcpContentBlock({ type: "resource", uri: "file:///test.txt", mimeType: "text/plain", text: "content" });
    expect(result.type).toBe("resource");
    expect(result.text).toBe("content");
  });

  it("parses resource block with blob", () => {
    const result = parseMcpContentBlock({ type: "resource", uri: "file:///test.bin", mimeType: "application/octet-stream", blob: "binarydata" });
    expect(result.blob).toBe("binarydata");
  });

  it("handles null/unknown blocks", () => {
    expect(parseMcpContentBlock(null).type).toBe("unknown");
    expect(parseMcpContentBlock({}).type).toBe("unknown");
  });
});

describe("contentBlocksToString", () => {
  it("converts single text block", () => {
    expect(contentBlocksToString([{ type: "text", text: "Hello" }])).toBe("Hello");
  });

  it("converts multiple text blocks", () => {
    const blocks = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(contentBlocksToString(blocks)).toBe("Hello\nWorld");
  });

  it("converts image block", () => {
    expect(contentBlocksToString([{ type: "image", data: "abc", mimeType: "image/png" }]))
      .toBe("[Image: image/png (3 bytes)]");
  });

  it("converts resource block with text", () => {
    expect(contentBlocksToString([{ type: "resource", uri: "file:///test.txt", text: "file content" }]))
      .toBe("[Resource: file:///test.txt]\nfile content");
  });

  it("converts mixed blocks", () => {
    const blocks = [
      { type: "text", text: "Intro" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: "Outro" },
    ];
    expect(contentBlocksToString(blocks)).toBe("Intro\n[Image: image/png (3 bytes)]\nOutro");
  });

  it("handles empty blocks array", () => {
    expect(contentBlocksToString([])).toBe("");
  });
});

// ── McpTool ──────────────────────────────────────────────────────────────────

describe("McpTool", () => {
  const mockHandle = {
    callTool: async (name, args) => ({ content: [{ type: "text", text: "result" }] }),
  };

  it("creates tool with registered name", () => {
    const toolDef = { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: {} } };
    const tool = new McpTool("my-server", toolDef, mockHandle);
    expect(tool.registeredName).toBe("my-server/echo");
  });

  it("converts to tool definition with correct schema", () => {
    const toolDef = {
      name: "greet",
      description: "Greet someone",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name" },
          age: { type: "integer" },
        },
        required: ["name"],
      },
    };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();

    expect(def.function.name).toBe("server/greet");
    expect(def.function.description).toBe("Greet someone");
    expect(def.function.parameters.properties.name.description).toBe("The name");
    expect(def.function.parameters.required).toEqual(["name"]);
  });

  it("converts to tool definition with empty schema", () => {
    const toolDef = { name: "noop", description: "Does nothing", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("converts to tool definition with no inputSchema", () => {
    const toolDef = { name: "noop", description: "Does nothing" };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("creates call display string", () => {
    const toolDef = { name: "bash", description: "Run bash", inputSchema: {} };
    const tool = new McpTool("my-server", toolDef, mockHandle);
    expect(tool.callDisplay("echo hello")).toBe("MCP [my-server] echo hello");
  });

  it("executes tool with valid JSON input", async () => {
    let receivedArgs = null;
    const mockHandle2 = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle2);
    await tool.execute(JSON.stringify({ key: "value" }));
    expect(receivedArgs).toEqual({ key: "value" });
  });

  it("executes tool with object input", async () => {
    let receivedArgs = null;
    const mockHandle2 = {
      callTool: async (name, args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle2);
    await tool.execute({ key: "value" });
    expect(receivedArgs).toEqual({ key: "value" });
  });

  it("returns error on invalid JSON input", async () => {
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle);
    const result = await tool.execute("not valid json");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Error parsing tool arguments");
  });

  it("returns error when MCP call fails", async () => {
    const mockHandle2 = {
      callTool: async () => { throw new Error("MCP server error"); },
    };
    const toolDef = { name: "test", description: "test", inputSchema: {} };
    const tool = new McpTool("server", toolDef, mockHandle2);
    const result = await tool.execute("{}");
    expect(result.success).toBe(false);
    expect(result.error).toContain("MCP tool call failed");
  });

  it("handles tool with enum constraint", () => {
    const toolDef = {
      name: "set-mode",
      description: "Set mode",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string", enum: ["debug", "release"], description: "Build mode" } },
      },
    };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties.mode.enum).toEqual(["debug", "release"]);
  });

  it("handles tool with numeric constraints", () => {
    const toolDef = {
      name: "set-value",
      description: "Set value",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 0, maximum: 100 },
          rate: { type: "number", minimum: 0.0, exclusiveMaximum: 1.0 },
        },
      },
    };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties.count.minimum).toBe(0);
    expect(def.function.parameters.properties.count.maximum).toBe(100);
    expect(def.function.parameters.properties.rate.exclusiveMaximum).toBe(1.0);
  });

  it("handles tool with string constraints", () => {
    const toolDef = {
      name: "set-name",
      description: "Set name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 50, pattern: "^[a-z]+$" } },
      },
    };
    const tool = new McpTool("server", toolDef, mockHandle);
    const def = tool.toToolDef();
    expect(def.function.parameters.properties.name.minLength).toBe(1);
    expect(def.function.parameters.properties.name.maxLength).toBe(50);
    expect(def.function.parameters.properties.name.pattern).toBe("^[a-z]+$");
  });
});
