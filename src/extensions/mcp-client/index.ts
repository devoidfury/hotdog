import { HOOKS } from "@core/hooks.ts";
import { logger } from "@core/logger.ts";
import { formatError } from "@core/error.ts";
import { McpConnection } from "./connection.ts";
import { McpTool } from "./tools.ts";
import { type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";

export { McpClient, McpError } from "./client.ts";
export { McpConnection, McpConnectionHandle } from "./connection.ts";
export { McpTool } from "./tools.ts";

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

/** @param Connection - Optional McpConnection class override for testing. */
export function create(core: CoreContext, Connection = McpConnection): ExtensionInstance | null {
  // mcpServers is an array, not an object — read it directly from core.config
  const mcpServers = (core.config?.mcpServers as McpServerConfig[]) || [];
  const enabledServers = mcpServers.filter((s) => s.enabled !== false);

  if (core.config.sandboxMode || enabledServers.length === 0) {
    return null;
  }

  const connections: McpConnection[] = [];

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const server of enabledServers) {
          try {
            const conn = await _connectServer(server, Connection);
            if (!conn) continue;
            connections.push(conn);

            const blacklist = server.blacklistTools || [];
            for (const toolDef of conn.tools) {
              const def = toolDef as {
                name: string;
                title: string | null;
                description: string | null;
                inputSchema: Record<string, unknown>;
              };
              if (blacklist.includes(def.name as string)) continue;
              const tool = new McpTool(server.name, def, conn.handle());
              registry.register(tool.registeredName, tool);
            }
          } catch (e: unknown) {
            logger.error(`[mcp] Failed to connect to server '${server.name}': ${formatError(e)}`);
          }
        }
      },

      [HOOKS.SHUTDOWN_CLEANUP]: async () => {
        await _shutdownAll(connections);
      },
    },

    connections,

    async shutdown(): Promise<void> {
      await _shutdownAll(connections);
    },
  };
}

async function _connectServer(
  server: McpServerConfig,
  Connection: typeof McpConnection,
): Promise<McpConnection | null> {
  try {
    if (server.url) {
      return await Connection.connectHttp(server.name, server.url, server.headers || {});
    } else if (server.command) {
      return await Connection.connectStdio(server.name, server.command, server.args || [], server.env || {});
    }
    return null;
  } catch (e: unknown) {
    logger.error(`[mcp] Failed to connect to '${server.name}': ${formatError(e)}`);
    return null;
  }
}

async function _shutdownAll(connections: McpConnection[]): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.shutdown();
    } catch (e: unknown) {
      logger.error(`[mcp] Error shutting down connection: ${formatError(e)}`);
    }
  }
}
