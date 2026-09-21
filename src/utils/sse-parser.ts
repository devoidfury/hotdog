import { logger } from "./logger.ts";

export interface SseParserOptions {
  /** Maximum accumulated JSON buffer size before warning and discarding. */
  maxJsonBuffer?: number;
  /** Optional warning callback for malformed data. Falls back to logger.warn if not provided. */
  onWarning?: (message: string) => void;
}

const DEFAULT_MAX_JSON_BUFFER = 500_000;

/** The parser's contract yields JSON objects; scalars/arrays are protocol
 * noise on an SSE stream and must not leak to consumers (WHATWG SSE itself
 * treats data as an opaque string -- the JSON filter is hotdog's contract). */
function isObjectData(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse an SSE stream into JSON objects; reassembles payloads split across chunks. */
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
        // WHATWG HTML 9.2.6: lines end with CRLF, a lone LF, or a lone CR.
        // A CR at the buffer tail is held one read: it may be the first half
        // of a CRLF split across chunks (the split consumes it otherwise).
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = (buffer.endsWith("\r") ? "\r" : "") + (lines.pop() || "");

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
          if (!trimmed.startsWith("data:")) continue;
          if (currentEvent !== "message" && currentEvent !== "") continue;
          // SSE spec: the field value is everything after "data:" with one
          // leading space removed if present, so "data:x" is as valid as
          // "data: x" (a second space is part of the value).
          const payload = trimmed.slice(trimmed[5] === " " ? 6 : 5);
          if (payload === "[DONE]") {
            if (jsonBuffer) {
              try {
                const data = JSON.parse(jsonBuffer);
                if (isObjectData(data)) yield data;
              } catch {
                this.#onWarning(
                  `[sse] malformed JSON on [DONE] flush (${jsonBuffer.length} chars)`,
                );
              }
              jsonBuffer = "";
            }
            continue;
          }
          try {
            const data = JSON.parse(payload);
            if (isObjectData(data)) yield data;
            else
              this.#onWarning(
                `[sse] non-object JSON data payload ignored: ${payload.slice(0, 80)}`,
              );
          } catch {
            jsonBuffer += payload;
            try {
              const data = JSON.parse(jsonBuffer);
              if (isObjectData(data)) yield data;
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

      if (jsonBuffer) {
        try {
          const data = JSON.parse(jsonBuffer);
          if (isObjectData(data)) yield data;
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
