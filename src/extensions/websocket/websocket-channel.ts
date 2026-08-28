// Maps OutputEvent → S2C wire protocol and sends JSON over WS.

import { Channel, ChannelSessionManager } from "../../core/channel.ts";
import {
  OUTPUT_EVENT,
  OutputEvent,
  OutputEventType,
} from "../../core/context/output.ts";
import { S2C, S2CType } from "./protocol.ts";
import type { HotdogServerSocket } from "./server.ts";

// ── OUTPUT_EVENT → S2C mapping ──────────────────────────────────────────────

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
  [OUTPUT_EVENT.SYSTEM_MESSAGE]: S2C.SYSTEM_MESSAGE,
};

export interface WebSocketChannelOptions {
  sessionManager: ChannelSessionManager;
  ws: HotdogServerSocket<unknown>;
  sessionId: string;
  broadcastCallback?: (msg: Record<string, unknown>) => void;
}

export class WebSocketChannel extends Channel {
  #ws: HotdogServerSocket<unknown>;
  #sessionId: string;
  #ready: boolean;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;
  #unsubscribers: Map<string, () => void>;

  constructor(options: WebSocketChannelOptions) {
    super({ sessionManager: options.sessionManager });
    this.#ws = options.ws;
    this.#sessionId = options.sessionId;
    this.#ready = true;
    this.#broadcastCallback = options.broadcastCallback;
    this.#unsubscribers = new Map();

    this.attach(options.sessionId);

    // Drain and replay any questions that were emitted while no channels were connected
    this.#replayPendingQuestions();
  }

  protected write(event: OutputEvent): void {
    if (!this.#ready) return;

    const protoType = EVENT_TO_PROTOCOL[event.type];
    if (!protoType) return;

    const msg: Record<string, unknown> = {
      type: protoType,
      sessionId: this.#sessionId,
    };

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
        msg.sessionPromptTokens = event.sessionPromptTokens || 0;
        msg.sessionCompletionTokens = event.sessionCompletionTokens || 0;
        msg.sessionTotalTokens = event.sessionTotalTokens || 0;
        msg.promptTokens = event.promptTokens || 0;
        msg.completionTokens = event.completionTokens || 0;
        msg.totalTokens = event.totalTokens || 0;
        msg.cachedTokens = event.cachedTokens || 0;
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
      // Socket closed or send failed — stop writing to it
      this.#ready = false;
    }
  }

  async *read(): AsyncIterable<string> {
    // Placeholder: messages are dispatched via routeMessage, not this iterator.
    yield "";
  }

  protected _subscribe(sessionId: string): void {
    const unsubscribe = this.sessionManager.onSessionEvents(
      sessionId,
      (event: OutputEvent) => {
        this.write(event);
      },
    );
    this.#unsubscribers.set(sessionId, unsubscribe);
  }

  protected _unsubscribe(sessionId: string): void {
    const unsubscribe = this.#unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.#unsubscribers.delete(sessionId);
    }
  }

  protected _cleanup(): void {
    this.#ready = false;
  }

  /** Replay QUESTION events buffered while no channels were connected. */
  #replayPendingQuestions(): void {
    const pending = this.sessionManager.drainPendingQuestions(this.#sessionId);
    for (const questions of pending) {
      this.write({
        type: OUTPUT_EVENT.QUESTION,
        questions,
      });
    }
  }

  sendJson(msg: Record<string, unknown>): void {
    if (!this.#ready) return;
    try {
      this.#ws.send(JSON.stringify(msg));
    } catch {
      this.#ready = false;
    }
  }

  get ws() {
    return this.#ws;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get sessionId(): string {
    return this.#sessionId;
  }
}
