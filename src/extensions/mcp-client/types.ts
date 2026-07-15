// Minimal MCP protocol types.
// Implements only the JSON-RPC 2.0 and MCP message types needed for
// connecting to MCP servers, listing tools, and calling tools.

import pkg from "../../../package.json" with { type: "json" };

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

/**
 * Create a JSON-RPC 2.0 request.
 */
export function jsonRpcRequest(id: number, method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined && params !== null ? { params } : {}),
  };
}

/**
 * Create a JSON-RPC 2.0 notification (no ID).
 */
export function jsonRpcNotification(method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined && params !== null ? { params } : {}),
  };
}

// ── MCP Protocol Types ────────────────────────────────────────────────────

/**
 * MCP initialize request sent by client.
 */
export function mcpInitializeRequest(): Record<string, unknown> {
  return {
    protocolVersion: "2025-11-25",
    capabilities: {
      roots: { listChanged: false },
      sampling: {},
    },
    clientInfo: {
      name: "hotdog",
      version: pkg.version,
    },
  };
}

interface McpServerCapabilities {
  logging: unknown;
  prompts: unknown;
  resources: unknown;
  tools: { listChanged: boolean } | null;
}

interface McpServerInfo {
  name: string;
  version: string;
}

interface McpInitializeResponse {
  protocolVersion: string | null;
  capabilities: McpServerCapabilities;
  serverInfo: McpServerInfo;
  instructions: string | null;
}

/**
 * Parse MCP initialize response from server.
 */
export function parseMcpInitializeResponse(data: Record<string, unknown>): McpInitializeResponse {
  return {
    protocolVersion: (data.protocolVersion as string) || null,
    capabilities: parseMcpServerCapabilities(data.capabilities as Record<string, unknown> || {}),
    serverInfo: {
      name: (data.serverInfo as Record<string, unknown>)?.name as string || "unknown",
      version: (data.serverInfo as Record<string, unknown>)?.version as string || "unknown",
    },
    instructions: (data.instructions as string) || null,
  };
}

function parseMcpServerCapabilities(cap: Record<string, unknown>): McpServerCapabilities {
  return {
    logging: cap.logging || null,
    prompts: cap.prompts || null,
    resources: cap.resources || null,
    tools: cap.tools
      ? {
          listChanged: (cap.tools as Record<string, unknown>).listChanged as boolean || false,
        }
      : null,
  };
}

interface McpToolDefinition {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

interface McpToolsListResponse {
  tools: McpToolDefinition[];
  nextCursor: string | null;
}

/**
 * Parse MCP tools/list response.
 */
export function parseMcpToolsListResponse(data: Record<string, unknown>): McpToolsListResponse {
  return {
    tools: ((data.tools as Record<string, unknown>[]) || []).map(parseMcpToolDefinition),
    nextCursor: (data.nextCursor as string) || null,
  };
}

/**
 * Parse a tool definition from an MCP server.
 */
export function parseMcpToolDefinition(tool: Record<string, unknown>): McpToolDefinition {
  return {
    name: (tool.name as string) || "",
    title: (tool.title as string) || null,
    description: (tool.description as string) || null,
    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
  };
}

/**
 * Create MCP tools/call request.
 */
export function mcpToolCallRequest(name: string, arguments_?: Record<string, unknown> | null): Record<string, unknown> {
  return {
    name,
    ...(arguments_ !== undefined && arguments_ !== null
      ? { arguments: arguments_ }
      : {}),
  };
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  blob?: string;
}

interface McpToolCallResponse {
  content: McpContentBlock[];
  isError: boolean;
}

/**
 * Parse MCP tools/call response.
 */
export function parseMcpToolCallResponse(data: Record<string, unknown>): McpToolCallResponse {
  return {
    content: ((data.content as Record<string, unknown>[]) || []).map(parseMcpContentBlock),
    isError: (data.isError as boolean) || false,
  };
}

/**
 * Parse a content block in a tool call response.
 */
export function parseMcpContentBlock(block: Record<string, unknown> | null): McpContentBlock {
  if (!block || !block.type) return { type: "unknown" };

  switch (block.type as string) {
    case "text":
      return { type: "text", text: (block.text as string) || "" };
    case "image":
      return {
        type: "image",
        data: (block.data as string) || "",
        mimeType: (block.mimeType as string) || "",
      };
    case "resource":
      return {
        type: "resource",
        uri: (block.uri as string) || "",
        mimeType: (block.mimeType as string) || "",
        text: (block.text as string) || null,
        blob: (block.blob as string) || null,
      };
    default:
      return { type: "unknown" };
  }
}

/**
 * Convert MCP content blocks to a single string.
 */
export function contentBlocksToString(blocks: McpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "image":
        parts.push(
          `[Image: ${block.mimeType || "image"} (${(block.data || "").length} bytes)]`,
        );
        break;
      case "resource":
        if (block.text) {
          parts.push(`[Resource: ${block.uri || ""}]\n${block.text}`);
        }
        break;
      default:
        parts.push("[Unknown content block]");
    }
  }
  return parts.join("\n");
}
