// MCP client with stdio and HTTP transports.
// Handles JSON-RPC message exchange over:
// - **Stdio**: subprocess stdin/stdout (newline-delimited JSON)
// - **HTTP**: POST requests with SSE response support

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { parseMcpInitializeResponse, parseMcpToolsListResponse, parseMcpToolCallResponse, contentBlocksToString, jsonRpcRequest, jsonRpcNotification, mcpToolCallRequest } from "./types.js";

/**
 * MCP error types.
 */
export class McpError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/**
 * Pending request tracker.
 */
class PendingRequest {
  constructor(id) {
    this.id = id;
    this.resolve = null;
    this.reject = null;
    this.timer = null;
  }
}

/**
 * MCP client that manages JSON-RPC communication with an MCP server.
 */
export class McpClient {
  /**
   * Create a new client with a stdio transport.
   */
  static async forStdio(command, args = [], env = {}) {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const client = new McpClient();
    client._child = child;
    client._writeStream = child.stdin;
    client._readStream = child.stdout;
    client._stderr = child.stderr;
    client._command = command;
    client._args = args;
    client._env = env;

    // Start reader
    client._startReader();
    client._startStderrReader();

    // Wait for child to be ready (it needs to start up)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new McpError(`MCP server '${command}' failed to start within 10s`)), 10000);
      child.on("spawn", () => { clearTimeout(timeout); resolve(); });
      child.on("error", (e) => { clearTimeout(timeout); reject(new McpError(`Failed to spawn '${command}': ${e.message}`)); });
      // If spawn already happened
      if (child.pid !== undefined) { clearTimeout(timeout); resolve(); }
    });

    return client;
  }

  /**
   * Create a new client with an HTTP transport.
   */
  static async forHttp(url, headers = {}) {
    const client = new McpClient();
    client._url = url;
    client._httpHeaders = headers;
    return client;
  }

  constructor() {
    // Request ID counter
    this._idCounter = 0;
    // Pending requests: id -> PendingRequest
    this._pending = new Map();
    // Buffered responses not yet matched
    this._buffered = [];
    // Server capabilities (filled after initialize)
    this._serverCapabilities = null;
    this._serverInfo = null;
    // Cancellation
    this._cancelled = false;
    // Reader task references
    this._readerTask = null;
    this._stderrTask = null;
    // Stderr capture
    this._stderrOutput = "";
  }

  // ── Stdio reader ────────────────────────────────────────────────────────

  _startReader() {
    if (!this._readStream) return;

    const readStream = this._readStream;
    let buffer = "";

    this._readerTask = (async () => {
      try {
        for await (const chunk of readStream) {
          if (this._cancelled) break;
          buffer += chunk.toString();

          // Process complete lines
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            await this._handleLine(line);
          }
        }
      } catch (e) {
        if (!this._cancelled) {
          console.error(`MCP reader error: ${e.message}`);
        }
      }
    })();
  }

  _startStderrReader() {
    if (!this._stderr) return;

    const stderr = this._stderr;
    this._stderrTask = (async () => {
      try {
        for await (const chunk of stderr) {
          this._stderrOutput += chunk.toString();
        }
      } catch {
        // Ignore
      }
    })();
  }

  async _handleLine(line) {
    line = line.trim();
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip unparseable lines
    }

    // Check if this is a response
    if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
      // This is a response or notification with an ID
      if (msg.result !== undefined || msg.error !== undefined) {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          if (msg.error) {
            const errMsg = msg.error.message || `MCP error code ${msg.error.code}`;
            const fullMsg = `${errMsg}\nRaw response: ${line}`;
            pending.reject(new McpError(fullMsg, msg.error.code || -1));
          } else {
            pending.resolve(msg.result);
          }
        } else {
          // Buffer it in case it arrives before the request
          this._buffered.push({ id: msg.id, result: msg.result, error: msg.error, raw: line });
        }
      }
    }
  }

  // ── Request dispatch ────────────────────────────────────────────────────

  async _sendRequest(method, params) {
    if (this._cancelled) {
      throw new McpError("Client is cancelled");
    }

    const id = ++this._idCounter;
    const request = jsonRpcRequest(id, method, params);
    const serialized = JSON.stringify(request);

    // Check buffered responses first
    for (let i = 0; i < this._buffered.length; i++) {
      const buf = this._buffered[i];
      if (buf.id === id) {
        this._buffered.splice(i, 1);
        if (buf.error) {
          throw new McpError(buf.error.message || `MCP error code ${buf.error.code}`, buf.error.code || -1);
        }
        return buf.result;
      }
    }

    // HTTP mode: each request is independent
    if (this._url) {
      return this._httpRequest(serialized);
    }

    // Stdio mode: use pending request mechanism
    const pending = new PendingRequest(id);
    this._pending.set(id, pending);

    // Send the request
    this._writeStream.write(serialized + "\n");

    // Wait for response or timeout
    const result = await new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new McpError("Timeout waiting for response"));
      }, 30000);
    });

    // Clean up
    this._pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    return result;
  }

  async _httpRequest(serialized) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this._httpHeaders,
    };

    const response = await fetch(this._url, {
      method: "POST",
      headers,
      body: serialized,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new McpError(`MCP HTTP error (${response.status}): ${body}`);
    }

    // For HTTP transport, we read the response body directly
    // (no SSE streaming for now, as MCP over HTTP uses direct JSON responses)
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new McpError(`Invalid JSON response from MCP server: ${body.slice(0, 200)}`);
    }

    if (data.error) {
      const errMsg = data.error.message || `MCP error code ${data.error.code}`;
      throw new McpError(`${errMsg}\nRaw response: ${body}`, data.error.code || -1);
    }

    return data.result;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Initialize the connection with the server.
   */
  async initialize() {
    const result = await this._sendRequest("initialize", mcpInitializeRequest());
    const response = parseMcpInitializeResponse(result);

    this._serverCapabilities = response.capabilities;
    this._serverInfo = response.serverInfo;

    // Send initialized notification
    if (this._writeStream) {
      const notification = jsonRpcNotification("notifications/initialized");
      this._writeStream.write(JSON.stringify(notification) + "\n");
    }

    return response;
  }

  /**
   * List available tools from the server.
   */
  async listTools() {
    const result = await this._sendRequest("tools/list", {});
    return parseMcpToolsListResponse(result);
  }

  /**
   * Call a tool on the server.
   */
  async callTool(name, arguments_) {
    const result = await this._sendRequest("tools/call", mcpToolCallRequest(name, arguments_));
    return parseMcpToolCallResponse(result);
  }

  /**
   * Get server capabilities.
   */
  get serverCapabilities() {
    return this._serverCapabilities;
  }

  /**
   * Get server info.
   */
  get serverInfo() {
    return this._serverInfo;
  }

  /**
   * Shutdown the connection.
   */
  async shutdown() {
    this._cancelled = true;

    // Reject all pending requests
    for (const [id, pending] of this._pending) {
      this._pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.reject) pending.reject(new McpError("Cancelled"));
    }

    // Kill the subprocess
    if (this._child && this._child.pid) {
      try {
        this._child.kill();
      } catch {
        // Ignore
      }
    }

    // Print stderr if any
    if (this._stderrOutput && this._stderrOutput.trim()) {
      console.error(`MCP server stderr: ${this._stderrOutput.trim()}`);
    }
  }
}

