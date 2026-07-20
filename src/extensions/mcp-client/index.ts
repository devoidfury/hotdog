// MCP client module — Model Context Protocol support.
// Provides a minimal MCP client connecting to servers via stdio or HTTP,
// discovering tools, and exposing them as native agent tools.
//
// As an extension, it connects to configured MCP servers and registers
// their discovered tools via the tools:register hook.

import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { formatError } from "../../core/error.ts";
import { McpConnection } from "./connection.ts";
import { McpTool } from "./tools.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
} from "../../core/extensions/types.ts";

// Re-exports for external use
export { McpClient } from "./client.ts";
export { McpConnection, McpConnectionHandle } from "./connection.ts";
export { McpTool } from "./tools.ts";
export {
  McpError,
} from "./client.ts";

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
} from "./types.ts";

interface McpServerConfig {
  name: string;
  enabled?: boolean;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  blacklistTools?: string[];
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the MCP client extension.
 * Connects to configured MCP servers and registers their tools.
 */
export function create(core: CoreContext): ExtensionInstance | null {
  // mcpServers is an array, not an object — read it directly from core.config
  const mcpServers = (core.config?.mcpServers as McpServerConfig[]) || [];
  const enabledServers = mcpServers.filter((s) => s.enabled !== false);

  if (enabledServers.length === 0) {
    return null;
  }

  // Track connections for cleanup
  const connections: McpConnection[] = [];

  return {
    hooks: {
      /**
       * Register MCP tools from all connected servers.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload & { register(name: string, tool: McpTool): void }) => {
        for (const server of enabledServers) {
          try {
            const conn = await _connectServer(server);
            if (!conn) continue;
            connections.push(conn);

            // Register each discovered tool (skip blacklisted)
            const blacklist = server.blacklistTools || [];
            for (const toolDef of conn.tools) {
              const def = toolDef as { name: string; title?: string | null; description?: string | null; inputSchema?: Record<string, unknown> };
              if (blacklist.includes(def.name as string)) continue;
              const tool = new McpTool(server.name, def, conn.handle());
              registry.register(tool.registeredName, tool);
            }
          } catch (e: unknown) {
            logger.error(`[mcp] Failed to connect to server '${server.name}': ${formatError(e)}`);
          }
        }
      },

      /**
       * Shutdown all MCP connections on cleanup.
       */
      [HOOKS.SHUTDOWN_CLEANUP]: async () => {
        await _shutdownAll(connections);
      },
    },

    // Expose for external use
    connections,

    /**
     * Shutdown all MCP connections.
     */
    async shutdown(): Promise<void> {
      await _shutdownAll(connections);
    },
  };
}

/**
 * Connect to an MCP server based on its configuration.
 */
async function _connectServer(server: McpServerConfig): Promise<McpConnection | null> {
  try {
    if (server.url) {
      // HTTP transport
      return await McpConnection.connectHttp(server.name, server.url, server.headers || {});
    } else if (server.command) {
      // Stdio transport
      return await McpConnection.connectStdio(
        server.name,
        server.command,
        server.args || [],
        server.env || {},
      );
    }
    return null;
  } catch (e: unknown) {
    logger.error(`[mcp] Failed to connect to '${server.name}': ${formatError(e)}`);
    return null;
  }
}

/**
 * Shutdown all MCP connections.
 */
async function _shutdownAll(connections: McpConnection[]): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.shutdown();
    } catch (e: unknown) {
      logger.error(`[mcp] Error shutting down connection: ${formatError(e)}`);
    }
  }
}
