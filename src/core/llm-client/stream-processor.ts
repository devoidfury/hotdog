// Used by Agent to decouple stream processing from the main run loop.

import crypto from "node:crypto";
import { LlmError } from "../error.ts";
import { logger } from "../logger.ts";
import type { MarkerMangler } from "../marker-mangler.ts";
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
   * Mangler unescaping: stream events carry RAW wire content (the protocol
   * deliberately does not unescape per delta, because a mangler alias is 16
   * random chars that a tokenizer can split across two deltas -- unescaping
   * the halves separately would fossilize the alias). Unescaping therefore
   * happens here, in two places with different guarantees:
   *
   * - Display (onChunk/onReasoning callbacks and the streamingContent /
   *   streamingReasoning replay buffers): each chunk is unescaped
   *   individually, keeping the live UI showing real markers as it does today.
   *   If a split boundary lands mid-alias, the fragments pass through
   *   unescaped and the UI briefly shows a broken alias at the boundary.
   *   Transient and accepted.
   * - Storage (the returned StreamResult): unescaped ONCE on the fully
   *   assembled strings, which always recovers aliases that straddle delta
   *   boundaries. This is the authoritative text that lands in context and
   *   tool arguments.
   *
   * @param mangler - The session's marker mangler (null/undefined disables
   *   unescaping entirely).
   * @throws LlmError.Cancelled if shouldCancel() returns true.
   */
  async process(
    stream: AsyncIterable<StreamEvent>,
    callbacks: StreamCallbacks = {},
    mangler: MarkerMangler | null | undefined = null,
  ): Promise<StreamResult> {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallsBuffer = new Map<
      number,
      { name: string; args: string[]; id: string }
    >();
    let usage: Record<string, unknown> | null = null;
    let finishReason: string | null = null;

    const unescape = (s: string): string =>
      mangler ? (mangler.unescape(s) ?? s) : s;

    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";

    for await (const event of stream) {
      if (callbacks.shouldCancel && callbacks.shouldCancel()) {
        throw LlmError.Cancelled("Stream cancelled");
      }

      switch (event.type) {
        case "content": {
          // Raw chunk for storage; per-chunk unescape is display-only (see
          // process() docs on why the stored string is unescaped once, later).
          textParts.push(event.content);
          const display = unescape(event.content);
          this.#currentStreamingContent += display;
          if (callbacks.onChunk) {
            callbacks.onChunk(display);
          }
          break;
        }

        case "reasoning": {
          reasoningParts.push(event.content);
          const display = unescape(event.content);
          this.#currentStreamingReasoning += display;
          if (callbacks.onReasoning) {
            callbacks.onReasoning(display);
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

        case "reset": {
          // A mid-stream failure is being retried: the request is re-issued
          // from scratch, so the failed attempt's partial output must not
          // leak into the assembled result or the replay buffers (a
          // reconnecting client would replay it as if it were real).
          textParts.length = 0;
          reasoningParts.length = 0;
          toolCallsBuffer.clear();
          usage = null;
          finishReason = null;
          this.#currentStreamingContent = "";
          this.#currentStreamingReasoning = "";
          break;
        }
      }
    }

    // Authoritative unescape: runs ONCE on the fully-assembled strings, so a
    // mangler alias that straddled a delta boundary is recovered. See the
    // process() docs for the display-vs-storage split.
    let finalToolCalls: ToolCall[] | null = null;
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map((tc) => ({
        id: tc.id || crypto.randomUUID(),
        type: "function",
        function: {
          name: unescape(tc.name),
          arguments: unescape(tc.args.join("")),
        },
      }));
    }

    if (callbacks.onToolCalls) {
      callbacks.onToolCalls(finalToolCalls);
    }

    // Clear partial streaming content — stream is complete
    this.#currentStreamingContent = "";
    this.#currentStreamingReasoning = "";

    return {
      fullText: unescape(textParts.join("")),
      fullReasoning:
        reasoningParts.length > 0 ? unescape(reasoningParts.join("")) : null,
      finalToolCalls,
      usage,
      finishReason,
    };
  }
}

export function createStreamProcessor(): StreamProcessor {
  return new StreamProcessor();
}
