// SSE Parser — pure streaming parser for Server-Sent Events.
//
// Reads from a ReadableStream<Uint8Array>, handles SSE framing (event:, data:, [DONE]),
// reassembles multi-chunk JSON payloads, and yields raw JSON objects.

import { logger } from "../core/logger.ts";

export interface SseParserOptions {
  /** Maximum accumulated JSON buffer size before warning and discarding. */
  maxJsonBuffer?: number;
  /** Optional warning callback for malformed data. Falls back to logger.warn if not provided. */
  onWarning?: (message: string) => void;
}

const DEFAULT_MAX_JSON_BUFFER = 500_000;

/**
 * Parse an SSE stream and yield JSON objects.
 *
 * Handles:
 * - SSE framing (event:, data:, [DONE], blank lines, comments)
 * - Multi-chunk JSON payloads (accumulates until valid JSON)
 * - Buffer overflow protection with warnings
 *
 * @param stream - The ReadableStream to parse (e.g., response.body.getReader().read() chunks)
 * @param options - Parser options
 * @yields Parsed JSON objects from the stream
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: SseParserOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  yield* new SseParser(options).parse(stream);
}

export class SseParser {
  #maxJsonBuffer: number;
  #onWarning: (message: string) => void;

  constructor(options: SseParserOptions = {}) {
    this.#maxJsonBuffer = options.maxJsonBuffer ?? DEFAULT_MAX_JSON_BUFFER;
    this.#onWarning = options.onWarning ?? ((msg: string) => logger.warn(msg));
  }

  /**
   * Parse an SSE stream and yield JSON objects.
   *
   * @param stream - The ReadableStream to parse
   * @yields Parsed JSON objects from the stream
   */
  async *parse(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let jsonBuffer = "";
    let currentEvent = "message";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            // SSE spec: `event:` applies only to the next event; reset at the
            // blank-line event boundary.
            currentEvent = "message";
            continue;
          }
          if (trimmed.startsWith(":")) continue;
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;
          if (currentEvent !== "message" && currentEvent !== "") continue;
          if (trimmed === "data: [DONE]") {
            if (jsonBuffer) {
              try {
                const data = JSON.parse(jsonBuffer);
                yield data;
              } catch {
                this.#onWarning(
                  `[sse] malformed JSON on [DONE] flush (${jsonBuffer.length} chars)`,
                );
              }
              jsonBuffer = "";
            }
            continue;
          }
          const payload = trimmed.slice(6);
          try {
            const data = JSON.parse(payload);
            yield data;
          } catch {
            jsonBuffer += payload;
            try {
              const data = JSON.parse(jsonBuffer);
              yield data;
              jsonBuffer = "";
            } catch {
              if (jsonBuffer.length > this.#maxJsonBuffer) {
                this.#onWarning(
                  `[sse] malformed JSON (${jsonBuffer.length} chars): ${jsonBuffer.slice(0, 100)}...`,
                );
                jsonBuffer = "";
              }
            }
          }
        }
      }

      // Handle any remaining JSON buffer at EOF
      if (jsonBuffer) {
        try {
          const data = JSON.parse(jsonBuffer);
          yield data;
        } catch {
          this.#onWarning(
            `[sse] truncated JSON at EOF (${jsonBuffer.length} chars)`,
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
