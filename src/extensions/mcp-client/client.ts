// MCP client — JSON-RPC protocol layer for Model Context Protocol.
// Handles request/response tracking, buffering, initialization, and tool operations.
// Uses a transport abstraction (stdio or HTTP) for low-level communication.

import {
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpToolCallRequest,
  mcpInitializeRequest,
} from "./types.ts";
import { McpTransport, StdioTransport, HttpTransport } from "./transports.ts";
import { logger } from "../../core/logger.ts";
import { formatError } from "../../core/error.ts";

/**
 * MCP error type.
 */
export class McpError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/**
 * Pending request tracker for stdio transport.
 */
class PendingRequest {
  readonly id: number;
  resolve: ((value: unknown) => void) | null = null;
  reject: ((reason: Error) => void) | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: number) {
    this.id = id;
  }
}

/**
 * MCP client that manages JSON-RPC communication with an MCP server.
 *
 * Uses a transport abstraction for low-level I/O:
 * - StdioTransport: subprocess stdin/stdout (newline-delimited JSON)
 * - HttpTransport: HTTP POST with SSE response support
 *
 * The client handles:
 * - Request ID generation and tracking
 * - Response buffering (for out-of-order delivery)
 * - Server initialization
 * - Tool listing and calling
 */
export class McpClient {
  readonly #transport: McpTransport;

  // Request ID counter
  #idCounter: number = 0;

  // Pending requests: id -> PendingRequest (stdio only)
  #pending: Map<number, PendingRequest> = new Map();

  // Buffered responses not yet matched (stdio only)
  #buffered: { id: number; result: unknown; error: unknown; raw: string }[] = [];

  // Server capabilities (filled after initialize)
  #serverCapabilities: unknown = null;

  // Server info (filled after initialize)
  #serverInfo: unknown = null;

  // Cancellation flag
  #cancelled: boolean = false;

  // Message handler cleanup
  #messageCleanup: (() => void) | null = null;

  constructor(transport: McpTransport) {
    this.#transport = transport;

    // Set up message handler for streaming transports (stdio)
    if (transport.isStreaming) {
      this.#messageCleanup = transport.onMessage((line) => {
        void this.#handleLine(line);
      });
    }
  }

  /**
   * Create a new client with a stdio transport.
   * Spawns a subprocess and communicates via stdin/stdout.
   * @param command - Command to execute
   * @param args - Command arguments
   * @param env - Environment variables (merged with current env)
   * @returns Initialized McpClient
   */
  static async forStdio(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<McpClient> {
    const transport = new StdioTransport(command, args, env);

    // Wait for child to be ready (it needs to start up)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new McpError(`MCP server '${command}' failed to start within 10s`)),
        10000,
      );
      transport.child.on("spawn", () => {
        clearTimeout(timeout);
        resolve();
      });
      transport.child.on("error", (e: Error) => {
        clearTimeout(timeout);
        reject(new McpError(`Failed to spawn '${command}': ${e.message}`));
      });
      // If spawn already happened
      if (transport.child.pid !== undefined) {
        clearTimeout(timeout);
        resolve();
      }
    });

    return new McpClient(transport);
  }

  /**
   * Create a new client with an HTTP transport.
   * Communicates via HTTP POST with SSE response support.
   * @param url - MCP server endpoint URL
   * @param headers - Custom headers to include in requests
   * @returns Initialized McpClient
   */
  static async forHttp(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<McpClient> {
    const transport = new HttpTransport(url, headers);
    return new McpClient(transport);
  }

  // ── Test-only accessors ─────────────────────────────────────────────────

  /** @internal Exposed for testing. */
  get idCounter(): number {
    return this.#idCounter;
  }

  /** @internal Exposed for testing. */
  get pending(): Map<number, PendingRequest> {
    return this.#pending;
  }

  /** @internal Exposed for testing. */
  get buffered(): { id: number; result: unknown; error: unknown; raw: string }[] {
    return this.#buffered;
  }

  /** @internal Exposed for testing. */
  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** @internal Exposed for testing. */
  set cancelled(v: boolean) {
    this.#cancelled = v;
  }

  /** @internal Exposed for testing — access transport for inspection. */
  get transport(): McpTransport {
    return this.#transport;
  }

  // ── Message handling (stdio) ─────────────────────────────────────────────

  /**
   * Handle an incoming message line from the stdio transport.
   * Matches responses to pending requests or buffers them.
   * @private
   */
  async #handleLine(line: string): Promise<void> {
    line = line.trim();
    if (!line) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip unparseable lines
    }

    // Check if this is a response
    if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
      if (msg.result !== undefined || msg.error !== undefined) {
        const pending = this.#pending.get(msg.id as number);
        if (pending) {
          this.#pending.delete(msg.id as number);
          if (msg.error) {
            const errMsg =
              (msg.error as Record<string, unknown>).message as string ||
              `MCP error code ${(msg.error as Record<string, unknown>).code}`;
            const fullMsg = `${errMsg}\nRaw response: ${line}`;
            pending.reject?.(
              new McpError(
                fullMsg,
                (msg.error as Record<string, unknown>).code as number || -1,
              ),
            );
          } else {
            pending.resolve?.(msg.result);
          }
        } else {
          // Buffer it in case it arrives before the request
          this.#buffered.push({
            id: msg.id as number,
            result: msg.result,
            error: msg.error,
            raw: line,
          });
        }
      }
    }
  }

  // ── Request dispatch ─────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and wait for the response.
   * For stdio: uses pending request tracking.
   * For HTTP: returns the result directly from the transport.
   * @private
   */
  private async _sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#cancelled) {
      throw new McpError("Client is cancelled");
    }

    const id = ++this.#idCounter;
    const request = jsonRpcRequest(id, method, params);
    const serialized = JSON.stringify(request);

    // Check buffered responses first (stdio)
    for (let i = 0; i < this.#buffered.length; i++) {
      const buf = this.#buffered[i];
      if (!buf) continue;
      if (buf.id === id) {
        this.#buffered.splice(i, 1);
        if (buf.error) {
          throw new McpError(
            (buf.error as Record<string, unknown>).message as string ||
              `MCP error code ${(buf.error as Record<string, unknown>).code}`,
            (buf.error as Record<string, unknown>).code as number || -1,
          );
        }
        return buf.result;
      }
    }

    // HTTP mode: transport returns result directly
    if (!this.#transport.isStreaming) {
      const result = await this.#transport.send(serialized);
      return result ?? undefined;
    }

    // Stdio mode: use pending request mechanism
    const pending = new PendingRequest(id);
    this.#pending.set(id, pending);

    // Send the request (stdio transport writes to stdin, returns undefined)
    await this.#transport.send(serialized);

    // Wait for response or timeout
    const result = await new Promise<unknown>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError("Timeout waiting for response"));
      }, 30000);
    });

    // Clean up
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    return result;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Initialize the connection with the server.
   * Sends the initialize request and the initialized notification.
   * @returns Server capabilities and info
   */
  async initialize(): Promise<unknown> {
    const result = await this._sendRequest("initialize", mcpInitializeRequest());
    const response = parseMcpInitializeResponse(result as Record<string, unknown>);

    this.#serverCapabilities = response.capabilities;
    this.#serverInfo = response.serverInfo;

    // Send initialized notification (stdio only)
    if (this.#transport.isStreaming) {
      const notification = jsonRpcNotification("notifications/initialized");
      this.#transport.sendNotification(JSON.stringify(notification));
    }

    return response;
  }

  /**
   * List available tools from the server.
   * @returns Tools list response with tools array and optional nextCursor
   */
  async listTools(): Promise<unknown> {
    const result = await this._sendRequest("tools/list", {});
    return parseMcpToolsListResponse(result as Record<string, unknown>);
  }

  /**
   * Call a tool on the server.
   * @param name - Tool name
   * @param arguments_ - Tool arguments
   * @returns Tool call response with content blocks
   */
  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this._sendRequest(
      "tools/call",
      mcpToolCallRequest(name, arguments_),
    );
    return parseMcpToolCallResponse(result as Record<string, unknown>);
  }

  /**
   * Get server capabilities (after initialize).
   */
  get serverCapabilities(): unknown {
    return this.#serverCapabilities;
  }

  /**
   * Get server info (after initialize).
   */
  get serverInfo(): unknown {
    return this.#serverInfo;
  }

  /**
   * Shutdown the connection.
   * Rejects all pending requests and cleans up the transport.
   */
  async shutdown(): Promise<void> {
    this.#cancelled = true;

    // Reject all pending requests
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) pending.reject(new McpError("Cancelled"));
    }

    // Clean up message handler
    this.#messageCleanup?.();
    this.#messageCleanup = null;

    // Destroy the transport
    await this.#transport.destroy();
  }
}
