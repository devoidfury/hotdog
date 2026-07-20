// WebSocketChannel — Channel implementation for WebSocket connections.
// Maps OutputEvent → S2CMessage protocol and sends JSON over WS.

import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import { OUTPUT_EVENT, OutputEvent, OutputEventType } from "../../core/context/output.ts";
import { S2C, S2CType } from "./protocol.ts";

// ── OUTPUT_EVENT → S2C mapping ──────────────────────────────────────────────

/**
 * Map OUTPUT_EVENT numeric types to S2C string message types.
 */
const EVENT_TO_PROTOCOL: Record<OutputEventType, S2CType> = {
  [OUTPUT_EVENT.USER_MESSAGE]: S2C.USER_MESSAGE,
  [OUTPUT_EVENT.ASSISTANT_MESSAGE]: S2C.ASSISTANT_MESSAGE,
  [OUTPUT_EVENT.THINKING]: S2C.THINKING,
  [OUTPUT_EVENT.TOOL_CALL]: S2C.TOOL_CALL,
  [OUTPUT_EVENT.TOOL_RESULT]: S2C.TOOL_RESULT,
  [OUTPUT_EVENT.COMPACTING]: S2C.COMPACTING,
  [OUTPUT_EVENT.COMMAND_RESULT]: S2C.COMMAND_RESULT,
  [OUTPUT_EVENT.QUESTION]: S2C.QUESTION,
  [OUTPUT_EVENT.STREAMING_CHUNK]: S2C.STREAMING_CHUNK,
  [OUTPUT_EVENT.STREAMING_REASONING_CHUNK]: S2C.STREAMING_REASONING_CHUNK,
  [OUTPUT_EVENT.TASK_PROGRESS]: S2C.TASK_PROGRESS,
  [OUTPUT_EVENT.TOKEN_USAGE]: S2C.TOKEN_USAGE,
  [OUTPUT_EVENT.COMPACTION_RESULT]: S2C.COMPACTION_RESULT,
  [OUTPUT_EVENT.SESSION_STATE]: S2C.SESSION_STATE,
};

// ── WebSocketChannel ────────────────────────────────────────────────────────

export interface WebSocketChannelOptions {
  sessionManager: ChannelSessionManager;
  ws: WebSocket;
  sessionId: string;
  broadcastCallback?: (msg: Record<string, unknown>) => void;
}

/**
 * Channel implementation for WebSocket connections.
 * Maps OutputEvent types to S2C protocol messages and sends JSON over WS.
 */
export class WebSocketChannel extends Channel {
  #ws: WebSocket;
  #sessionId: string;
  #ready: boolean;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;
  #unsubscribers: Map<string, () => void>;

  /**
   * @param options
   * @param options.sessionManager — SessionManager instance
   * @param options.ws — WebSocket connection
   * @param options.sessionId — Session ID to attach to
   * @param options.broadcastCallback — Optional callback to broadcast events to all clients
   */
  constructor(options: WebSocketChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#ws = options.ws;
    this.#sessionId = options.sessionId;
    this.#ready = true;
    this.#broadcastCallback = options.broadcastCallback;
    this.#unsubscribers = new Map();

    // Attach to the given session
    this.attach(options.sessionId);
  }

  // ── Abstract Protocol Methods ───────────────────────────────────────────

  /**
   * Format and deliver an event to the WebSocket connection.
   * Maps OutputEvent type to S2C protocol message.
   */
  protected write(event: OutputEvent): void {
    if (!this.#ready) return;

    const protoType = EVENT_TO_PROTOCOL[event.type];
    if (!protoType) return;

    // Build the protocol message from the event data
    const msg: Record<string, unknown> = { type: protoType, sessionId: this.#sessionId };

    // Copy relevant event fields into the message
    switch (event.type) {
      case OUTPUT_EVENT.USER_MESSAGE:
      case OUTPUT_EVENT.ASSISTANT_MESSAGE:
      case OUTPUT_EVENT.STREAMING_CHUNK:
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        msg.content = event.content;
        break;
      case OUTPUT_EVENT.THINKING:
        msg.content = event.content;
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        msg.name = event.toolName;
        msg.args = event.input;
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        msg.name = event.toolName;
        if (event.result !== undefined) msg.output = event.result;
        if (event.error !== undefined) msg.error = event.error;
        break;
      case OUTPUT_EVENT.COMPACTING:
        msg.message = event.message;
        break;
      case OUTPUT_EVENT.COMMAND_RESULT:
        msg.content = event.content;
        break;
      case OUTPUT_EVENT.QUESTION:
        msg.questions = event.questions;
        break;
      case OUTPUT_EVENT.TASK_PROGRESS:
        msg.taskId = event.taskId;
        msg.status = event.status;
        if (event.message !== undefined) msg.message = event.message;
        break;
      case OUTPUT_EVENT.TOKEN_USAGE:
        msg.promptTokens = event.promptTokens || 0;
        msg.completionTokens = event.completionTokens || 0;
        msg.totalTokens = event.totalTokens || 0;
        msg.lastPromptTokens = event.lastPromptTokens || 0;
        msg.lastCompletionTokens = event.lastCompletionTokens || 0;
        msg.lastTotalTokens = event.lastTotalTokens || 0;
        msg.lastCachedTokens = event.lastCachedTokens || 0;
        break;
      case OUTPUT_EVENT.COMPACTION_RESULT:
        msg.summary = event.summary;
        msg.messagesCompacted = event.messagesCompacted;
        break;
      case OUTPUT_EVENT.SESSION_STATE:
        msg.key = event.key;
        msg.value = event.value;
        // Also broadcast session state to all connected clients
        if (this.#broadcastCallback) {
          this.#broadcastCallback(msg);
        }
        break;
    }

    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      // WS connection closed — mark as disconnected
      this.#ready = false;
    }
  }

  /**
   * Read raw input from the WebSocket connection.
   * Yields parsed JSON message content strings.
   */
  async *read(): AsyncIterable<string> {
    // This is a placeholder — the WebSocket server handles messages
    // via onMessage() directly rather than through the read() iterator.
    // The read() method exists for API consistency but is not used
    // in the WebSocket flow (messages are dispatched via routeMessage).
    yield "";
  }

  /**
   * Wire session events to this channel via SessionManager subscription.
   */
  protected _subscribe(sessionId: string): void {
    const unsubscribe = this.sessionManager.onSessionEvents(sessionId, (event: OutputEvent) => {
      this.write(event);
    });
    this.#unsubscribers.set(sessionId, unsubscribe);
  }

  /**
   * Remove the wire from a session.
   */
  protected _unsubscribe(sessionId: string): void {
    const unsubscribe = this.#unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.#unsubscribers.delete(sessionId);
    }
  }

  /**
   * Release connection resources on close.
   */
  protected _cleanup(): void {
    this.#ready = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a message directly to the WebSocket client.
   * @param msg — Message object to send as JSON
   */
  sendJson(msg: Record<string, unknown>): void {
    if (!this.#ready) return;
    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      this.#ready = false;
    }
  }

  /**
   * Get the WebSocket connection.
   */
  get ws(): WebSocket {
    return this.#ws;
  }

  /**
   * Check if the connection is ready.
   */
  get isReady(): boolean {
    return this.#ready;
  }

  /**
   * Get the session ID.
   */
  get sessionId(): string {
    return this.#sessionId;
  }
}
