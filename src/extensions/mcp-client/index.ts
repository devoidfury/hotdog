import { HOOKS } from "@core/hooks.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import { McpConnection } from "./connection.ts";
import { resolveRequestTimeoutMs } from "./client.ts";
import { resolveHttpTimeoutMs } from "./transports.ts";
import { McpTool } from "./tools.ts";
import { type CoreContext, type ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";
import { envScrubExtraKeys } from "@utils/env.ts";

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

/** Config shape of the resolved mcpClient block. The config layer merges the
 *  schema-owned defaults (extension.json: 30/30), so both keys are present. */
interface McpClientConfig {
  httpTimeoutSecs: number;
  requestTimeoutSecs: number;
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

  // Junk block values (0, -5, non-number -- resolution merges but does not
  // clamp) sanitize against the timeout owners' module defaults
  // (transports.ts / client.ts): "never no timeout" holds for hand-built or
  // malformed blocks without a code-resident constant here (Centralized
  // Defaults).
  const clientConfig = getExtensionConfig<McpClientConfig>(core, "mcpClient");
  const httpTimeoutMs = resolveHttpTimeoutMs(clientConfig.httpTimeoutSecs);
  // Stdio request-response timeout (config: mcpClient.requestTimeoutSecs).
  // A wedged stdio server must fail the tool call, not pin it for 30s per
  // request with no way to tune it.
  const requestTimeoutMs = resolveRequestTimeoutMs(clientConfig.requestTimeoutSecs);
  const envScrubExtra = envScrubExtraKeys(core.config);
  const envScrubbing = core.resolved?.envScrubbing !== false;

  const connections: McpConnection[] = [];

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const server of enabledServers) {
          try {
            const conn = await _connectServer(server, Connection, httpTimeoutMs, requestTimeoutMs, envScrubExtra, envScrubbing);
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
  requestTimeoutMs: number,
  envScrubExtra?: readonly string[],
  envScrubbing: boolean = true,
): Promise<McpConnection | null> {
  try {
    if (server.url) {
      return await Connection.connectHttp(server.name, server.url, httpTimeoutMs, server.headers || {});
    } else if (server.command) {
      return await Connection.connectStdio(server.name, server.command, requestTimeoutMs, server.args || [], server.env || {}, envScrubExtra, envScrubbing);
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
