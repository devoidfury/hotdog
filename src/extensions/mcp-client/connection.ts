import { McpClient } from "./client.ts";
import { McpContentBlock, McpError } from "./types.ts";
import type { ElicitationHandler } from "./elicitation.ts";

/**
 * Hard caps on tools/list pagination against a buggy or hostile server:
 * a constant or oscillating nextCursor otherwise means infinite round-trips
 * with monotonically growing memory, before a single tool is usable.
 */
export const MAX_TOOL_LIST_PAGES = 100;
export const MAX_DISCOVERED_TOOLS = 1000;

/** Shared client handle for use by McpTool instances. */
export class McpConnectionHandle {
  readonly #client: McpClient;
  readonly #serverName: string;

  constructor(client: McpClient, serverName: string) {
    this.#client = client;
    this.#serverName = serverName;
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    onElicitation?: ElicitationHandler | null,
  ): Promise<string> {
    const response = await this.#client.callTool(name, arguments_, onElicitation) as Record<string, unknown>;
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
  static async connectStdio(
    serverName: string,
    command: string,
    requestTimeoutMs: number,
    args: string[] = [],
    env: Record<string, string> = {},
    extraScrubKeys?: readonly string[],
    envScrubbing: boolean = true,
  ): Promise<McpConnection> {
    const client = await McpClient.forStdio(command, requestTimeoutMs, args, env, extraScrubKeys, envScrubbing);
    const conn = new McpConnection(client, serverName);
    try {
      await conn._initialize();
    } catch (e: unknown) {
      // Discovery/init failure must not orphan the spawned server: tear the
      // transport down (the error itself propagates to the caller's catch).
      try { await conn.shutdown(); } catch { /* best-effort teardown */ }
      throw e;
    }
    return conn;
  }

  static async connectHttp(
    serverName: string,
    url: string,
    timeoutMs: number,
    headers: Record<string, string> = {},
  ): Promise<McpConnection> {
    const client = await McpClient.forHttp(url, timeoutMs, headers);
    const conn = new McpConnection(client, serverName);
    try {
      await conn._initialize();
    } catch (e: unknown) {
      try { await conn.shutdown(); } catch { /* best-effort teardown */ }
      throw e;
    }
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
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const result = await this.#client.listTools(cursor) as Record<string, unknown>;
      allTools.push(...(result.tools as Record<string, unknown>[]));
      pages++;
      if (allTools.length > MAX_DISCOVERED_TOOLS) {
        throw new McpError(
          `MCP server '${this.#serverName}' exceeded the ${MAX_DISCOVERED_TOOLS}-tool discovery cap (${allTools.length} tools across ${pages} pages); aborting`,
        );
      }
      cursor = (result.nextCursor as string | null) ?? null;
      if (cursor) {
        if (pages >= MAX_TOOL_LIST_PAGES) {
          throw new McpError(
            `MCP server '${this.#serverName}' kept paginating past the ${MAX_TOOL_LIST_PAGES}-page tools/list cap; aborting`,
          );
        }
        // A cursor already seen this pass (constant or oscillating) means the
        // server is looping: no sane server revisits a cursor within one
        // traversal, and revisiting one never terminates.
        if (seenCursors.has(cursor)) {
          throw new McpError(
            `MCP server '${this.#serverName}' returned the repeated tools/list cursor "${cursor}"; aborting pagination loop`,
          );
        }
        seenCursors.add(cursor);
      }
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

export function contentBlocksToString(blocks: McpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "image":
        parts.push(`[Image: ${block.mimeType || "image"} (${(block.data || "").length} bytes)]`);
        break;
      case "audio":
        parts.push(`[Audio: ${block.mimeType || "audio"} (${(block.data || "").length} bytes)]`);
        break;
      case "resource_link":
        parts.push(
          `[Resource link: ${block.name ? `${block.name} ` : ""}${block.uri || ""}]`,
        );
        break;
      case "resource":
        if (block.text) {
          parts.push(`[Resource: ${block.uri || ""}]\n${block.text}`);
        } else {
          parts.push(
            `[Resource: ${block.uri || ""}${block.blob ? ` (${block.blob.length} bytes blob)` : ""}]`,
          );
        }
        break;
      default:
        parts.push("[Unknown content block]");
    }
  }
  return parts.join("\n");
}
