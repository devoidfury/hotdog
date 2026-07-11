// MCP connection lifecycle management.
// Wraps McpClient with connection setup, tool discovery, and graceful shutdown.

import { McpClient, McpError } from "./client.ts";
import { contentBlocksToString } from "./types.ts";

/**
 * Shared client handle for use by McpTool instances.
 */
export class McpConnectionHandle {
  private readonly _client: McpClient;
  private readonly _serverName: string;

  constructor(client: McpClient, serverName: string) {
    this._client = client;
    this._serverName = serverName;
  }

  /**
   * Call a tool by name with the given arguments.
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const response = await this._client.callTool(name, arguments_) as Record<string, unknown>;
    const output = contentBlocksToString((response.content as Record<string, unknown>[]) || []);

    if (response.isError) {
      throw new McpError(output, -1);
    }

    return output;
  }

  get serverName(): string {
    return this._serverName;
  }
}

/**
 * A managed MCP connection with tool discovery.
 */
export class McpConnection {
  /**
   * Connect to an MCP server via stdio.
   */
  static async connectStdio(serverName: string, command: string, args: string[] = [], env: Record<string, string> = {}): Promise<McpConnection> {
    const client = await McpClient.forStdio(command, args, env);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  /**
   * Connect to an MCP server via HTTP with custom headers.
   */
  static async connectHttp(serverName: string, url: string, headers: Record<string, string> = {}): Promise<McpConnection> {
    const client = await McpClient.forHttp(url, headers);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  private readonly _client: McpClient;
  private readonly _serverName: string;
  private _tools: Record<string, unknown>[] = [];

  constructor(client: McpClient, serverName: string) {
    this._client = client;
    this._serverName = serverName;
  }

  private async _initialize(): Promise<void> {
    await this._client.initialize();
    await this._discoverTools();
  }

  /**
   * Discover all tools from the server (with cursor pagination).
   */
  private async _discoverTools(): Promise<void> {
    const allTools: Record<string, unknown>[] = [];
    let cursor: string | null = null;

    do {
      const result = await this._client.listTools() as Record<string, unknown>;
      allTools.push(...(result.tools as Record<string, unknown>[]));
      cursor = result.nextCursor as string | null;
    } while (cursor);

    this._tools = allTools;
  }

  /**
   * Get all discovered tools.
   */
  get tools(): Record<string, unknown>[] {
    return this._tools;
  }

  /**
   * Get the server name.
   */
  get serverName(): string {
    return this._serverName;
  }

  /**
   * Create a shared handle for use by tool instances.
   */
  handle(): McpConnectionHandle {
    return new McpConnectionHandle(this._client, this._serverName);
  }

  /**
   * Shutdown the connection.
   */
  async shutdown(): Promise<void> {
    await this._client.shutdown();
  }
}
