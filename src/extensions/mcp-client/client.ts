import {
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
  jsonRpcRequest,
  jsonRpcNotification,
  jsonRpcResponse,
  jsonRpcError,
  mcpToolCallRequest,
  mcpInitializeRequest,
  MCP_PROTOCOL_VERSION,
  McpError,
} from "./types.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import { McpTransport, StdioTransport, HttpTransport } from "./transports.ts";
import type { ElicitationHandler } from "./elicitation.ts";

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
 * resolved `mcpClient.requestTimeoutSecs` config through
 * resolveRequestTimeoutMs() instead (house rule: components take resolved
 * values; this backs the normalizer below for direct-construction callers).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sanitize a config-supplied stdio request timeout (seconds) to ms: a finite
 * positive number wins; anything else (missing, zero, negative, NaN,
 * non-number) takes DEFAULT_REQUEST_TIMEOUT_MS. Junk must mean "the default
 * timeout", never "no timeout" -- a wedged stdio server must fail the tool
 * call, not pin it forever. The schema default (30s) is merged by the config
 * layer; this guard covers malformed or hand-built blocks.
 */
export function resolveRequestTimeoutMs(requestTimeoutSecs: unknown): number {
  return typeof requestTimeoutSecs === "number" && Number.isFinite(requestTimeoutSecs) && requestTimeoutSecs > 0
    ? Math.round(requestTimeoutSecs * 1000)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

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

  // Server-initiated elicitation handlers, one per in-flight callTool. MCP
  // does not correlate an elicitation request to the tools/call that caused
  // it, so elicitations route to the most recent active handler (the stack);
  // an elicitation with no active call gets an honest cancel response.
  // CONSEQUENCE: with concurrent calls on one connection, the question the
  // human sees -- and the question_asked durability record -- are written
  // under the MOST RECENT call's tool_call_id, which may not be the call
  // that triggered the ask. Forensics reads the server attribution (the
  // [mcp:<server>] prompt prefix), not the tool_call_id, to see the source.
  #elicitations: ElicitationHandler[] = [];

  // In-flight elicitations: >0 means a human holds an ask and the pending
  // request timeouts are suspended (see #suspendedTimeouts).
  #elicitInFlight = 0;

  // Suspension of pending-request timeouts while an elicitation awaits a
  // human: pending id -> restore closure (re-arms the full response budget;
  // thinking time must not burn it -- the MCP spec forbids the server from
  // timing out mid-elicitation, and our own timer would be the hang this
  // feature exists to avoid).
  #suspendedTimeouts = new Map<number, () => void>();

  #messageCleanup: (() => void) | null = null;

  #closeCleanup: (() => void) | null = null;

  constructor(transport: McpTransport, requestTimeoutMs: number) {
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
    requestTimeoutMs: number,
    args: string[] = [],
    env: Record<string, string> = {},
    extraScrubKeys?: readonly string[],
    envScrubbing: boolean = true,
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
    timeoutMs: number,
    headers: Record<string, string> = {},
  ): Promise<McpClient> {
    const transport = new HttpTransport(url, headers, timeoutMs);
    // HTTP answers ride send(): the per-request timeout is the transport's;
    // the client's streaming timeout does not apply (pass the module default).
    return new McpClient(transport, DEFAULT_REQUEST_TIMEOUT_MS);
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
      } else if (typeof msg.method === "string") {
        // Server-initiated request (id + method, no result/error): MUST be
        // answered. Routed asynchronously -- a held elicitation must not
        // block the read loop from delivering later messages.
        void this.#handleServerRequest(msg);
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
    // A human wait outliving the connection: drop the restore bookkeeping;
    // the guarded closures become no-ops and the pending requests reject now.
    // KNOWN GAP: the human's own prompt stays on screen -- the answer they
    // eventually type resolves into a tool call that has already failed.
    // Acceptable because the interrupt that kills a server usually aborts
    // the run right behind it (question-tool cancel path); a stale answer
    // just goes unanswered from the server's side.
    this.#suspendedTimeouts.clear();
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
      this.#armTimeout(pending);
    });

    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    return result;
  }

  async initialize(): Promise<unknown> {
    // Elicitation is advertised only when a server->client channel exists
    // (isStreaming: the onMessage handler routes elicitation/create). Over
    // HTTP there is no channel, so the capability stays unadvertised.
    const result = await this._sendRequest("initialize", mcpInitializeRequest(this.#transport.isStreaming));
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onElicitation?: ElicitationHandler | null,
  ): Promise<unknown> {
    if (onElicitation) this.#elicitations.push(onElicitation);
    try {
      const result = await this._sendRequest("tools/call", mcpToolCallRequest(name, args));
      return parseMcpToolCallResponse(result as Record<string, unknown>);
    } finally {
      if (onElicitation) {
        const idx = this.#elicitations.indexOf(onElicitation);
        if (idx !== -1) this.#elicitations.splice(idx, 1);
      }
    }
  }

  // ── Server-initiated requests (elicitation, ping) ─────────────────────────

  /**
   * Arm (or re-arm) a pending request's response timeout. Extracted so an
   * in-flight elicitation can suspend it: the wait for a human answer must
   * not consume the server's response budget. Requests armed WHILE a human
   * hold is active are never armed live either: the server is blocked on the
   * whole connection during an elicitation, so any concurrent call (another
   * agent, background compaction) would spuriously time out. Restore only
   * fires when the hold count returns to zero.
   */
  #armTimeout(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (this.#elicitInFlight > 0) {
      this.#suspendedTimeouts.set(pending.id, () => {
        if (this.#pending.get(pending.id) === pending) this.#armTimeout(pending);
      });
      return;
    }
    pending.timer = setTimeout(() => {
      this.#pending.delete(pending.id);
      pending.reject?.(new McpError("Timeout waiting for response"));
    }, this.#requestTimeoutMs);
  }

  /** Handle a JSON-RPC request from the server: MUST be answered, or the
   *  server waits its own timeout before failing the tool call. */
  async #handleServerRequest(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id;
    const method = msg.method as string;

    if (method === "elicitation/create") {
      const handler = this.#elicitations[this.#elicitations.length - 1];
      if (!handler) {
        // Not attached to any live tool call: no human context to ask in.
        this.#respondToServer(jsonRpcResponse(id, { action: "cancel" }));
        return;
      }
      // Suspend pending response timers for the human wait; restore the full
      // budget when the elicitation settles.
      this.#elicitInFlight++;
      if (this.#elicitInFlight === 1) {
        for (const [pendingId, pending] of this.#pending) {
          if (!pending.timer) continue;
          clearTimeout(pending.timer);
          pending.timer = null;
          this.#suspendedTimeouts.set(
            pendingId,
            () => {
              // Skip a pending that settled or failed while suspended.
              if (this.#pending.get(pendingId) === pending) this.#armTimeout(pending);
            },
          );
        }
      }
      let result: Record<string, unknown>;
      try {
        result = await handler((msg.params as Record<string, unknown>) || {});
      } catch (e: unknown) {
        logger.error(`[mcp] elicitation handler threw: ${formatError(e)}`);
        result = { action: "cancel" };
      } finally {
        this.#elicitInFlight--;
        if (this.#elicitInFlight === 0) {
          for (const restore of this.#suspendedTimeouts.values()) restore();
          this.#suspendedTimeouts.clear();
        }
      }
      this.#respondToServer(jsonRpcResponse(id, result));
      return;
    }

    if (method === "ping") {
      // JSON-RPC liveness check: empty success result.
      this.#respondToServer(jsonRpcResponse(id, {}));
      return;
    }

    // Anything else (sampling/createMessage, roots/list, ...) is not
    // implemented; answer Method not found so the server fails fast.
    logger.warn(`[mcp] unsupported server request '${method}'; replying Method not found`);
    this.#respondToServer(jsonRpcError(id, -32601, `Method not found: ${method}`));
  }

  /** Send one message (response or error envelope) to a server-initiated
   *  request. sendNotification is the transport's fire-and-forget write (a
   *  response is not a request); a broken pipe must never surface as an
   *  unhandled rejection on the read loop. */
  #respondToServer(message: Record<string, unknown>): void {
    try {
      this.#transport.sendNotification(JSON.stringify(message));
    } catch (e: unknown) {
      logger.error(`[mcp] failed to respond to server request: ${formatError(e)}`);
    }
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
