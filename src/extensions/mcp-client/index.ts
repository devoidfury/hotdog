import { HOOKS } from "@core/hooks.ts";
import { logger } from "@core/logger.ts";
import { formatError } from "@core/error.ts";
import { McpConnection } from "./connection.ts";
import { McpTool } from "./tools.ts";
import { type CoreContext, type ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";

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

/** Fallback when config is absent or malformed (the schema default is 30). */
const DEFAULT_HTTP_TIMEOUT_SECS = 30;

/**
 * Sanitize the config-supplied timeout: a missing or non-positive value
 * must mean "use the default", never "no timeout" (an unbounded timeout is
 * exactly the hang this setting exists to prevent).
 */
function resolveHttpTimeoutSecs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HTTP_TIMEOUT_SECS;
}

/** @param options - Loader options; `Connection` overrides the McpConnection class (test seam). */
export function create(core: CoreContext, options: { Connection?: typeof McpConnection } = {}): ExtensionInstance | null {
  const Connection = options.Connection ?? McpConnection;
  // mcpServers is an array, not an object — read it directly from core.config
  const mcpServers = (core.config?.mcpServers as McpServerConfig[]) || [];
  const enabledServers = mcpServers.filter((s) => s.enabled !== false);

  if (core.config.sandboxMode || enabledServers.length === 0) {
    return null;
  }

  const clientConfig = getExtensionConfig<{ httpTimeoutSecs?: number }>(core, "mcpClient");
  const httpTimeoutMs = Math.round(resolveHttpTimeoutSecs(clientConfig.httpTimeoutSecs) * 1000);

  const connections: McpConnection[] = [];

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const server of enabledServers) {
          try {
            const conn = await _connectServer(server, Connection, httpTimeoutMs);
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
  httpTimeoutMs: number,
): Promise<McpConnection | null> {
  try {
    if (server.url) {
      return await Connection.connectHttp(server.name, server.url, server.headers || {}, httpTimeoutMs);
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
