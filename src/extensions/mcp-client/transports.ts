// MCP transport layer — abstracts stdio and HTTP communication.
// Transports handle low-level message sending/receiving; McpClient handles
// JSON-RPC protocol logic on top.

import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../../core/logger.ts";
import { formatError } from "../../core/error.ts";
import { McpError } from "./client.ts";
import { jsonRpcNotification } from "./types.ts";

/**
 * Callback invoked when a transport receives a message line.
 */
export type TransportMessageHandler = (line: string) => void;

/**
 * Callback invoked when a transport closes unexpectedly.
 */
export type TransportCloseHandler = () => void;

/**
 * Abstract transport interface for MCP communication.
 * Implementations handle the low-level I/O (stdio or HTTP);
 * McpClient uses this to send requests and receive responses.
 */
export interface McpTransport {
  /**
   * Send a serialized JSON-RPC message to the server.
   * For stdio: writes to stdin.
   * For HTTP: performs a POST request and returns the response result.
   * @param serialized - JSON-stringified JSON-RPC message
   * @returns For HTTP transport: the parsed result. For stdio: undefined (responses come via onMessage).
   */
  send(serialized: string): Promise<unknown | undefined>;

  /**
   * Register a handler for incoming message lines.
   * For stdio: called for each newline-delimited JSON line from stdout.
   * For HTTP: not used (responses come synchronously via send()).
   * @param handler - Callback invoked with each message line
   * @returns Cleanup function to remove the handler
   */
  onMessage(handler: TransportMessageHandler): () => void;

  /**
   * Register a handler for unexpected close events.
   * @param handler - Callback invoked when transport closes
   * @returns Cleanup function to remove the handler
   */
  onClose(handler: TransportCloseHandler): () => void;

  /**
   * Send a notification (fire-and-forget, no response expected).
   * For stdio: writes to stdin.
   * For HTTP: not typically used.
   * @param serialized - JSON-stringified JSON-RPC notification
   */
  sendNotification(serialized: string): void;

  /**
   * Gracefully shutdown the transport.
   */
  destroy(): Promise<void>;

  /**
   * Whether this is a streaming transport (stdio) vs request/response (HTTP).
   * Streaming transports deliver responses via onMessage callbacks.
   * Request/response transports return results directly from send().
   */
  readonly isStreaming: boolean;
}

// ── Stdio Transport ─────────────────────────────────────────────────────────

/**
 * Stdio transport — communicates with an MCP server via subprocess stdin/stdout.
 * Uses newline-delimited JSON over pipes.
 */
export class StdioTransport implements McpTransport {
  readonly isStreaming = true;

  readonly #child: ChildProcess;
  readonly #writeStream: NodeJS.WritableStream | null;
  readonly #readStream: NodeJS.ReadableStream | null;
  readonly #stderr: NodeJS.ReadableStream | null;
  readonly #command: string;
  readonly #args: string[];
  readonly #env: Record<string, string>;

  #messageHandlers: TransportMessageHandler[] = [];
  #closeHandlers: TransportCloseHandler[] = [];
  #readerTask: Promise<void> | null = null;
  #stderrTask: Promise<void> | null = null;
  #stderrOutput: string = "";
  #destroyed: boolean = false;

  constructor(command: string, args: string[] = [], env: Record<string, string> = {}) {
    this.#command = command;
    this.#args = args;
    this.#env = env;

    this.#child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.#writeStream = this.#child.stdin;
    this.#readStream = this.#child.stdout;
    this.#stderr = this.#child.stderr;

    this.#startReader();
    this.#startStderrReader();
  }

  /** @internal Exposed for testing. */
  get command(): string { return this.#command; }

  /** @internal Exposed for testing. */
  get args(): string[] { return this.#args; }

  /** @internal Exposed for testing. */
  get env(): Record<string, string> { return this.#env; }

  /** @internal Exposed for testing. */
  get stderrOutput(): string { return this.#stderrOutput; }

  /** @internal Exposed for testing. */
  get child(): ChildProcess { return this.#child; }

  async send(serialized: string): Promise<undefined> {
    if (this.#destroyed) {
      throw new McpError("Transport is destroyed");
    }
    if (!this.#writeStream) {
      throw new McpError("Write stream not available");
    }
    this.#writeStream.write(serialized + "\n");
    return undefined;
  }

  onMessage(handler: TransportMessageHandler): () => void {
    this.#messageHandlers.push(handler);
    return () => {
      const idx = this.#messageHandlers.indexOf(handler);
      if (idx !== -1) this.#messageHandlers.splice(idx, 1);
    };
  }

  onClose(handler: TransportCloseHandler): () => void {
    this.#closeHandlers.push(handler);
    return () => {
      const idx = this.#closeHandlers.indexOf(handler);
      if (idx !== -1) this.#closeHandlers.splice(idx, 1);
    };
  }

  sendNotification(serialized: string): void {
    if (!this.#destroyed && this.#writeStream) {
      this.#writeStream.write(serialized + "\n");
    }
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    // Notify close handlers
    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* ignore */ }
    }

    // Kill the subprocess
    if (this.#child.pid) {
      try {
        this.#child.kill();
      } catch {
        // Ignore
      }
    }

    // Print stderr if any
    if (this.#stderrOutput && this.#stderrOutput.trim()) {
      logger.error(`MCP server stderr: ${this.#stderrOutput.trim()}`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  #startReader(): void {
    const readStream = this.#readStream;
    if (!readStream) return;
    let buffer = "";

    this.#readerTask = (async () => {
      try {
        for await (const chunk of readStream) {
          if (this.#destroyed) break;
          buffer += chunk.toString();

          // Process complete lines
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            this.#dispatchMessage(line);
          }
        }
      } catch (e: unknown) {
        if (!this.#destroyed) {
          logger.error(`MCP stdio reader error: ${formatError(e)}`);
        }
      }
    })();
  }

  #startStderrReader(): void {
    const stderr = this.#stderr;
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

  #dispatchMessage(line: string): void {
    line = line.trim();
    if (!line) return;

    for (const handler of this.#messageHandlers) {
      try {
        handler(line);
      } catch (e: unknown) {
        logger.error(`MCP message handler error: ${formatError(e)}`);
      }
    }
  }
}

// ── HTTP Transport ──────────────────────────────────────────────────────────

/**
 * HTTP transport — communicates with an MCP server via HTTP POST with SSE support.
 * Each request is independent; responses come directly from send().
 */
export class HttpTransport implements McpTransport {
  readonly isStreaming = false;

  readonly #url: string;
  readonly #headers: Record<string, string>;
  #closeHandlers: TransportCloseHandler[] = [];
  #destroyed: boolean = false;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.#url = url;
    this.#headers = headers;
  }

  /** @internal Exposed for testing. */
  get url(): string { return this.#url; }

  /** @internal Exposed for testing. */
  get headers(): Record<string, string> { return this.#headers; }

  async send(serialized: string): Promise<unknown> {
    if (this.#destroyed) {
      throw new McpError("Transport is destroyed");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.#headers,
    };

    const response = await fetch(this.#url, {
      method: "POST",
      headers,
      body: serialized,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new McpError(`MCP HTTP error (${response.status}): ${body}`);
    }

    const body = await response.text();
    return this.#parseResponse(body);
  }

  onMessage(_handler: TransportMessageHandler): () => void {
    // Not used for HTTP transport — responses come via send()
    return () => {};
  }

  onClose(handler: TransportCloseHandler): () => void {
    this.#closeHandlers.push(handler);
    return () => {
      const idx = this.#closeHandlers.indexOf(handler);
      if (idx !== -1) this.#closeHandlers.splice(idx, 1);
    };
  }

  sendNotification(_serialized: string): void {
    // Notifications not typically used over HTTP MCP
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* ignore */ }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  #parseResponse(body: string): unknown {
    // Try direct JSON first (for servers that don't use SSE)
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      if (data.error) {
        const errMsg = (data.error as Record<string, unknown>).message as string ||
          `MCP error code ${(data.error as Record<string, unknown>).code}`;
        throw new McpError(
          `${errMsg}\nRaw response: ${body}`,
          (data.error as Record<string, unknown>).code as number || -1,
        );
      }
      return data.result;
    } catch (e) {
      // If it's our McpError, rethrow
      if (e instanceof McpError) throw e;
      // Not direct JSON — try SSE parsing
    }

    // Parse SSE stream: "event: message\ndata: {json}\n\n"
    const messages = this.#parseSse(body);
    if (messages.length === 0) {
      throw new McpError(`No SSE messages found in response: ${body.slice(0, 200)}`);
    }

    // For MCP requests, we expect exactly one response message
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || (lastMsg.result === undefined && lastMsg.error === undefined)) {
      throw new McpError(`No response message found in SSE: ${body.slice(0, 200)}`);
    }
    if (lastMsg.error) {
      const errMsg = (lastMsg.error as Record<string, unknown>).message as string ||
        `MCP error code ${(lastMsg.error as Record<string, unknown>).code}`;
      throw new McpError(
        `${errMsg}\nRaw SSE: ${body}`,
        (lastMsg.error as Record<string, unknown>).code as number || -1,
      );
    }

    return lastMsg.result;
  }

  #parseSse(text: string): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    const lines = text.split(/\r?\n/);
    let currentEvent = "message";
    let currentData = "";

    for (const line of lines) {
      // Empty line signals end of an event
      if (line === "") {
        if (currentData.trim()) {
          try {
            messages.push(JSON.parse(currentData.trim()) as Record<string, unknown>);
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
        messages.push(JSON.parse(currentData.trim()) as Record<string, unknown>);
      } catch {
        // Skip unparseable SSE data
      }
    }

    return messages;
  }
}
