import { spawn, ChildProcess } from "node:child_process";
import { logger } from "@core/logger.ts";
import { formatError } from "@core/error.ts";
import { copyScrubbedEnv } from "@utils/env.ts";
import { OWN_PROCESS_GROUP, killProcessGroup } from "@utils/process-group.ts";
import { hotdogFetch } from "@utils/fetch.ts";
import { McpError } from "./client.ts";

export type TransportMessageHandler = (line: string) => void;

/** Callback invoked when a transport closes (expected or unexpected). */
export type TransportCloseHandler = () => void;

export interface McpTransport {
  /**
   * Send a serialized JSON-RPC message.
   * @returns HTTP transports return the parsed result; stdio returns undefined (responses come via onMessage).
   */
  send(serialized: string): Promise<unknown | undefined>;

  /** Register a handler for incoming message lines (stdio only; no-op for HTTP). Returns a cleanup function. */
  onMessage(handler: TransportMessageHandler): () => void;

  /** Register a handler for close events. Returns a cleanup function. */
  onClose(handler: TransportCloseHandler): () => void;

  /** Send a notification (fire-and-forget). */
  sendNotification(serialized: string): void;

  destroy(): Promise<void>;

  /** True for streaming transports (stdio): responses arrive via onMessage. HTTP returns results from send() instead. */
  readonly isStreaming: boolean;
}

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
  #stderrOutput: string = "";
  #destroyed: boolean = false;

  constructor(command: string, args: string[] = [], env: Record<string, string> = {}) {
    this.#command = command;
    this.#args = args;
    this.#env = env;

    // Own process group on POSIX so destroy() can kill the whole tree.
    // An MCP server that spawns workers could otherwise leak them.
    this.#child = spawn(command, args, {
      ...OWN_PROCESS_GROUP,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...copyScrubbedEnv(), ...env },
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

    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* ignore */ }
    }

    // Group kill on POSIX: workers spawned by the MCP server die with it.
    // Falls back to the direct child on Windows (no process groups).
    killProcessGroup(this.#child, "SIGTERM");

    if (this.#stderrOutput && this.#stderrOutput.trim()) {
      logger.error(`MCP server stderr: ${this.#stderrOutput.trim()}`);
    }
  }

  #startReader(): void {
    const readStream = this.#readStream;
    if (!readStream) return;
    let buffer = "";

    readStream.on("data", (chunk: Buffer) => {
      if (this.#destroyed) return;
      buffer += chunk.toString();

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        this.#dispatchMessage(line);
      }
    });

    readStream.on("error", (e: Error) => {
      if (!this.#destroyed) {
        logger.error(`MCP stdio reader error: ${formatError(e)}`);
      }
    });
  }

  #startStderrReader(): void {
    const stderr = this.#stderr;
    if (!stderr) return;

    stderr.on("data", (chunk: Buffer) => {
      this.#stderrOutput += chunk.toString();
    });
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

    const response = await hotdogFetch(this.#url, {
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
    // HTTP MCP servers don't take notifications
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* ignore */ }
    }
  }

  #parseResponse(body: string): unknown {
    // Try direct JSON first (some servers don't use SSE)
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
      if (e instanceof McpError) throw e;
    }

    // Parse SSE stream: "event: message\ndata: {json}\n\n"
    const messages = this.#parseSse(body);
    if (messages.length === 0) {
      throw new McpError(`No SSE messages found in response: ${body.slice(0, 200)}`);
    }

    // MCP responses may be interleaved with keep-alives; take the last message
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
    let currentData = "";

    for (const line of lines) {
      // Empty line signals end of an SSE event
      if (line === "") {
        if (currentData.trim()) {
          try {
            messages.push(JSON.parse(currentData.trim()) as Record<string, unknown>);
          } catch {
            // Malformed data field; skip
          }
        }
        currentData = "";
        continue;
      }

      if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      }
      // Other SSE fields (event:, id:, retry:) are ignored
    }

    // Handle trailing data without final empty line
    if (currentData.trim()) {
      try {
        messages.push(JSON.parse(currentData.trim()) as Record<string, unknown>);
      } catch {
        // Malformed data field; skip
      }
    }

    return messages;
  }
}
