import { describe, it, expect } from "bun:test";
import {
  parseMcpToolDefinition,
  parseMcpToolCallResponse,
  parseMcpContentBlock,
  contentBlocksToString,
  mcpToolCallRequest,
  jsonRpcRequest,
  jsonRpcNotification,
} from "../../extensions/mcp/types.js";
import { McpTool } from "../../extensions/mcp/tools.js";

describe("MCP types", () => {
  it("parses tool definition", () => {
    const tool = parseMcpToolDefinition({
      name: "test_tool",
      description: "A test tool",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    });
    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
    expect(tool.inputSchema.type).toBe("object");
  });

  it("parses tool call response", () => {
    const response = parseMcpToolCallResponse({
      content: [{ type: "text", text: "Hello world" }],
      isError: false,
    });
    expect(response.isError).toBe(false);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toBe("Hello world");
  });

  it("converts content blocks to string", () => {
    const blocks = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ];
    const result = contentBlocksToString(blocks);
    expect(result).toBe("First block\nSecond block");
  });

  it("handles image content blocks", () => {
    const blocks = [
      { type: "image", data: "abc123", mimeType: "image/png" },
    ];
    const result = contentBlocksToString(blocks);
    expect(result).toContain("[Image: image/png");
  });

  it("handles resource content blocks", () => {
    const blocks = [
      { type: "resource", uri: "file.txt", mimeType: "text/plain", text: "file contents" },
    ];
    const result = contentBlocksToString(blocks);
    expect(result).toContain("[Resource: file.txt]");
    expect(result).toContain("file contents");
  });

  it("creates JSON-RPC request", () => {
    const req = jsonRpcRequest(1, "tools/list", {});
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(1);
    expect(req.method).toBe("tools/list");
  });

  it("creates JSON-RPC notification", () => {
    const notif = jsonRpcNotification("notifications/initialized");
    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.method).toBe("notifications/initialized");
    expect(notif.id).toBeUndefined();
  });
});

describe("McpTool", () => {
  it("creates tool with registered name", () => {
    const toolDef = {
      name: "search",
      description: "Search the codebase",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
    };
    const handle = { serverName: "test-server" };
    const tool = new McpTool("test-server", toolDef, handle);

    expect(tool.registeredName).toBe("test-server/search");
  });

  it("converts to tool definition", () => {
    const toolDef = {
      name: "search",
      description: "Search the codebase",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
    };
    const handle = { serverName: "test-server" };
    const tool = new McpTool("test-server", toolDef, handle);
    const def = tool.toToolDef();

    expect(def.type).toBe("function");
    expect(def.function.name).toBe("test-server/search");
    expect(def.function.description).toBe("Search the codebase");
    expect(def.function.parameters.properties.query.type).toBe("string");
    expect(def.function.parameters.properties.query.description).toBe("Search query");
    expect(def.function.parameters.properties.maxResults.minimum).toBe(1);
    expect(def.function.parameters.required).toContain("query");
  });

  it("creates call display string", () => {
    const toolDef = { name: "search", description: "Search", inputSchema: {} };
    const handle = { serverName: "test-server" };
    const tool = new McpTool("test-server", toolDef, handle);
    expect(tool.callDisplay('{"query": "hello"}')).toBe(
      'MCP [test-server] {"query": "hello"}',
    );
  });
});
