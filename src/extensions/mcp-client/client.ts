import {
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpToolCallRequest,
  mcpInitializeRequest,
} from "./types.ts";
import { McpTransport, StdioTransport, HttpTransport, DEFAULT_HTTP_TIMEOUT_MS } from "./transports.ts";
import { ExtensionError } from "@core/error.ts";

export class McpError extends ExtensionError {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

class PendingRequest {
  readonly id: number;
  resolve: ((value: unknown) => void) | null = null;
  reject: ((reason: Error) => void) | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: number) {
    this.id = id;
  }
}

export class McpClient {
  readonly #transport: McpTransport;

  #idCounter: number = 0;

  // Pending requests: id -> PendingRequest. Stdio only; HTTP responses come from send().
  #pending: Map<number, PendingRequest> = new Map();

  // Responses that arrived before their request. Stdio only.
  #buffered: { id: number; result: unknown; error: unknown; raw: string }[] = [];

  #serverCapabilities: unknown = null;

  #serverInfo: unknown = null;

  #cancelled: boolean = false;

  #messageCleanup: (() => void) | null = null;

  constructor(transport: McpTransport) {
    this.#transport = transport;

    if (transport.isStreaming) {
      this.#messageCleanup = transport.onMessage((line) => {
        void this.#handleLine(line);
      });
    }
  }

  static async forStdio(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<McpClient> {
    const transport = new StdioTransport(command, args, env);

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

  static async forHttp(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<McpClient> {
    const transport = new HttpTransport(url, headers, timeoutMs);
    return new McpClient(transport);
  }

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

  async #handleLine(line: string): Promise<void> {
    line = line.trim();
    if (!line) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
      if (msg.result !== undefined || msg.error !== undefined) {
        const pending = this.#pending.get(msg.id as number);
        if (pending) {
          this.#pending.delete(msg.id as number);
          if (msg.error) {
            const errMsg =
              ((msg.error as Record<string, unknown>).message as string) ||
              `MCP error code ${(msg.error as Record<string, unknown>).code}`;
            const fullMsg = `${errMsg}\nRaw response: ${line}`;
            pending.reject?.(
              new McpError(fullMsg, ((msg.error as Record<string, unknown>).code as number) || -1),
            );
          } else {
            pending.resolve?.(msg.result);
          }
        } else {
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

  private async _sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#cancelled) {
      throw new McpError("Client is cancelled");
    }

    const id = ++this.#idCounter;
    const request = jsonRpcRequest(id, method, params);
    const serialized = JSON.stringify(request);

    for (let i = 0; i < this.#buffered.length; i++) {
      const buf = this.#buffered[i];
      if (!buf) continue;
      if (buf.id === id) {
        this.#buffered.splice(i, 1);
        if (buf.error) {
          throw new McpError(
            ((buf.error as Record<string, unknown>).message as string) ||
              `MCP error code ${(buf.error as Record<string, unknown>).code}`,
            ((buf.error as Record<string, unknown>).code as number) || -1,
          );
        }
        return buf.result;
      }
    }

    if (!this.#transport.isStreaming) {
      const result = await this.#transport.send(serialized);
      return result ?? undefined;
    }

    const pending = new PendingRequest(id);
    this.#pending.set(id, pending);
    await this.#transport.send(serialized);

    const result = await new Promise<unknown>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError("Timeout waiting for response"));
      }, 30000);
    });

    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    return result;
  }

  async initialize(): Promise<unknown> {
    const result = await this._sendRequest("initialize", mcpInitializeRequest());
    const response = parseMcpInitializeResponse(result as Record<string, unknown>);

    this.#serverCapabilities = response.capabilities;
    this.#serverInfo = response.serverInfo;

    // The initialized notification is only needed for streaming transports
    if (this.#transport.isStreaming) {
      const notification = jsonRpcNotification("notifications/initialized");
      this.#transport.sendNotification(JSON.stringify(notification));
    }

    return response;
  }

  async listTools(): Promise<unknown> {
    const result = await this._sendRequest("tools/list", {});
    return parseMcpToolsListResponse(result as Record<string, unknown>);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this._sendRequest("tools/call", mcpToolCallRequest(name, args));
    return parseMcpToolCallResponse(result as Record<string, unknown>);
  }

  /** Get server capabilities (after initialize). */
  get serverCapabilities(): unknown {
    return this.#serverCapabilities;
  }

  /** Get server info (after initialize). */
  get serverInfo(): unknown {
    return this.#serverInfo;
  }

  /** Shutdown the connection. Rejects all pending requests and cleans up the transport. */
  async shutdown(): Promise<void> {
    this.#cancelled = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) pending.reject(new McpError("Cancelled"));
    }
    this.#messageCleanup?.();
    this.#messageCleanup = null;
    await this.#transport.destroy();
  }
}
