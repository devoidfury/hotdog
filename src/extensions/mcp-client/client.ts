import {
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpToolCallRequest,
  mcpInitializeRequest,
  MCP_PROTOCOL_VERSION,
  McpError,
} from "./types.ts";
import { logger } from "@utils/logger.ts";
import { McpTransport, StdioTransport, HttpTransport, DEFAULT_HTTP_TIMEOUT_MS } from "./transports.ts";

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
 * Default per-request response timeout for streaming (stdio) transports.
 * A wedged server must not hang a tool call forever. Callers pass the
 * resolved `mcpClient.requestTimeoutSecs` config instead (house rule:
 * components take resolved values; this is the direct-construction default).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Hard cap on responses buffered ahead of their request. Buffered entries are
 * the only unbounded accumulation left in the client: a hostile or buggy
 * server can spew unmatched responses forever, so past the cap the
 * connection is declared broken (pending requests fail clean, buffer is
 * dropped, transport destroyed) instead of growing memory without bound.
 */
export const MAX_BUFFERED_RESPONSES = 1000;

export class McpClient {
  readonly #transport: McpTransport;
  readonly #requestTimeoutMs: number;

  #idCounter: number = 0;

  // Pending requests: id -> PendingRequest. Stdio only; HTTP responses come from send().
  #pending: Map<number, PendingRequest> = new Map();

  // Responses that arrived before their request. Stdio only.
  #buffered: { id: number; result: unknown; error: unknown; raw: string }[] = [];

  #serverCapabilities: unknown = null;

  #serverInfo: unknown = null;

  #cancelled: boolean = false;

  // Set when the transport closed (server process died or destroy()): new
  // requests fail fast instead of waiting out the response timeout.
  #transportClosed: boolean = false;

  #messageCleanup: (() => void) | null = null;

  #closeCleanup: (() => void) | null = null;

  constructor(transport: McpTransport, requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;

    if (transport.isStreaming) {
      this.#messageCleanup = transport.onMessage((line) => {
        void this.#handleLine(line);
      });
    }
    // Fail-fast on transport close: pending requests reject the moment the
    // server process/socket dies, not 30s later. shutdown() rejects first
    // with "Cancelled" and this becomes a no-op.
    this.#closeCleanup = transport.onClose(() => {
      this.#failAllPending(new McpError("MCP transport closed (server process exited)"));
    });
    // Death that beat the subscription (server crashed between spawn and
    // construction): start closed rather than hanging the first request.
    if (transport.exited) {
      this.#failAllPending(new McpError("MCP transport closed (server process exited)"));
    }
  }

  static async forStdio(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
    extraScrubKeys?: readonly string[],
    envScrubbing: boolean = true,
    requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<McpClient> {
    const transport = new StdioTransport(command, args, env, extraScrubKeys, envScrubbing);

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

    return new McpClient(transport, requestTimeoutMs);
  }

  static async forHttp(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<McpClient> {
    const transport = new HttpTransport(url, headers, timeoutMs);
    // HTTP answers ride send(): the per-request timeout is the transport's;
    // the client's streaming timeout does not apply.
    return new McpClient(transport);
  }

  /** @internal Exposed for testing. */
  get requestTimeoutMs(): number {
    return this.#requestTimeoutMs;
  }

  /** @internal Exposed for testing. */
  get transportClosed(): boolean {
    return this.#transportClosed;
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
          if (this.#buffered.length > MAX_BUFFERED_RESPONSES) {
            // Unmatched responses never stop coming: a hostile or broken
            // peer. Fail the connection cleanly -- the buffer is dropped
            // (so it stays bounded no matter how long the flood lasts),
            // every pending request rejects with a real error instead of
            // timing out, and the transport is torn down.
            logger.error(
              `[mcp] server flooded the connection with >${MAX_BUFFERED_RESPONSES} unmatched responses; failing the connection`,
            );
            this.#buffered = [];
            this.#failAllPending(
              new McpError(
                `MCP server sent more than ${MAX_BUFFERED_RESPONSES} responses with no matching request; connection failed`,
              ),
            );
            void this.#transport.destroy().catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Reject everything outstanding and stop accepting new requests (transport
   * close or buffered-response flood). Idempotent: later floods and the
   * shutdown path are no-ops once everything has settled. Buffered orphans
   * are NOT part of the teardown: the flood path drops them explicitly (the
   * close path keeps historic buffer semantics; a dead transport accepts
   * no new requests anyway).
   */
  #failAllPending(reason: Error): void {
    this.#transportClosed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject?.(reason);
    }
  }

  private async _sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#cancelled) {
      throw new McpError("Client is cancelled");
    }
    if (this.#transportClosed) {
      // The server process is already gone: fail now, not at timeout.
      throw new McpError("MCP transport closed");
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
      }, this.#requestTimeoutMs);
    });

    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    return result;
  }

  async initialize(): Promise<unknown> {
    const result = await this._sendRequest("initialize", mcpInitializeRequest());
    const response = parseMcpInitializeResponse(result as Record<string, unknown>);

    // MCP lifecycle "Version Negotiation": a client that does not support the
    // version in the server's response SHOULD disconnect. Decision (owner,
    // 2026-09-21): warn-and-continue -- real-world servers frequently echo a
    // wrong or missing version, and hard-failing breaks them. The mismatch is
    // never silent.
    if (response.protocolVersion !== MCP_PROTOCOL_VERSION) {
      logger.warn(
        `[mcp] server protocol version "${response.protocolVersion ?? "none"}" does not match client "${MCP_PROTOCOL_VERSION}"; continuing anyway`,
      );
    }

    // MCP transports spec: once the version is negotiated, HTTP transports
    // must stamp it on every subsequent request. (No-op for stdio.)
    this.#transport.setProtocolVersion?.(response.protocolVersion ?? MCP_PROTOCOL_VERSION);

    this.#serverCapabilities = response.capabilities;
    this.#serverInfo = response.serverInfo;

    // The initialized notification is only needed for streaming transports
    if (this.#transport.isStreaming) {
      const notification = jsonRpcNotification("notifications/initialized");
      this.#transport.sendNotification(JSON.stringify(notification));
    }

    return response;
  }

  async listTools(cursor?: string | null): Promise<unknown> {
    // The cursor MUST be echoed back per the tools/list pagination contract;
    // a spec-conformant server restarts from page one when it is omitted,
    // so a paginating client loop without it never terminates.
    const params: Record<string, unknown> = cursor ? { cursor } : {};
    const result = await this._sendRequest("tools/list", params);
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
    this.#buffered = [];
    this.#messageCleanup?.();
    this.#messageCleanup = null;
    this.#closeCleanup?.();
    this.#closeCleanup = null;
    await this.#transport.destroy();
  }
}
