// MCP connection lifecycle management.
// Wraps McpClient with connection setup, tool discovery, and graceful shutdown.

import { McpClient, McpError } from "./client.js";
import { contentBlocksToString } from "./types.js";

/**
 * Shared client handle for use by McpTool instances.
 */
export class McpConnectionHandle {
  constructor(client, serverName) {
    this._client = client;
    this._serverName = serverName;
  }

  /**
   * Call a tool by name with the given arguments.
   */
  async callTool(name, arguments_) {
    const response = await this._client.callTool(name, arguments_);
    const output = contentBlocksToString(response.content);

    if (response.isError) {
      throw new McpError(output, -1);
    }

    return output;
  }

  get serverName() {
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
  static async connectStdio(serverName, command, args = [], env = {}) {
    const client = await McpClient.forStdio(command, args, env);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  /**
   * Connect to an MCP server via HTTP with custom headers.
   */
  static async connectHttp(serverName, url, headers = {}) {
    const client = await McpClient.forHttp(url, headers);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  constructor(client, serverName) {
    this._client = client;
    this._serverName = serverName;
    this._tools = [];
  }

  async _initialize() {
    const serverInfo = await this._client.initialize();
    await this._discoverTools();
  }

  /**
   * Discover all tools from the server (with cursor pagination).
   */
  async _discoverTools() {
    const allTools = [];
    let cursor = null;

    do {
      const result = await this._client.listTools();
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    this._tools = allTools;
  }

  /**
   * Get all discovered tools.
   */
  get tools() {
    return this._tools;
  }

  /**
   * Get the server name.
   */
  get serverName() {
    return this._serverName;
  }

  /**
   * Create a shared handle for use by tool instances.
   */
  handle() {
    return new McpConnectionHandle(this._client, this._serverName);
  }

  /**
   * Shutdown the connection.
   */
  async shutdown() {
    await this._client.shutdown();
  }
}

