import { OUTPUT_EVENT, OutputEvent, OutputEventType } from "../../core/context/output.ts";
import { S2C, S2CType } from "./protocol.ts";
import { logger } from "../../core/logger.ts";
import { formatError } from "../../core/error.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface Sink {
  emit(event: OutputEvent): void;
}

// ── FanoutSink ──────────────────────────────────────────────────────────────

/**
 * Distributes output events to multiple sinks.
 * No-op base class that just forwards — doesn't extend OutputSink to avoid
 * coupling to the base class's stream behavior.
 */
export class FanoutSink {
  #sinks: Sink[] = [];

  add(sink: Sink): void {
    this.#sinks.push(sink);
  }

  remove(sink: Sink): void {
    this.#sinks = this.#sinks.filter((s) => s !== sink);
  }

  emit(event: OutputEvent): void {
    for (const s of this.#sinks) {
      try {
        s.emit(event);
      } catch (e) {
        // Sink errors are non-fatal — log and continue
        logger.error(formatError(e));
      }
    }
  }

  get size(): number {
    return this.#sinks.length;
  }
}

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

// ── WebSocketOutputSink ─────────────────────────────────────────────────────

/**
 * Sends agent output events to a WebSocket connection.
 * Maps each OUTPUT_EVENT type to a protocol message type.
 */
export class WebSocketOutputSink {
  #ws: WebSocket;
  #sessionId: string;
  #ready: boolean;

  /**
   * @param ws - Bun WebSocket instance
   * @param sessionId - Session ID to include in each message
   */
  constructor(ws: WebSocket, sessionId: string) {
    this.#ws = ws;
    this.#sessionId = sessionId;
    this.#ready = true;
  }

  /** Mark this sink as disconnected — stop sending. */
  disconnect(): void {
    this.#ready = false;
  }

  /** Reconnect with a new WS instance. */
  reconnect(ws: WebSocket): void {
    this.#ws = ws;
    this.#ready = true;
  }

  emit(event: OutputEvent): void {
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
        // Agent emits `result`, not `output` — map it to `output` for the client
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
        break;
    }

    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      // WS connection closed — mark as disconnected
      this.#ready = false;
    }
  }
}

// ── BackgroundSink ──────────────────────────────────────────────────────────

/**
 * Silent sink for sessions with no connected clients.
 * Silently drops streaming chunks (no one to show them to).
 * Logs QUESTION events so they can be surfaced when a client reconnects.
 * All other events: no-op (persistence handled by session-log extension)
 */
export class BackgroundSink {
  #pendingQuestions: unknown[][] = [];

  emit(event: OutputEvent): void {
    switch (event.type) {
      case OUTPUT_EVENT.STREAMING_CHUNK:
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        // Drop silently — no client to stream to
        break;
      case OUTPUT_EVENT.QUESTION:
        // Buffer questions so they can be replayed when a client connects
        this.#pendingQuestions.push(event.questions as unknown[][]);
        break;
      default:
        // All other events: no-op (persistence handled by session-log extension)
        break;
    }
  }

  /** Get pending questions and clear the buffer. */
  drainPendingQuestions(): unknown[][] {
    const qs = this.#pendingQuestions;
    this.#pendingQuestions = [];
    return qs;
  }
}
