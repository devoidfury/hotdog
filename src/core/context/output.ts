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
} as const;

export type OutputEventType = (typeof OUTPUT_EVENT)[keyof typeof OUTPUT_EVENT];

/**
 * Map output event types to handler method names.
 */
export const EVENT_HANDLERS: Record<OutputEventType, string> = {
  [OUTPUT_EVENT.USER_MESSAGE]: "emitUserMessage",
  [OUTPUT_EVENT.ASSISTANT_MESSAGE]: "emitAssistantMessage",
  [OUTPUT_EVENT.THINKING]: "emitThinking",
  [OUTPUT_EVENT.TOOL_CALL]: "emitToolCall",
  [OUTPUT_EVENT.TOOL_RESULT]: "emitToolResult",
  [OUTPUT_EVENT.COMPACTING]: "emitCompacting",
  [OUTPUT_EVENT.COMMAND_RESULT]: "emitCommandResult",
  [OUTPUT_EVENT.QUESTION]: "emitQuestion",
  [OUTPUT_EVENT.STREAMING_CHUNK]: "emitStreamingChunk",
  [OUTPUT_EVENT.STREAMING_REASONING_CHUNK]: "emitStreamingReasoningChunk",
  [OUTPUT_EVENT.TASK_PROGRESS]: "emitTaskProgress",
  [OUTPUT_EVENT.TOKEN_USAGE]: "emitTokenUsage",
  [OUTPUT_EVENT.COMPACTION_RESULT]: "emitCompactionResult",
  [OUTPUT_EVENT.SESSION_STATE]: "emitSessionState",
};

export interface OutputEvent {
  type: OutputEventType;
  [key: string]: unknown;
}

/**
 * Create an output event.
 */
export function outputEvent(
  type: OutputEventType,
  data: Record<string, unknown> = {},
): OutputEvent {
  return { type, ...data };
}

/**
 * Output trait implementation for CLI.
 * The Agent only depends on this interface, never on a specific UI.
 */
export class OutputSink {
  stream: boolean;

  /**
   * @param options
   * @param options.stream - Enable streaming output
   */
  constructor(options: { stream?: boolean } = {}) {
    this.stream = options.stream !== false;
  }

  /**
   * Emit an output event.
   */
  emit(event: OutputEvent): void {
    const handler = EVENT_HANDLERS[event.type];
    const handlerFn = ((this as unknown) as Record<string, (event: OutputEvent) => void>)[handler];
    if (handlerFn) {
      handlerFn(event);
    }
  }

  emitUserMessage(_event: OutputEvent): void {}

  emitAssistantMessage(event: OutputEvent): void {
    process.stdout.write(event.content as string);
  }

  emitThinking(event: OutputEvent): void {
    process.stderr.write(event.content as string);
  }

  emitToolCall(_event: OutputEvent): void {}

  emitToolResult(_event: OutputEvent): void {}

  emitCompacting(_event: OutputEvent): void {}

  emitCompactionResult(_event: OutputEvent): void {}

  emitSessionState(_event: OutputEvent): void {}

  emitCommandResult(event: OutputEvent): void {
    process.stdout.write((event.content as string) + "\n");
  }

  emitQuestion(_event: OutputEvent): void {}

  emitStreamingChunk(event: OutputEvent): void {
    if (this.stream) {
      process.stdout.write(event.content as string);
    }
  }

  emitStreamingReasoningChunk(event: OutputEvent): void {
    if (this.stream) {
      process.stderr.write(event.content as string);
    }
  }

  emitTaskProgress(_event: OutputEvent): void {}

  emitTokenUsage(_event: OutputEvent): void {}

  reset(): void {}
}

/**
 * No-op output sink that silently discards all events.
 */
export class NoopSink {
  emit(_event: OutputEvent): void {}
}
