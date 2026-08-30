// Tests for MCP protocol types (src/extensions/mcp-client/types.ts).
// McpTool is covered in mcp-client-tools.test.ts; transports and client
// behavior in mcp-client.test.ts / mcp-client-stdio.test.ts.
//
// Only cases with real logic are asserted here: the params/arguments
// omission gates, default values for missing fields, content-block type
// dispatch, and display formatting. Plain pass-through field copies are
// intentionally not tested -- they restate the one-line implementation.

import { describe, it, expect } from "bun:test";
import {
  parseMcpToolDefinition,
  parseMcpContentBlock,
  mcpToolCallRequest,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpInitializeRequest,
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
} from "../../src/extensions/mcp-client/types.ts";
import { contentBlocksToString } from "../../src/extensions/mcp-client/connection.ts";

// ── Request builders ────────────────────────────────────────────────────────

describe("jsonRpcRequest", () => {
  it("includes params only when non-null", () => {
    expect(jsonRpcRequest(1, "method", { key: "value" })).toEqual({
      jsonrpc: "2.0", id: 1, method: "method", params: { key: "value" },
    });
    const without = jsonRpcRequest(1, "method");
    const withNull = jsonRpcRequest(1, "method", null);
    expect(without.params).toBeUndefined();
    expect(withNull.params).toBeUndefined();
  });
});

describe("jsonRpcNotification", () => {
  it("has no id and includes params only when non-null", () => {
    const withParams = jsonRpcNotification("method", { key: "value" });
    expect(withParams).toEqual({ jsonrpc: "2.0", method: "method", params: { key: "value" } });
    expect(withParams.id).toBeUndefined();
    expect(jsonRpcNotification("method").params).toBeUndefined();
  });
});

describe("mcpInitializeRequest", () => {
  it("requests the supported protocol version with roots and sampling capabilities", () => {
    const req = mcpInitializeRequest() as Record<string, { roots?: unknown; sampling?: unknown } | { name?: string } | string>;
    // Protocol contract: servers reject unknown versions, so pin what we send.
    expect(req.protocolVersion).toBe("2025-11-25");
    expect((req.capabilities as Record<string, unknown>).roots).toBeDefined();
    expect((req.capabilities as Record<string, unknown>).sampling).toBeDefined();
    expect((req.clientInfo as Record<string, unknown>).name).toBe("hotdog");
  });
});

describe("mcpToolCallRequest", () => {
  it("includes arguments only when non-null", () => {
    expect(mcpToolCallRequest("echo", { text: "hello" })).toEqual({ name: "echo", arguments: { text: "hello" } });
    expect(mcpToolCallRequest("echo").arguments).toBeUndefined();
  });
});

// ── Response parsing: defaults for missing/unknown fields ───────────────────

describe("parseMcpInitializeResponse", () => {
  it("applies defaults for a minimal response", () => {
    const result = parseMcpInitializeResponse({});
    expect(result.protocolVersion).toBeNull();
    expect(result.serverInfo.name).toBe("unknown");
    expect(result.serverInfo.version).toBe("unknown");
    expect(result.instructions).toBeNull();
  });

  it("treats missing or empty tools capability as null", () => {
    expect(parseMcpInitializeResponse({ capabilities: {} }).capabilities.tools).toBeNull();
    expect(parseMcpInitializeResponse({}).capabilities.tools).toBeNull();
  });
});

describe("parseMcpToolsListResponse", () => {
  it("defaults to no tools and no cursor", () => {
    const result = parseMcpToolsListResponse({});
    expect(result.tools).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

describe("parseMcpToolDefinition", () => {
  it("applies defaults for missing fields", () => {
    const result = parseMcpToolDefinition({});
    expect(result.name).toBe("");
    expect(result.title).toBeNull();
    expect(result.description).toBeNull();
    expect(result.inputSchema).toEqual({});
  });
});

describe("parseMcpToolCallResponse", () => {
  it("defaults to empty content and no error", () => {
    const result = parseMcpToolCallResponse({});
    expect(result.content).toEqual([]);
    expect(result.isError).toBe(false);
  });
});

// ── Content blocks ───────────────────────────────────────────────────────────

describe("parseMcpContentBlock", () => {
  it("parses text block with empty-string default", () => {
    expect(parseMcpContentBlock({ type: "text", text: "Hello" })).toEqual({ type: "text", text: "Hello" });
    expect(parseMcpContentBlock({ type: "text" }).text).toBe("");
  });

  it("parses image block", () => {
    const result = parseMcpContentBlock({ type: "image", data: "base64data", mimeType: "image/png" });
    expect(result).toEqual({ type: "image", data: "base64data", mimeType: "image/png" });
  });

  it("parses resource block with text", () => {
    const result = parseMcpContentBlock({ type: "resource", uri: "file:///test.txt", mimeType: "text/plain", text: "content" });
    expect(result).toMatchObject({ type: "resource", uri: "file:///test.txt", text: "content" });
  });

  it("parses resource block with blob", () => {
    const result = parseMcpContentBlock({ type: "resource", uri: "file:///test.bin", mimeType: "application/octet-stream", blob: "binarydata" });
    expect(result.blob).toBe("binarydata");
  });

  it("maps null, empty, and unknown blocks to type unknown", () => {
    expect(parseMcpContentBlock(null).type).toBe("unknown");
    expect(parseMcpContentBlock({}).type).toBe("unknown");
    expect(parseMcpContentBlock({ type: "some-new-type" }).type).toBe("unknown");
  });
});

describe("contentBlocksToString", () => {
  it("joins text blocks with newlines and skips empty ones", () => {
    const blocks = [
      { type: "text", text: "Hello" },
      { type: "text", text: "" },
      { type: "text", text: "World" },
    ];
    expect(contentBlocksToString(blocks)).toBe("Hello\nWorld");
  });

  it("renders image blocks with mime type and byte count", () => {
    expect(contentBlocksToString([{ type: "image", data: "abc", mimeType: "image/png" }]))
      .toBe("[Image: image/png (3 bytes)]");
  });

  it("falls back to 'image' when the image mime type is missing", () => {
    expect(contentBlocksToString([{ type: "image", data: "abc" }]))
      .toBe("[Image: image (3 bytes)]");
  });

  it("renders resource blocks with text", () => {
    expect(contentBlocksToString([{ type: "resource", uri: "file:///test.txt", text: "file content" }]))
      .toBe("[Resource: file:///test.txt]\nfile content");
  });

  it("renders unknown blocks as a placeholder", () => {
    expect(contentBlocksToString([{ type: "weird" }])).toBe("[Unknown content block]");
  });

  it("handles empty blocks array", () => {
    expect(contentBlocksToString([])).toBe("");
  });
});
