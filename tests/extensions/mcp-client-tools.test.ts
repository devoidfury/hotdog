// Tests for mcp-client/tools.ts — McpTool and schema conversion utilities.

import { describe, it, expect, mock } from "bun:test";
import { McpTool } from "../../src/extensions/mcp-client/tools.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockConnection(
  callToolResult: unknown = { content: [{ type: "text", text: "result" }] },
  shouldFail = false,
) {
  return {
    callTool: mock(async (_name: string, _args: Record<string, unknown>) => {
      if (shouldFail) throw new Error("MCP call failed");
      return callToolResult;
    }),
  } as any;
}

function createToolDef(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-tool",
    title: "Test Tool",
    description: "A test tool for MCP",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
    ...overrides,
  };
}

// ── McpTool Tests ───────────────────────────────────────────────────────────

describe("McpTool", () => {
  it("creates a tool with correct registered name", () => {
    const connection = createMockConnection();
    const tool = new McpTool("my-server", createToolDef(), connection);

    expect(tool.registeredName).toBe("my-server/test-tool");
  });

  it("creates a tool with special characters in server name", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server-with-dashes", createToolDef({ name: "tool_name" }), connection);

    expect(tool.registeredName).toBe("server-with-dashes/tool_name");
  });
});

describe("McpTool > execute", () => {
  it("executes tool with JSON string input", async () => {
    const connection = createMockConnection({ content: [{ type: "text", text: "success" }] });
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute(JSON.stringify({ query: "hello" }));

    expect(result.success).toBe(true);
    expect((result as any).output).toEqual({ content: [{ type: "text", text: "success" }] });
    expect(connection.callTool).toHaveBeenCalledWith("test-tool", { query: "hello" });
  });

  it("executes tool with object input", async () => {
    const connection = createMockConnection({ content: [{ type: "text", text: "ok" }] });
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute({ query: "world", limit: 10 });

    expect(result.success).toBe(true);
    expect(connection.callTool).toHaveBeenCalledWith("test-tool", { query: "world", limit: 10 });
  });

  it("returns error for invalid JSON input", async () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute("not valid json {{{");

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("Error parsing tool arguments");
    expect(connection.callTool).not.toHaveBeenCalled();
  });

  it("returns error when MCP call fails", async () => {
    const connection = createMockConnection(null, true);
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute({ query: "test" });

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("MCP tool call failed");
    expect((result as any).error).toContain("MCP call failed");
  });

  it("handles null input", async () => {
    const connection = createMockConnection({ content: [] });
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute(null);

    expect(result.success).toBe(true);
    expect(connection.callTool).toHaveBeenCalledWith("test-tool", null);
  });

  it("handles empty string input as JSON parse error", async () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    const result = await tool.execute("");

    expect(result.success).toBe(false);
    expect((result as any).error).toContain("Error parsing tool arguments");
  });
});

describe("McpTool > toToolDef", () => {
  it("returns correct tool definition structure", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    const def = tool.toToolDef();

    expect(def.type).toBe("function");
    expect(def.function.name).toBe("server/test-tool");
    expect(def.function.description).toBe("A test tool for MCP");
    expect(def.function.parameters.type).toBe("object");
  });

  it("converts schema properties correctly", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toHaveProperty("query");
    expect(def.function.parameters.properties).toHaveProperty("limit");
    expect(def.function.parameters.properties!.query!.type).toBe("string");
    expect(def.function.parameters.properties!.query!.description).toBe("Search query");
    expect(def.function.parameters.properties!.limit!.type).toBe("number");
    expect(def.function.parameters.properties!.limit!.minimum).toBe(1);
    expect(def.function.parameters.properties!.limit!.maximum).toBe(100);
  });

  it("extracts required fields", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.required).toEqual(["query"]);
  });

  it("handles missing inputSchema", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", { name: "no-schema", description: "No schema" }, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("handles null description", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", { name: "no-desc", description: null }, connection);

    const def = tool.toToolDef();

    expect(def.function.description).toBe("");
  });

  it("handles enum in schema", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "enum-tool",
      description: "Tool with enum",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Status", enum: ["active", "inactive", "pending"] },
        },
      },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties!.status!.enum).toEqual(["active", "inactive", "pending"]);
  });

  it("handles string constraints in schema", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "string-tool",
      description: "Tool with string constraints",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name", minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
        },
      },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties!.name!.minLength).toBe(1);
    expect(def.function.parameters.properties!.name!.maxLength).toBe(100);
    expect(def.function.parameters.properties!.name!.pattern).toBe("^[a-z]+$");
  });

  it("handles exclusiveMinimum and exclusiveMaximum", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "range-tool",
      description: "Tool with range",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 100 },
        },
      },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties!.value!.exclusiveMinimum).toBe(0);
    expect(def.function.parameters.properties!.value!.exclusiveMaximum).toBe(100);
  });

  it("handles schema with no properties", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "empty-tool",
      description: "Empty schema",
      inputSchema: { type: "object" },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });

  it("handles schema with non-object properties", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "bad-schema",
      description: "Bad schema",
      inputSchema: { type: "object", properties: null },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
  });

  it("handles schema with non-object property values", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "bad-prop",
      description: "Bad property",
      inputSchema: { type: "object", properties: { bad: "not-an-object" } },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
  });
});

describe("McpTool > callDisplay", () => {
  it("returns formatted display string with server name", () => {
    const connection = createMockConnection();
    const tool = new McpTool("my-server", createToolDef(), connection);

    expect(tool.callDisplay({ query: "test" })).toContain("MCP [my-server]");
    // Object input is stringified as [object Object]
    expect(tool.callDisplay({ query: "test" })).toBe("MCP [my-server] [object Object]");
  });

  it("handles null input", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    expect(tool.callDisplay(null)).toBe("MCP [server] null");
  });

  it("handles string input", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", createToolDef(), connection);

    expect(tool.callDisplay("raw input")).toBe("MCP [server] raw input");
  });
});

// ── Schema Conversion Edge Cases ────────────────────────────────────────────

describe("McpTool > Schema Edge Cases", () => {
  it("handles undefined inputSchema", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", { name: "undefined-schema", inputSchema: undefined }, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
  });

  it("handles non-object inputSchema", () => {
    const connection = createMockConnection();
    const tool = new McpTool("server", { name: "string-schema", inputSchema: "not-an-object" as any }, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties).toEqual({});
  });

  it("handles required as non-array", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "bad-required",
      inputSchema: { type: "object", properties: {}, required: "not-an-array" as any },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.required).toEqual([]);
  });

  it("handles required with non-string values", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "mixed-required",
      inputSchema: { type: "object", properties: {}, required: ["valid", 123, null, "also-valid"] },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.required).toEqual(["valid", "also-valid"]);
  });

  it("handles property with default type string", () => {
    const connection = createMockConnection();
    const toolDef = {
      name: "no-type",
      inputSchema: { type: "object", properties: { field: { description: "No type specified" } } },
    };
    const tool = new McpTool("server", toolDef, connection);

    const def = tool.toToolDef();

    expect(def.function.parameters.properties!.field!.type).toBe("string");
  });
});
