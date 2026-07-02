// Minimal MCP protocol types.
// Implements only the JSON-RPC 2.0 and MCP message types needed for
// connecting to MCP servers, listing tools, and calling tools.

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

/**
 * Create a JSON-RPC 2.0 request.
 */
export function jsonRpcRequest(id, method, params) {
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
export function jsonRpcNotification(method, params) {
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
export function mcpInitializeRequest() {
  return {
    protocolVersion: "2025-11-25",
    capabilities: {
      roots: { listChanged: false },
      sampling: {},
    },
    clientInfo: {
      name: "hotdog",
      version: "0.1.0",
    },
  };
}

/**
 * Parse MCP initialize response from server.
 */
export function parseMcpInitializeResponse(data) {
  return {
    protocolVersion: data.protocolVersion || null,
    capabilities: parseMcpServerCapabilities(data.capabilities || {}),
    serverInfo: {
      name: data.serverInfo?.name || "unknown",
      version: data.serverInfo?.version || "unknown",
    },
    instructions: data.instructions || null,
  };
}

function parseMcpServerCapabilities(cap) {
  return {
    logging: cap.logging || null,
    prompts: cap.prompts || null,
    resources: cap.resources || null,
    tools: cap.tools
      ? {
          listChanged: cap.tools.listChanged || false,
        }
      : null,
  };
}

/**
 * Parse MCP tools/list response.
 */
export function parseMcpToolsListResponse(data) {
  return {
    tools: (data.tools || []).map(parseMcpToolDefinition),
    nextCursor: data.nextCursor || null,
  };
}

/**
 * Parse a tool definition from an MCP server.
 */
export function parseMcpToolDefinition(tool) {
  return {
    name: tool.name || "",
    title: tool.title || null,
    description: tool.description || null,
    inputSchema: tool.inputSchema || {},
  };
}

/**
 * Create MCP tools/call request.
 */
export function mcpToolCallRequest(name, arguments_) {
  return {
    name,
    ...(arguments_ !== undefined && arguments_ !== null
      ? { arguments: arguments_ }
      : {}),
  };
}

/**
 * Parse MCP tools/call response.
 */
export function parseMcpToolCallResponse(data) {
  return {
    content: (data.content || []).map(parseMcpContentBlock),
    isError: data.isError || false,
  };
}

/**
 * Parse a content block in a tool call response.
 */
export function parseMcpContentBlock(block) {
  if (!block || !block.type) return { type: "unknown" };

  switch (block.type) {
    case "text":
      return { type: "text", text: block.text || "" };
    case "image":
      return {
        type: "image",
        data: block.data || "",
        mimeType: block.mimeType || "",
      };
    case "resource":
      return {
        type: "resource",
        uri: block.uri || "",
        mimeType: block.mimeType || "",
        text: block.text || null,
        blob: block.blob || null,
      };
    default:
      return { type: "unknown" };
  }
}

/**
 * Convert MCP content blocks to a single string.
 */
export function contentBlocksToString(blocks) {
  const parts = [];
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
