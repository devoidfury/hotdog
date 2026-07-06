// MCP client module — Model Context Protocol support.
// Provides a minimal MCP client connecting to servers via stdio or HTTP,
// discovering tools, and exposing them as native agent tools.
//
// As an extension, it connects to configured MCP servers and registers
// their discovered tools via the tools:register hook.

import { HOOKS } from '../../core/hooks.js';
import { logger } from '../../core/logger.js';
import { formatError } from '../../core/error.js';
import { McpConnection } from './connection.js';
import { McpTool } from './tools.js';

// Re-exports for external use
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

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the MCP client extension.
 * Connects to configured MCP servers and registers their tools.
 *
 * @param {Object} core - The core object with hooks, config, etc.
 * @returns {Object|null} Extension instance, or null if no MCP servers configured.
 */
export function create(core) {
  const mcpServers = core.config?.mcpServers || [];
  const enabledServers = mcpServers.filter((s) => s.enabled !== false);

  if (enabledServers.length === 0) {
    return null;
  }

  // Track connections for cleanup
  const connections = [];

  return {
    hooks: {
      /**
       * Register MCP tools from all connected servers.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const server of enabledServers) {
          try {
            const conn = await _connectServer(server);
            if (!conn) continue;
            connections.push(conn);

            // Register each discovered tool (skip blacklisted)
            const blacklist = server.blacklistTools || [];
            for (const toolDef of conn.tools) {
              if (blacklist.includes(toolDef.name)) continue;
              const tool = new McpTool(conn.serverName, toolDef, conn.handle());
              registry.register(tool.registeredName, tool);
            }
          } catch (e) {
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
    async shutdown() {
      await _shutdownAll(connections);
    },
  };
}

/**
 * Connect to an MCP server based on its configuration.
 *
 * @param {Object} server - Server configuration.
 * @param {string} server.name - Server name.
 * @param {string} [server.command] - Stdio command.
 * @param {string} [server.url] - HTTP URL.
 * @param {string[]} [server.args] - Command arguments.
 * @param {Object} [server.env] - Environment variables.
 * @returns {Promise<McpConnection|null>} Connection instance, or null on failure.
 */
async function _connectServer(server) {
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
  } catch (e) {
    logger.error(`[mcp] Failed to connect to '${server.name}': ${formatError(e)}`);
    return null;
  }
}

/**
 * Shutdown all MCP connections.
 *
 * @param {McpConnection[]} connections - Array of connections to shutdown.
 * @returns {Promise<void>}
 */
async function _shutdownAll(connections) {
  for (const conn of connections) {
    try {
      await conn.shutdown();
    } catch (e) {
      logger.error(`[mcp] Error shutting down connection: ${formatError(e)}`);
    }
  }
}
