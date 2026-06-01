// MCP client module — Model Context Protocol support.
// Provides a minimal MCP client connecting to servers via stdio or HTTP,
// discovering tools, and exposing them as native agent tools.

export { McpClient } from "./client.js";
export { McpConnection, McpConnectionHandle } from "./connection.js";
export { McpTool } from "./tools.js";
export {
  McpError,
} from "./client.js";

// Type helpers
export {
  jsonRpcRequest,
  jsonRpcNotification,
  mcpInitializeRequest,
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolDefinition,
  mcpToolCallRequest,
  parseMcpToolCallResponse,
  parseMcpContentBlock,
  contentBlocksToString,
} from "./types.js";
