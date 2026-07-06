// Output events and the Output trait for emitting agent output.

// Output event types
export const OUTPUT_EVENT = {
  USER_MESSAGE: 1,
  ASSISTANT_MESSAGE: 2,
  THINKING: 3,
  TOOL_CALL: 4,
  TOOL_RESULT: 5,
  COMPACTING: 6,
  COMMAND_RESULT: 7,
  QUESTION: 8,
  STREAMING_CHUNK: 9,
  STREAMING_REASONING_CHUNK: 10,
  TASK_PROGRESS: 11,
  TOKEN_USAGE: 12,
  COMPACTION_RESULT: 13,
  SESSION_STATE: 14,
};

/**
 * Map output event types to handler method names.
 */
export const EVENT_HANDLERS = {
  [OUTPUT_EVENT.USER_MESSAGE]: 'emitUserMessage',
  [OUTPUT_EVENT.ASSISTANT_MESSAGE]: 'emitAssistantMessage',
  [OUTPUT_EVENT.THINKING]: 'emitThinking',
  [OUTPUT_EVENT.TOOL_CALL]: 'emitToolCall',
  [OUTPUT_EVENT.TOOL_RESULT]: 'emitToolResult',
  [OUTPUT_EVENT.COMPACTING]: 'emitCompacting',
  [OUTPUT_EVENT.COMMAND_RESULT]: 'emitCommandResult',
  [OUTPUT_EVENT.QUESTION]: 'emitQuestion',
  [OUTPUT_EVENT.STREAMING_CHUNK]: 'emitStreamingChunk',
  [OUTPUT_EVENT.STREAMING_REASONING_CHUNK]: 'emitStreamingReasoningChunk',
  [OUTPUT_EVENT.TASK_PROGRESS]: 'emitTaskProgress',
  [OUTPUT_EVENT.TOKEN_USAGE]: 'emitTokenUsage',
  [OUTPUT_EVENT.COMPACTION_RESULT]: 'emitCompactionResult',
  [OUTPUT_EVENT.SESSION_STATE]: 'emitSessionState',
};

/**
 * Create an output event.
 *
 * @param {number} type - Event type constant.
 * @param {Object} [data] - Event data payload.
 * @returns {{type: number, ...data}} Output event object.
 */
export function outputEvent(type, data = {}) {
  return { type, ...data };
}

/**
 * Output trait implementation for CLI.
 * The Agent only depends on this interface, never on a specific UI.
 */
export class OutputSink {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.stream=true] - Enable streaming output
   */
  constructor(options = {}) {
    this.stream = options.stream !== false;
  }

  /**
   * Emit an output event.
   * @param {Object} event - Output event object.
   */
  emit(event) {
    const handler = EVENT_HANDLERS[event.type];
    if (handler) this[handler](event);
  }

  /**
   * Emit user message event.
   * @param {Object} event - Event with content field.
   */
  emitUserMessage(event) {
    // User messages are typically echoed back
  }

  /**
   * Emit assistant message event.
   * @param {Object} event - Event with content field.
   */
  emitAssistantMessage(event) {
    process.stdout.write(event.content);
  }

  /**
   * Emit thinking event.
   * @param {Object} event - Event with content field.
   */
  emitThinking(event) {
    process.stderr.write(event.content);
  }

  /**
   * Emit tool call event.
   * @param {Object} event - Event with tool call details.
   */
  emitToolCall(event) {
    // Tool calls are displayed by the agent loop
  }

  /**
   * Emit tool result event.
   * @param {Object} event - Event with tool result details.
   */
  emitToolResult(event) {
    // Tool results are displayed by the agent loop
  }

  /**
   * Emit compacting event.
   * @param {Object} event - Event with compacting details.
   */
  emitCompacting(event) {
    // Compacting is displayed by the agent loop
  }

  /**
   * Emit compaction result event.
   * @param {Object} event - Event with compaction result details.
   */
  emitCompactionResult(event) {
    // Compaction result is displayed by the agent loop
  }

  /**
   * Emit session state event.
   * @param {Object} event - Event with state change details.
   */
  emitSessionState(event) {
    // Session state changes (e.g., hideTools toggle) — no-op in base class
    // Subclasses can override to react to state changes
  }

  /**
   * Emit command result event.
   * @param {Object} event - Event with command result details.
   */
  emitCommandResult(event) {
    process.stdout.write(event.content + "\n");
  }

  /**
   * Emit question event.
   * @param {Object} event - Event with question details.
   */
  emitQuestion(event) {
    // Questions are handled by the agent loop
  }

  /**
   * Emit streaming chunk event.
   * @param {Object} event - Event with streaming content.
   */
  emitStreamingChunk(event) {
    if (this.stream) {
      process.stdout.write(event.content);
    }
  }

  /**
   * Emit streaming reasoning chunk event.
   * @param {Object} event - Event with reasoning content.
   */
  emitStreamingReasoningChunk(event) {
    if (this.stream) {
      process.stderr.write(event.content);
    }
  }

  /**
   * Emit task progress event.
   * @param {Object} event - Event with task progress details.
   */
  emitTaskProgress(event) {
    // Task progress is displayed by the agent loop
  }

  /**
   * Emit token usage event.
   * @param {Object} event - Event with token usage details.
   */
  emitTokenUsage(event) {
    // Token usage is displayed by the agent loop
  }

  /**
   * Reset the output sink.
   */
  reset() {}
}

/**
 * No-op output sink that silently discards all events.
 */
export class NoopSink {
  /**
   * Emit event (silently ignored).
   * @param {Object} _event - Output event object (unused).
   */
  emit(_event) {}
}
