// MCP client with stdio and HTTP transports.
// Handles JSON-RPC message exchange over:
// - **Stdio**: subprocess stdin/stdout (newline-delimited JSON)
// - **HTTP**: POST requests with SSE response support

import { spawn, ChildProcess } from "node:child_process";
import {
  parseMcpInitializeResponse,
  parseMcpToolsListResponse,
  parseMcpToolCallResponse,
  jsonRpcRequest,
  jsonRpcNotification,
  mcpToolCallRequest,
  mcpInitializeRequest,
} from "./types.ts";
import { logger } from "../../core/logger.ts";
import { formatError } from "../../core/error.ts";

/**
 * MCP error types.
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
 * Pending request tracker.
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
 */
export class McpClient {
  /**
   * Create a new client with a stdio transport.
   */
  static async forStdio(command: string, args: string[] = [], env: Record<string, string> = {}): Promise<McpClient> {
    const child: ChildProcess = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const client = new McpClient();
    (client as unknown as Record<string, unknown>)._child = child;
    (client as unknown as Record<string, unknown>)._writeStream = child.stdin;
    (client as unknown as Record<string, unknown>)._readStream = child.stdout;
    (client as unknown as Record<string, unknown>)._stderr = child.stderr;
    (client as unknown as Record<string, unknown>)._command = command;
    (client as unknown as Record<string, unknown>)._args = args;
    (client as unknown as Record<string, unknown>)._env = env;

    // Start reader
    client._startReader();
    client._startStderrReader();

    // Wait for child to be ready (it needs to start up)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new McpError(`MCP server '${command}' failed to start within 10s`)), 10000);
      child.on("spawn", () => { clearTimeout(timeout); resolve(); });
      child.on("error", (e: Error) => { clearTimeout(timeout); reject(new McpError(`Failed to spawn '${command}': ${e.message}`)); });
      // If spawn already happened
      if (child.pid !== undefined) { clearTimeout(timeout); resolve(); }
    });

    return client;
  }

  /**
   * Create a new client with an HTTP transport.
   */
  static async forHttp(url: string, headers: Record<string, string> = {}): Promise<McpClient> {
    const client = new McpClient();
    (client as unknown as Record<string, unknown>)._url = url;
    (client as unknown as Record<string, unknown>)._httpHeaders = headers;
    return client;
  }

  // Request ID counter
  #idCounter: number = 0;
  // Pending requests: id -> PendingRequest
  #pending: Map<number, PendingRequest> = new Map();
  // Buffered responses not yet matched
  #buffered: { id: number; result: unknown; error: unknown; raw: string }[] = [];
  // Server capabilities (filled after initialize)
  #serverCapabilities: unknown = null;
  #serverInfo: unknown = null;
  // Cancellation
  #cancelled: boolean = false;
  // Reader task references
  #readerTask: Promise<void> | null = null;
  #stderrTask: Promise<void> | null = null;
  // Stderr capture
  #stderrOutput: string = "";

  // ── Test-only accessors ─────────────────────────────────────────────────

  /** @internal Exposed for testing. */
  get idCounter(): number { return this.#idCounter; }

  /** @internal Exposed for testing. */
  get pending(): Map<number, PendingRequest> { return this.#pending; }

  /** @internal Exposed for testing. */
  get buffered(): { id: number; result: unknown; error: unknown; raw: string }[] { return this.#buffered; }

  /** @internal Exposed for testing. */
  get cancelled(): boolean { return this.#cancelled; }
  set cancelled(v: boolean) { this.#cancelled = v; }

  /** @internal Exposed for testing. */
  get stderrOutput(): string { return this.#stderrOutput; }
  set stderrOutput(v: string) { this.#stderrOutput = v; }

  // ── Stdio reader ────────────────────────────────────────────────────────

  private _startReader(): void {
    const readStream = (this as unknown as Record<string, unknown>)._readStream as NodeJS.ReadableStream | undefined;
    if (!readStream) return;

    let buffer = "";

    this.#readerTask = (async () => {
      try {
        for await (const chunk of readStream) {
          if (this.#cancelled) break;
          buffer += chunk.toString();

          // Process complete lines
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            await this._handleLine(line);
          }
        }
      } catch (e: unknown) {
        if (!this.#cancelled) {
          logger.error(`MCP reader error: ${formatError(e)}`);
        }
      }
    })();
  }

  private _startStderrReader(): void {
    const stderr = (this as unknown as Record<string, unknown>)._stderr as NodeJS.ReadableStream | undefined;
    if (!stderr) return;

    this.#stderrTask = (async () => {
      try {
        for await (const chunk of stderr) {
          this.#stderrOutput += chunk.toString();
        }
      } catch {
        // Ignore
      }
    })();
  }

  private async _handleLine(line: string): Promise<void> {
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
      // This is a response or notification with an ID
      if (msg.result !== undefined || msg.error !== undefined) {
        const pending = this.#pending.get(msg.id as number);
        if (pending) {
          this.#pending.delete(msg.id as number);
          if (msg.error) {
            const errMsg = (msg.error as Record<string, unknown>).message as string || `MCP error code ${(msg.error as Record<string, unknown>).code}`;
            const fullMsg = `${errMsg}\nRaw response: ${line}`;
            pending.reject?.(new McpError(fullMsg, (msg.error as Record<string, unknown>).code as number || -1));
          } else {
            pending.resolve?.(msg.result);
          }
        } else {
          // Buffer it in case it arrives before the request
          this.#buffered.push({ id: msg.id as number, result: msg.result, error: msg.error, raw: line });
        }
      }
    }
  }

  // ── Request dispatch ────────────────────────────────────────────────────

  private async _sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.#cancelled) {
      throw new McpError("Client is cancelled");
    }

    const id = ++this.#idCounter;
    const request = jsonRpcRequest(id, method, params);
    const serialized = JSON.stringify(request);

    // Check buffered responses first
    for (let i = 0; i < this.#buffered.length; i++) {
      const buf = this.#buffered[i];
      if (!buf) continue;
      if (buf.id === id) {
        this.#buffered.splice(i, 1);
        if (buf.error) {
          throw new McpError(
            (buf.error as Record<string, unknown>).message as string || `MCP error code ${(buf.error as Record<string, unknown>).code}`,
            (buf.error as Record<string, unknown>).code as number || -1,
          );
        }
        return buf.result;
      }
    }

    // HTTP mode: each request is independent
    const url = (this as unknown as Record<string, unknown>)._url as string | undefined;
    if (url) {
      return this._httpRequest(serialized);
    }

    // Stdio mode: use pending request mechanism
    const writeStream = (this as unknown as Record<string, unknown>)._writeStream as NodeJS.WritableStream | undefined;
    const pending = new PendingRequest(id);
    this.#pending.set(id, pending);

    // Send the request
    writeStream?.write(serialized + "\n");

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

  private async _httpRequest(serialized: string): Promise<unknown> {
    const httpHeaders = (this as Record<string, unknown>)._httpHeaders as Record<string, string> || {};
    const url = (this as Record<string, unknown>)._url as string;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...httpHeaders,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: serialized,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new McpError(`MCP HTTP error (${response.status}): ${body}`);
    }

    // Read response body as text and parse SSE format
    const body = await response.text();

    // Try direct JSON first (for servers that don't use SSE)
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      if (data.error) {
        const errMsg = (data.error as Record<string, unknown>).message as string || `MCP error code ${(data.error as Record<string, unknown>).code}`;
        throw new McpError(`${errMsg}\nRaw response: ${body}`, (data.error as Record<string, unknown>).code as number || -1);
      }
      return data.result;
    } catch {
      // Not direct JSON — try SSE parsing
    }

    // Parse SSE stream: "event: message\ndata: {json}\n\n"
    const messages = this._parseSse(body);
    if (messages.length === 0) {
      throw new McpError(`No SSE messages found in response: ${body.slice(0, 200)}`);
    }

    // For MCP requests, we expect exactly one response message
    // (though SSE can carry multiple events)
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || (lastMsg.result === undefined && lastMsg.error === undefined)) {
      throw new McpError(`No response message found in SSE: ${body.slice(0, 200)}`);
    }
    if (lastMsg.error) {
      const errMsg = (lastMsg.error as Record<string, unknown>).message as string || `MCP error code ${(lastMsg.error as Record<string, unknown>).code}`;
      throw new McpError(`${errMsg}\nRaw SSE: ${body}`, (lastMsg.error as Record<string, unknown>).code as number || -1);
    }

    return lastMsg.result;
  }

  /**
   * Parse SSE (Server-Sent Events) formatted text into JSON-RPC messages.
   * Handles the format: "event: message\ndata: {json}\n\n"
   */
  private _parseSse(text: string): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    const lines = text.split(/\r?\n/);
    let currentEvent = "message";
    let currentData = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      // Empty line signals end of an event
      if (line === "") {
        if (currentData.trim()) {
          try {
            const parsed = JSON.parse(currentData.trim()) as Record<string, unknown>;
            messages.push(parsed);
          } catch {
            // Skip unparseable SSE data
          }
        }
        currentEvent = "message";
        currentData = "";
        continue;
      }

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      }
      // Other lines (like "id:", etc.) are ignored
    }

    // Handle trailing data without final empty line
    if (currentData.trim()) {
      try {
        const parsed = JSON.parse(currentData.trim()) as Record<string, unknown>;
        messages.push(parsed);
      } catch {
        // Skip unparseable SSE data
      }
    }

    return messages;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Initialize the connection with the server.
   */
  async initialize(): Promise<unknown> {
    const result = await this._sendRequest("initialize", mcpInitializeRequest());
    const response = parseMcpInitializeResponse(result as Record<string, unknown>);

    this.#serverCapabilities = response.capabilities;
    this.#serverInfo = response.serverInfo;

    // Send initialized notification
    const writeStream = (this as Record<string, unknown>)._writeStream as NodeJS.WritableStream | undefined;
    if (writeStream) {
      const notification = jsonRpcNotification("notifications/initialized");
      writeStream.write(JSON.stringify(notification) + "\n");
    }

    return response;
  }

  /**
   * List available tools from the server.
   */
  async listTools(): Promise<unknown> {
    const result = await this._sendRequest("tools/list", {});
    return parseMcpToolsListResponse(result as Record<string, unknown>);
  }

  /**
   * Call a tool on the server.
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const result = await this._sendRequest("tools/call", mcpToolCallRequest(name, arguments_));
    return parseMcpToolCallResponse(result as Record<string, unknown>);
  }

  /**
   * Get server capabilities.
   */
  get serverCapabilities(): unknown {
    return this.#serverCapabilities;
  }

  /**
   * Get server info.
   */
  get serverInfo(): unknown {
    return this.#serverInfo;
  }

  /**
   * Shutdown the connection.
   */
  async shutdown(): Promise<void> {
    this.#cancelled = true;

    // Reject all pending requests
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) pending.reject(new McpError("Cancelled"));
    }

    // Kill the subprocess
    const child = (this as Record<string, unknown>)._child as ChildProcess | undefined;
    if (child && child.pid) {
      try {
        child.kill();
      } catch {
        // Ignore
      }
    }

    // Print stderr if any
    if (this.#stderrOutput && this.#stderrOutput.trim()) {
      logger.error(`MCP server stderr: ${this.#stderrOutput.trim()}`);
    }
  }
}
