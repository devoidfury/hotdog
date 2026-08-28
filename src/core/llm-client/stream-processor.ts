// Used by Agent to decouple stream processing from the main run loop.

import crypto from "node:crypto";
import { LlmError } from "../error.ts";
import { logger } from "../logger.ts";
import type { StreamEvent } from "./client.ts";
import { ToolCall } from "../context/message.ts";
import type { RawUsage } from "../token-tracker.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StreamResult {
  fullText: string;
  fullReasoning: string | null;
  finalToolCalls: ToolCall[] | null;
  usage: RawUsage | null;
  finishReason: string | null;
}

export interface StreamCallbacks {
  onChunk?: (content: string) => void;
  onReasoning?: (content: string) => void;
  onToolCalls?: (toolCalls: ToolCall[] | null) => void;
  onUsage?: (usage: RawUsage) => void;
  onFinish?: (reason: string | null) => void;

  /** Called to check if processing should be cancelled. Return true to abort the stream. */
  shouldCancel?(): boolean;
}

// ── StreamProcessor ──────────────────────────────────────────────────────────

/**
 * Stateless between calls to process() except for the partial streaming
 * content tracking, which is reset at the start of each process() call.
 */
export class StreamProcessor {
  // Accumulated partial content of the currently streaming response.
  // Populated during process() so reconnecting clients can replay
  // the portion streamed before they connected.
  #currentStreamingContent: string;
  #currentStreamingReasoning: string;

  constructor() {
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

  get streamingReasoning(): string {
    return this.#currentStreamingReasoning;
  }

  /**
   * Normalizes tool calls to OpenAI format:
   * { id, type: "function", function: { name, arguments } }.
   *
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

    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";

    for await (const event of stream) {
      if (callbacks.shouldCancel && callbacks.shouldCancel()) {
        throw LlmError.Cancelled("Stream cancelled");
      }

      switch (event.type) {
        case "content": {
          textParts.push(event.content);
          this.#currentStreamingContent += event.content;
          if (callbacks.onChunk) {
            callbacks.onChunk(event.content);
          }
          break;
        }

        case "reasoning": {
          reasoningParts.push(event.content);
          this.#currentStreamingReasoning += event.content;
          if (callbacks.onReasoning) {
            callbacks.onReasoning(event.content);
          }
          break;
        }

        case "toolName": {
          toolCallsBuffer.set(event.index, {
            name: event.name,
            args: [],
            id: event.toolCallId || "",
          });
          break;
        }

        case "toolArgument": {
          const existing =
            toolCallsBuffer.get(event.index) || {
              name: "",
              args: [],
              id: "",
            };
          existing.args.push(event.arguments);
          toolCallsBuffer.set(event.index, existing);
          break;
        }

        case "usage": {
          usage = event.data;
          if (callbacks.onUsage) {
            callbacks.onUsage(usage);
          }
          break;
        }

        case "finish": {
          finishReason = event.reason;
          if (callbacks.onFinish) {
            callbacks.onFinish(finishReason);
          }

          if (event.reason === "length") {
            logger.warn(
              `[stream] response truncated — hit max token limit (reason: ${event.reason})`,
            );
          }
          break;
        }
      }
    }

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

export function createStreamProcessor(): StreamProcessor {
  return new StreamProcessor();
}
