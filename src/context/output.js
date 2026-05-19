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
};

/**
 * Create an output event.
 */
export function outputEvent(type, data = {}) {
  return { type, ...data };
}

/**
 * Output trait implementation for CLI.
 * The Agent only depends on this interface, never on a specific UI.
 */
export class OutputSink {
  constructor(options = {}) {
    this.stream = options.stream !== false;
  }

  emit(event) {
    const handler = EVENT_HANDLERS[event.type];
    if (handler) this[handler](event);
  }

  emitUserMessage(event) {
    // User messages are typically echoed back
  }

  emitAssistantMessage(event) {
    process.stdout.write(event.content);
  }

  emitThinking(event) {
    process.stderr.write(event.content);
  }

  emitToolCall(event) {
    // Tool calls are displayed by the agent loop
  }

  emitToolResult(event) {
    // Tool results are displayed by the agent loop
  }

  emitCompacting(event) {
    // Compacting is displayed by the agent loop
  }

  emitCompactionResult(event) {
    // Compaction result is displayed by the agent loop
  }

  emitCommandResult(event) {
    process.stdout.write(event.content + "\n");
  }

  emitQuestion(event) {
    // Questions are handled by the agent loop
  }

  emitStreamingChunk(event) {
    if (this.stream) {
      process.stdout.write(event.content);
    }
  }

  emitStreamingReasoningChunk(event) {
    if (this.stream) {
      process.stderr.write(event.content);
    }
  }

  emitTaskProgress(event) {
    // Task progress is displayed by the agent loop
  }

  emitTokenUsage(event) {
    // Token usage is displayed by the agent loop
  }

  reset() {}
}

/**
 * No-op output sink that silently discards all events.
 */
export class NoopSink {
  emit(_event) {}
}
