// StreamProcessor — processes streaming LLM responses.
//
// Accumulates content, reasoning, and tool calls from stream events,
// normalizes tool calls to OpenAI format, and emits chunks via callbacks.
// Used by Agent to decouple stream processing from the main run loop.

import crypto from "node:crypto";
import { LlmError } from "../error.ts";
import { logger } from "../logger.ts";
import type { StreamEvent } from "./client.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A normalized tool call in OpenAI format.
 */
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * The complete result of processing a stream.
 */
export interface StreamResult {
  fullText: string;
  fullReasoning: string | null;
  finalToolCalls: ToolCall[] | null;
  usage: Record<string, unknown> | null;
  finishReason: string | null;
}

/**
 * Callbacks invoked during stream processing.
 */
export interface StreamCallbacks {
  /** Called with each content chunk. */
  onChunk?: (content: string) => void;

  /** Called with each reasoning chunk. */
  onReasoning?: (content: string) => void;

  /** Called after the stream completes with final tool calls. */
  onToolCalls?: (toolCalls: ToolCall[] | null) => void;

  /** Called with usage data when available. */
  onUsage?: (usage: Record<string, unknown>) => void;

  /** Called when the stream finishes. */
  onFinish?: (reason: string | null) => void;

  /**
   * Called to check if processing should be cancelled.
   * Return true to abort the stream.
   */
  shouldCancel?(): boolean;
}

/**
 * Options for creating a StreamProcessor.
 */
export interface StreamProcessorOptions {
  /** Whether to emit streaming chunk callbacks. */
  stream?: boolean;
}

// ── StreamProcessor ──────────────────────────────────────────────────────────

/**
 * Processes a streaming LLM response.
 *
 * Responsibilities:
 * - Accumulate content, reasoning, and tool calls from stream events
 * - Normalize tool calls to OpenAI format
 * - Emit streaming chunks via callbacks
 * - Track partial content for reconnect replay
 * - Handle cancellation
 * - Log truncation warnings
 *
 * This class is stateless between calls to process() except for the
 * partial streaming content tracking, which is reset at the start of
 * each process() call.
 */
export class StreamProcessor {
  #stream: boolean;

  // Accumulated partial content of the currently streaming response.
  // Populated during process() so reconnecting clients can replay
  // the portion streamed before they connected.
  #currentStreamingContent: string;
  #currentStreamingReasoning: string;

  constructor(options: StreamProcessorOptions = {}) {
    this.#stream = options.stream !== false;
    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";
  }

  /**
   * Get the accumulated partial content of the currently streaming response.
   * Empty string if not currently streaming. Used by reconnecting clients
   * to replay content that was streamed before they connected.
   */
  get streamingContent(): string {
    return this.#currentStreamingContent;
  }

  /**
   * Get the accumulated partial reasoning content of the currently streaming response.
   * Empty string if not currently streaming.
   */
  get streamingReasoning(): string {
    return this.#currentStreamingReasoning;
  }

  /**
   * Process a streaming LLM response.
   *
   * Normalizes tool calls to OpenAI format:
   * { id, type: "function", function: { name, arguments } }.
   *
   * @param stream - The async iterable of stream events from the LLM client.
   * @param callbacks - Callbacks for streaming chunks and events.
   * @returns The complete stream result.
   * @throws LlmError.Cancelled if shouldCancel() returns true.
   */
  async process(
    stream: AsyncIterable<StreamEvent>,
    callbacks: StreamCallbacks = {},
  ): Promise<StreamResult> {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallsBuffer = new Map<
      number,
      { name: string; args: string[]; id: string }
    >();
    let usage: Record<string, unknown> | null = null;
    let finishReason: string | null = null;

    // Reset accumulated partial content for this streaming session
    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";

    for await (const event of stream) {
      // Check cancellation
      if (callbacks.shouldCancel && callbacks.shouldCancel()) {
        throw LlmError.Cancelled("Stream cancelled");
      }

      switch (event.type) {
        case "content": {
          const content = event.content as string;
          textParts.push(content);
          this.#currentStreamingContent += content;
          if (this.#stream && callbacks.onChunk) {
            callbacks.onChunk(content);
          }
          break;
        }

        case "reasoning": {
          const content = event.content as string;
          reasoningParts.push(content);
          this.#currentStreamingReasoning += content;
          if (this.#stream && callbacks.onReasoning) {
            callbacks.onReasoning(content);
          }
          break;
        }

        case "toolName": {
          toolCallsBuffer.set(event.index as number, {
            name: event.name as string,
            args: [],
            id: event.toolCallId || "",
          });
          break;
        }

        case "toolArgument": {
          const existing =
            toolCallsBuffer.get(event.index as number) || {
              name: "",
              args: [],
              id: "",
            };
          existing.args.push(event.arguments as string);
          toolCallsBuffer.set(event.index as number, existing);
          break;
        }

        case "usage": {
          usage = event.data as Record<string, unknown>;
          if (callbacks.onUsage) {
            callbacks.onUsage(usage);
          }
          break;
        }

        case "finish": {
          finishReason = event.reason as string;
          if (callbacks.onFinish) {
            callbacks.onFinish(finishReason);
          }

          // Emit truncation warning if the model hit its token limit
          if (event.reason === "length") {
            logger.warn(
              `[stream] response truncated — hit max token limit (reason: ${event.reason})`,
            );
          }
          break;
        }
      }
    }

    // Build final tool calls from buffer
    let finalToolCalls: ToolCall[] | null = null;
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map((tc) => ({
        id: tc.id || crypto.randomUUID(),
        type: "function",
        function: { name: tc.name, arguments: tc.args.join("") },
      }));
    }

    if (callbacks.onToolCalls) {
      callbacks.onToolCalls(finalToolCalls);
    }

    // Clear partial streaming content — stream is complete
    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";

    return {
      fullText: textParts.join(""),
      fullReasoning:
        reasoningParts.length > 0 ? reasoningParts.join("") : null,
      finalToolCalls,
      usage,
      finishReason,
    };
  }
}

/**
 * Create a new StreamProcessor instance.
 *
 * @param options - Configuration options.
 * @returns A new StreamProcessor.
 */
export function createStreamProcessor(
  options: StreamProcessorOptions = {},
): StreamProcessor {
  return new StreamProcessor(options);
}
