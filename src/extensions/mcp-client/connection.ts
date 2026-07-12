// MCP connection lifecycle management.
// Wraps McpClient with connection setup, tool discovery, and graceful shutdown.

import { McpClient, McpError } from "./client.ts";
import { contentBlocksToString } from "./types.ts";

/**
 * Shared client handle for use by McpTool instances.
 */
export class McpConnectionHandle {
  private readonly #client: McpClient;
  private readonly #serverName: string;

  constructor(client: McpClient, serverName: string) {
    this.#client = client;
    this.#serverName = serverName;
  }

  /**
   * Call a tool by name with the given arguments.
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const response = await this.#client.callTool(name, arguments_) as Record<string, unknown>;
    const output = contentBlocksToString((response.content as Record<string, unknown>[]) || []);

    if (response.isError) {
      throw new McpError(output, -1);
    }

    return output;
  }

  get serverName(): string {
    return this.#serverName;
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

  private readonly #client: McpClient;
  private readonly #serverName: string;
  private #tools: Record<string, unknown>[] = [];

  constructor(client: McpClient, serverName: string) {
    this.#client = client;
    this.#serverName = serverName;
  }

  private async _initialize(): Promise<void> {
    await this.#client.initialize();
    await this._discoverTools();
  }

  /**
   * Discover all tools from the server (with cursor pagination).
   */
  private async _discoverTools(): Promise<void> {
    const allTools: Record<string, unknown>[] = [];
    let cursor: string | null = null;

    do {
      const result = await this.#client.listTools() as Record<string, unknown>;
      allTools.push(...(result.tools as Record<string, unknown>[]));
      cursor = result.nextCursor as string | null;
    } while (cursor);

    this.#tools = allTools;
  }

  /**
   * Get all discovered tools.
   */
  get tools(): Record<string, unknown>[] {
    return this.#tools;
  }

  /**
   * Get the server name.
   */
  get serverName(): string {
    return this.#serverName;
  }

  /**
   * Create a shared handle for use by tool instances.
   */
  handle(): McpConnectionHandle {
    return new McpConnectionHandle(this.#client, this.#serverName);
  }

  /**
   * Shutdown the connection.
   */
  async shutdown(): Promise<void> {
    await this.#client.shutdown();
  }
}
