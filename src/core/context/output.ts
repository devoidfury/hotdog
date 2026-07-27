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

// ── Discriminated Union: Typed Output Events ────────────────────────────────

export interface UserMessageEvent {
  type: typeof OUTPUT_EVENT.USER_MESSAGE;
  content: string;
}

export interface AssistantMessageEvent {
  type: typeof OUTPUT_EVENT.ASSISTANT_MESSAGE;
  content: string;
}

export interface ThinkingEvent {
  type: typeof OUTPUT_EVENT.THINKING;
  content: string;
}

export interface ToolCallEvent {
  type: typeof OUTPUT_EVENT.TOOL_CALL;
  toolName: string;
  input: string;
  toolCallId: string;
}

export interface ToolResultEvent {
  type: typeof OUTPUT_EVENT.TOOL_RESULT;
  toolName: string;
  input: string;
  result: string;
  toolCallId: string;
  error?: string;
}

export interface CompactingEvent {
  type: typeof OUTPUT_EVENT.COMPACTING;
  message?: string;
}

export interface CommandResultEvent {
  type: typeof OUTPUT_EVENT.COMMAND_RESULT;
  content: string;
}

export interface QuestionEvent {
  type: typeof OUTPUT_EVENT.QUESTION;
  questions: Array<{
    key: string;
    prompt: string;
    options?: string[];
    required?: boolean;
    default?: string;
    allow_other?: boolean;
  }>;
}

export interface StreamingChunkEvent {
  type: typeof OUTPUT_EVENT.STREAMING_CHUNK;
  content: string;
}

export interface StreamingReasoningChunkEvent {
  type: typeof OUTPUT_EVENT.STREAMING_REASONING_CHUNK;
  content: string;
}

export interface TaskProgressEvent {
  type: typeof OUTPUT_EVENT.TASK_PROGRESS;
  taskId: string;
  status: string;
  message?: string;
}

export interface TokenUsageEvent {
  type: typeof OUTPUT_EVENT.TOKEN_USAGE;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  lastPromptTokens: number;
  lastCachedTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
}

export interface CompactionResultEvent {
  type: typeof OUTPUT_EVENT.COMPACTION_RESULT;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: string;
  summary?: string;
}

export interface SessionStateEvent {
  type: typeof OUTPUT_EVENT.SESSION_STATE;
  key: string;
  value: unknown;
  sessionId?: string;
}

/**
 * Discriminated union of all output event types.
 * Enables type-safe event handling via type narrowing on `type`.
 */
export type OutputEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactingEvent
  | CommandResultEvent
  | QuestionEvent
  | StreamingChunkEvent
  | StreamingReasoningChunkEvent
  | TaskProgressEvent
  | TokenUsageEvent
  | CompactionResultEvent
  | SessionStateEvent;

/**
 * Create an output event.
 */
export function outputEvent<T extends OutputEvent>(event: T): T {
  return event;
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
   * Dispatches to the appropriate handler based on event type.
   */
  emit(event: OutputEvent): void {
    switch (event.type) {
      case OUTPUT_EVENT.USER_MESSAGE:
        this.emitUserMessage(event);
        break;
      case OUTPUT_EVENT.ASSISTANT_MESSAGE:
        this.emitAssistantMessage(event);
        break;
      case OUTPUT_EVENT.THINKING:
        this.emitThinking(event);
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        this.emitToolCall(event);
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        this.emitToolResult(event);
        break;
      case OUTPUT_EVENT.COMPACTING:
        this.emitCompacting(event);
        break;
      case OUTPUT_EVENT.COMMAND_RESULT:
        this.emitCommandResult(event);
        break;
      case OUTPUT_EVENT.QUESTION:
        this.emitQuestion(event);
        break;
      case OUTPUT_EVENT.STREAMING_CHUNK:
        this.emitStreamingChunk(event);
        break;
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        this.emitStreamingReasoningChunk(event);
        break;
      case OUTPUT_EVENT.TASK_PROGRESS:
        this.emitTaskProgress(event);
        break;
      case OUTPUT_EVENT.TOKEN_USAGE:
        this.emitTokenUsage(event);
        break;
      case OUTPUT_EVENT.COMPACTION_RESULT:
        this.emitCompactionResult(event);
        break;
      case OUTPUT_EVENT.SESSION_STATE:
        this.emitSessionState(event);
        break;
    }
  }

  emitUserMessage(_event: UserMessageEvent): void {}

  emitAssistantMessage(event: AssistantMessageEvent): void {
    process.stdout.write(event.content);
  }

  emitThinking(event: ThinkingEvent): void {
    process.stderr.write(event.content);
  }

  emitToolCall(_event: ToolCallEvent): void {}

  emitToolResult(_event: ToolResultEvent): void {}

  emitCompacting(_event: CompactingEvent): void {}

  emitCompactionResult(_event: CompactionResultEvent): void {}

  emitSessionState(_event: SessionStateEvent): void {}

  emitCommandResult(event: CommandResultEvent): void {
    process.stdout.write(event.content + "\n");
  }

  emitQuestion(_event: QuestionEvent): void {}

  emitStreamingChunk(event: StreamingChunkEvent): void {
    if (this.stream) {
      process.stdout.write(event.content);
    }
  }

  emitStreamingReasoningChunk(event: StreamingReasoningChunkEvent): void {
    if (this.stream) {
      process.stderr.write(event.content);
    }
  }

  emitTaskProgress(_event: TaskProgressEvent): void {}

  emitTokenUsage(_event: TokenUsageEvent): void {}

  reset(): void {}
}

/**
 * No-op output sink that silently discards all events.
 */
export class NoopSink {
  emit(_event: OutputEvent): void {}
}
