// Minimal MCP protocol types: only the JSON-RPC 2.0 and MCP message types
// needed for connecting to MCP servers, listing tools, and calling tools.

import pkg from "@package.json" with { type: "json" };
import { ExtensionError } from "@core/error.ts";

export function jsonRpcRequest(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params != null ? { params } : {}) };
}

export function jsonRpcNotification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params != null ? { params } : {}) };
}

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

export class McpError extends ExtensionError {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
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

export function parseMcpInitializeResponse(data: Record<string, unknown>): McpInitializeResponse {
  return {
    protocolVersion: (data.protocolVersion as string) || null,
    capabilities: parseMcpServerCapabilities((data.capabilities as Record<string, unknown>) || {}),
    serverInfo: {
      name: ((data.serverInfo as Record<string, unknown>)?.name as string) || "unknown",
      version: ((data.serverInfo as Record<string, unknown>)?.version as string) || "unknown",
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
          listChanged: ((cap.tools as Record<string, unknown>).listChanged as boolean) || false,
        }
      : null,
  };
}

export interface McpToolDefinition {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

interface McpToolsListResponse {
  tools: McpToolDefinition[];
  nextCursor: string | null;
}

export function parseMcpToolsListResponse(data: Record<string, unknown>): McpToolsListResponse {
  return {
    tools: ((data.tools as Record<string, unknown>[]) || []).map(parseMcpToolDefinition),
    nextCursor: (data.nextCursor as string) || null,
  };
}

export function parseMcpToolDefinition(tool: Record<string, unknown>): McpToolDefinition {
  return {
    name: (tool.name as string) || "",
    title: (tool.title as string) || null,
    description: (tool.description as string) || null,
    inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
  };
}

export function mcpToolCallRequest(
  name: string,
  args?: Record<string, unknown> | null,
): Record<string, unknown> {
  return { name, ...(args != null ? { arguments: args } : {}) };
}

export interface McpContentBlock {
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

export function parseMcpToolCallResponse(data: Record<string, unknown>): McpToolCallResponse {
  const content = ((data.content as Record<string, unknown>[]) || []).map(parseMcpContentBlock);
  return { content, isError: (data.isError as boolean) || false };
}

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
        text: (block.text as string) || undefined,
        blob: (block.blob as string) || undefined,
      };
    default:
      return { type: "unknown" };
  }
}
