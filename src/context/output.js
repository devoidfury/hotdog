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
    switch (event.type) {
      case OUTPUT_EVENT.USER_MESSAGE:
        this.emitUserMessage(event.content);
        break;
      case OUTPUT_EVENT.ASSISTANT_MESSAGE:
        this.emitAssistantMessage(event.content);
        break;
      case OUTPUT_EVENT.THINKING:
        this.emitThinking(event.content);
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        this.emitToolCall(event.toolName, event.input, event.toolCallId);
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        this.emitToolResult(event.toolName, event.input, event.result);
        break;
      case OUTPUT_EVENT.COMPACTING:
        this.emitCompacting(event.messageCount, event.keepRecent);
        break;
      case OUTPUT_EVENT.COMMAND_RESULT:
        this.emitCommandResult(event.content);
        break;
      case OUTPUT_EVENT.QUESTION:
        this.emitQuestion(event.questions);
        break;
      case OUTPUT_EVENT.STREAMING_CHUNK:
        this.emitStreamingChunk(event.content);
        break;
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        this.emitStreamingReasoningChunk(event.content);
        break;
      case OUTPUT_EVENT.TASK_PROGRESS:
        this.emitTaskProgress(event.activeTasks, event.totalTasks);
        break;
      case OUTPUT_EVENT.TOKEN_USAGE:
        this.emitTokenUsage(
          event.promptTokens,
          event.cachedTokens,
          event.completionTokens,
          event.totalTokens,
        );
        break;
    }
  }

  emitUserMessage(content) {
    // User messages are typically echoed back
  }

  emitAssistantMessage(content) {
    process.stdout.write(content);
  }

  emitThinking(content) {
    process.stderr.write(content);
  }

  emitToolCall(toolName, input, toolCallId) {
    // Tool calls are displayed by the agent loop
  }

  emitToolResult(toolName, input, result) {
    // Tool results are displayed by the agent loop
  }

  emitCompacting(messageCount, keepRecent) {
    // Compacting is displayed by the agent loop
  }

  emitCommandResult(content) {
    process.stdout.write(content + "\n");
  }

  emitQuestion(questions) {
    // Questions are handled by the agent loop
  }

  emitStreamingChunk(content) {
    if (this.stream) {
      process.stdout.write(content);
    }
  }

  emitStreamingReasoningChunk(content) {
    if (this.stream) {
      process.stderr.write(content);
    }
  }

  emitTaskProgress(activeTasks, totalTasks) {
    // Task progress is displayed by the agent loop
  }

  emitTokenUsage(promptTokens, cachedTokens, completionTokens, totalTokens) {
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
