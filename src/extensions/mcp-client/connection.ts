import { McpClient, McpError } from "./client.ts";
import { contentBlocksToString } from "./types.ts";
import { DEFAULT_HTTP_TIMEOUT_MS } from "./transports.ts";

/** Shared client handle for use by McpTool instances. */
export class McpConnectionHandle {
  readonly #client: McpClient;
  readonly #serverName: string;

  constructor(client: McpClient, serverName: string) {
    this.#client = client;
    this.#serverName = serverName;
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    const response = await this.#client.callTool(name, arguments_) as Record<string, unknown>;
    const output = contentBlocksToString((response.content as Array<{ type: string; text?: string }>) || []);

    if (response.isError) {
      throw new McpError(output, -1);
    }

    return output;
  }

  get serverName(): string {
    return this.#serverName;
  }
}

/** A managed MCP connection with tool discovery. */
export class McpConnection {
  static async connectStdio(serverName: string, command: string, args: string[] = [], env: Record<string, string> = {}): Promise<McpConnection> {
    const client = await McpClient.forStdio(command, args, env);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  static async connectHttp(
    serverName: string,
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<McpConnection> {
    const client = await McpClient.forHttp(url, headers, timeoutMs);
    const conn = new McpConnection(client, serverName);
    await conn._initialize();
    return conn;
  }

  readonly #client: McpClient;
  readonly #serverName: string;
  #tools: Record<string, unknown>[] = [];

  constructor(client: McpClient, serverName: string) {
    this.#client = client;
    this.#serverName = serverName;
  }

  private async _initialize(): Promise<void> {
    await this.#client.initialize();
    await this._discoverTools();
  }

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

  get tools(): Record<string, unknown>[] {
    return this.#tools;
  }

  get serverName(): string {
    return this.#serverName;
  }

  handle(): McpConnectionHandle {
    return new McpConnectionHandle(this.#client, this.#serverName);
  }

  async shutdown(): Promise<void> {
    await this.#client.shutdown();
  }
}
